import { getDatabasePool } from "../db/client.js";
import { getPricing } from "../pricing/service.js";
import { AppError } from "../middleware/error-handler.js";
import { createOpaqueToken } from "../auth/tokens.js";
import { evaluatePromotions, validateCoupon } from "../promotions/service.js";
import { assertMinimumOrderQuantity } from "../catalog/moq.js";
import { calculatePayableTotals, centsToMoney, moneyToCents, type TaxMode } from "../commerce/payable-total.js";

export type CartOwner = { userId?: string; guestSessionId?: string };
type CartItemInput = { productId: string; variantId?: string | null; quantity: number };

function ownerWhere(owner: CartOwner): { clause: string; value: string } {
  if (owner.userId) return { clause: "user_id = $1", value: owner.userId };
  if (owner.guestSessionId) return { clause: "guest_session_id = $1", value: owner.guestSessionId };
  throw new AppError(400, "CART_OWNER_REQUIRED", "A cart owner is required.");
}

async function ensureCart(owner: CartOwner) {
  const pool = getDatabasePool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // A user cart and a guest cart can be presented together immediately
    // after sign-in. Serialize this transition per user so two concurrent
    // authenticated requests cannot each claim the same guest lines.
    if (owner.userId) await client.query("SELECT pg_advisory_xact_lock(hashtext('cart-user:' || $1))", [owner.userId]);
    const target = ownerWhere(owner);
    let cart = (await client.query(`SELECT id, user_id AS "userId", guest_session_id AS "guestSessionId", currency, status, applied_coupon_code AS "appliedCouponCode" FROM carts WHERE ${target.clause} AND status = 'active' FOR UPDATE`, [target.value])).rows[0];
    if (!cart) {
      const inserted = await client.query(
        "INSERT INTO carts (user_id, guest_session_id, currency, status) VALUES ($1, $2, 'EUR', 'active') RETURNING id, user_id AS \"userId\", guest_session_id AS \"guestSessionId\", currency, status, applied_coupon_code AS \"appliedCouponCode\"",
        [owner.userId ?? null, owner.userId ? null : owner.guestSessionId ?? null],
      );
      cart = inserted.rows[0];
    }
    if (owner.userId && owner.guestSessionId) {
      const guest = (await client.query("SELECT id FROM carts WHERE guest_session_id = $1 AND status = 'active' AND id <> $2 FOR UPDATE", [owner.guestSessionId, cart.id])).rows[0];
      if (guest) {
        const guestItems = (await client.query("SELECT product_id AS \"productId\", variant_id AS \"variantId\", quantity FROM cart_items WHERE cart_id = $1", [guest.id])).rows;
        for (const item of guestItems) {
          const existing = (await client.query("SELECT id FROM cart_items WHERE cart_id = $1 AND product_id = $2 AND variant_id IS NOT DISTINCT FROM $3::uuid", [cart.id, item.productId, item.variantId])).rows[0];
          if (existing) await client.query("UPDATE cart_items SET quantity = quantity + $1, updated_at = now() WHERE id = $2", [item.quantity, existing.id]);
          else await client.query("INSERT INTO cart_items (cart_id, product_id, variant_id, quantity) VALUES ($1, $2, $3, $4)", [cart.id, item.productId, item.variantId, item.quantity]);
        }
        // Conversion is the claim marker. Future requests carrying this
        // cookie cannot see or merge this cart again.
        await client.query("UPDATE carts SET status = 'converted', updated_at = now() WHERE id = $1", [guest.id]);
      }
    }
    await client.query("COMMIT");
    return cart as { id: string; userId: string | null; guestSessionId: string | null; currency: string; status: string; appliedCouponCode: string | null };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function assertItem(productId: string, variantId: string | null) {
  const product = await getDatabasePool().query(
    `SELECT p.id AS "productId", p.name AS "productName", p.parent_sku AS "parentSku", p.base_price AS "productBasePrice", p.cost_price AS "productCostPrice", p.vat_rate AS "vatRate",
             p.status AS "productStatus", p.published_at AS "publishedAt", p.minimum_order_quantity AS "productMinimumOrderQuantity",
             pv.id AS "variantId", pv.title AS "variantTitle", pv.sku AS "variantSku", pv.base_price AS "variantBasePrice", pv.cost_price AS "variantCostPrice", pv.minimum_order_quantity AS "variantMinimumOrderQuantity", pv.active AS "variantActive"
       FROM products p
       LEFT JOIN categories c ON c.id=p.category_id
       LEFT JOIN categories parent ON parent.id=c.parent_id
       LEFT JOIN product_variants pv ON pv.product_id = p.id AND pv.id IS NOT DISTINCT FROM $2::uuid
      WHERE p.id = $1
        AND c.active=true AND (c.parent_id IS NULL OR EXISTS (SELECT 1 FROM categories parent WHERE parent.id=c.parent_id AND parent.active=true))`,
    [productId, variantId],
  );
  const row = product.rows[0];
  if (!row) throw new AppError(404, "PRODUCT_NOT_FOUND", "The product was not found.");
  if (row.productStatus !== "active" || !row.publishedAt || (variantId && (!row.variantId || !row.variantActive))) throw new AppError(409, "ITEM_NOT_SELLABLE", "This product is not currently available.");
  return {
    ...row,
    minimumOrderQuantity: Math.max(1, Number(row.variantMinimumOrderQuantity ?? row.productMinimumOrderQuantity)),
  };
}

export async function addItem(owner: CartOwner, input: CartItemInput) {
  if (!Number.isInteger(input.quantity) || input.quantity < 1) throw new AppError(400, "INVALID_QUANTITY", "Quantity must be a whole number of at least 1.");
  const minimum = await assertItem(input.productId, input.variantId ?? null);
  const cart = await ensureCart(owner);
  const price = await getPricing(input.productId, input.variantId ?? null, input.quantity);
  const existing = await getDatabasePool().query("SELECT id FROM cart_items WHERE cart_id = $1 AND product_id = $2 AND variant_id IS NOT DISTINCT FROM $3::uuid", [cart.id, input.productId, input.variantId ?? null]);
  if (existing.rows[0]) {
    const current = await getDatabasePool().query<{ quantity: number }>("SELECT quantity FROM cart_items WHERE id = $1", [existing.rows[0].id]);
    const nextQuantity = Number(current.rows[0]?.quantity ?? 0) + input.quantity;
    assertMinimumOrderQuantity(nextQuantity, {
      productId: input.productId,
      variantId: input.variantId ?? null,
      minimumOrderQuantity: minimum.minimumOrderQuantity,
    });
    const nextPrice = await getPricing(input.productId, input.variantId ?? null, nextQuantity);
    await getDatabasePool().query("UPDATE cart_items SET quantity = $1, last_quoted_unit_price = $2, updated_at = now() WHERE id = $3", [nextQuantity, nextPrice.unitPrice.toFixed(2), existing.rows[0].id]);
  } else {
    assertMinimumOrderQuantity(input.quantity, {
      productId: input.productId,
      variantId: input.variantId ?? null,
      minimumOrderQuantity: minimum.minimumOrderQuantity,
    });
    await getDatabasePool().query("INSERT INTO cart_items (cart_id, product_id, variant_id, quantity, last_quoted_unit_price) VALUES ($1, $2, $3, $4, $5)", [cart.id, input.productId, input.variantId ?? null, input.quantity, price.unitPrice.toFixed(2)]);
  }
  return getCart(owner);
}

export async function updateItem(owner: CartOwner, itemId: string, quantity: number) {
  if (!Number.isInteger(quantity) || quantity < 1) throw new AppError(400, "INVALID_QUANTITY", "Quantity must be a whole number of at least 1.");
  const cart = await ensureCart(owner);
  const item = (await getDatabasePool().query("SELECT product_id AS \"productId\", variant_id AS \"variantId\" FROM cart_items WHERE id = $1 AND cart_id = $2", [itemId, cart.id])).rows[0];
  if (!item) throw new AppError(404, "CART_ITEM_NOT_FOUND", "The cart item was not found.");
  const itemInfo = await assertItem(item.productId, item.variantId);
  assertMinimumOrderQuantity(quantity, {
    productId: item.productId,
    variantId: item.variantId,
    minimumOrderQuantity: itemInfo.minimumOrderQuantity,
  });
  const price = await getPricing(item.productId, item.variantId, quantity);
  await getDatabasePool().query("UPDATE cart_items SET quantity = $1, last_quoted_unit_price = $2, updated_at = now() WHERE id = $3", [quantity, price.unitPrice.toFixed(2), itemId]);
  return getCart(owner);
}

export async function removeItem(owner: CartOwner, itemId: string) {
  const cart = await ensureCart(owner);
  const result = await getDatabasePool().query("DELETE FROM cart_items WHERE id = $1 AND cart_id = $2", [itemId, cart.id]);
  if (!result.rowCount) throw new AppError(404, "CART_ITEM_NOT_FOUND", "The cart item was not found.");
  return getCart(owner);
}

export async function clearCart(owner: CartOwner) {
  const cart = await ensureCart(owner);
  await getDatabasePool().query("DELETE FROM cart_items WHERE cart_id = $1", [cart.id]);
  return getCart(owner);
}

export async function getCart(owner: CartOwner) {
  const cart = await ensureCart(owner);
  const pool = getDatabasePool();
  const items = (await pool.query(
    `SELECT ci.id, ci.product_id AS "productId", ci.variant_id AS "variantId", ci.quantity, ci.last_quoted_unit_price AS "lastQuotedUnitPrice",
             p.name AS "productName", p.parent_sku AS "parentSku", p.base_price AS "productBasePrice", p.cost_price AS "productCostPrice", p.vat_rate AS "vatRate", p.tax_mode AS "taxMode", p.vat_classified_at AS "vatClassifiedAt",
             p.category_id AS "categoryId", p.brand_id AS "brandId", p.status AS "productStatus", p.published_at AS "publishedAt", p.weight AS "productWeight",
            c.active AS "categoryActive", c.parent_id AS "categoryParentId", parent.active AS "parentActive",
             pv.title AS "variantTitle", pv.sku AS "variantSku", pv.base_price AS "variantBasePrice", pv.cost_price AS "variantCostPrice", pv.weight AS "variantWeight", pv.active AS "variantActive",
             p.minimum_order_quantity AS "productMinimumOrderQuantity", pv.minimum_order_quantity AS "variantMinimumOrderQuantity"
       FROM cart_items ci JOIN products p ON p.id = ci.product_id
       LEFT JOIN categories c ON c.id=p.category_id
       LEFT JOIN categories parent ON parent.id=c.parent_id
       LEFT JOIN product_variants pv ON pv.id = ci.variant_id
      WHERE ci.cart_id = $1 ORDER BY ci.created_at, ci.id`,
    [cart.id],
  )).rows;
  const variantIds = items.filter((item) => item.variantId).map((item) => item.variantId);
  const productIds = items.map((item) => item.productId);
  const stock = await pool.query(
    `SELECT variant_id AS "variantId", product_id AS "productId", COALESCE(sum(quantity_on_hand - quantity_reserved), 0)::text AS available
       FROM inventory
       WHERE active=true AND (variant_id = ANY($1::uuid[]) OR (variant_id IS NULL AND product_id = ANY($2::uuid[])))
      GROUP BY variant_id, product_id`,
    [variantIds, productIds],
  );
  const stockMap = new Map(stock.rows.map((row) => [`${row.variantId ?? "product"}:${row.variantId ?? row.productId}`, Number(row.available)]));
   let totalWeightKg = 0;
   const rendered = await Promise.all(items.map(async (item) => {
       const price = await getPricing(item.productId, item.variantId, Number(item.quantity));
       const minimumOrderQuantity = Math.max(1, Number(item.variantMinimumOrderQuantity ?? item.productMinimumOrderQuantity));
       const quantityValid = Number(item.quantity) >= minimumOrderQuantity;
       const weightKg = Number(item.variantId ? item.variantWeight ?? 0 : item.productWeight);
       totalWeightKg += weightKg * Number(item.quantity);
    const categoryVisible = item.categoryActive === true && (!item.categoryParentId || item.parentActive === true);
    const available = item.productStatus === "active" && item.publishedAt && categoryVisible ? stockMap.get(`${item.variantId ?? "product"}:${item.variantId ?? item.productId}`) ?? 0 : 0;
    const vatRate = Number(item.vatRate);
    const lineTotal = price.totalPrice;
    const changed = item.lastQuotedUnitPrice !== null && Number(item.lastQuotedUnitPrice) !== price.unitPrice;
    await pool.query("UPDATE cart_items SET last_quoted_unit_price = $1, updated_at = now() WHERE id = $2", [price.unitPrice.toFixed(2), item.id]);
    return {
      id: item.id, productId: item.productId, variantId: item.variantId, productName: item.productName, variantTitle: item.variantTitle,
       sku: item.variantSku ?? item.parentSku, quantity: Number(item.quantity), unitPrice: price.unitPrice, lineTotal,
       minimumOrderQuantity, quantityValid, weightKg,
      applicableTier: price.source, nextTier: price.nextTier ?? null, priceChanged: changed,
      previousUnitPrice: changed ? Number(item.lastQuotedUnitPrice) : null, available, categoryVisible,
      availability: available <= 0 ? "unavailable" : available < Number(item.quantity) ? "low_stock" : "available",
       taxIncluded: 0, vatRate, taxMode: item.taxMode as TaxMode, vatClassifiedAt: item.vatClassifiedAt, categoryId: item.categoryId, brandId: item.brandId,
    };
  }));
  const promotion = await evaluatePromotions(rendered.filter((item) => item.categoryVisible).map((item) => ({ key: item.id, productId: item.productId, categoryId: item.categoryId, brandId: item.brandId, quantity: item.quantity, lineTotal: item.lineTotal })), cart.appliedCouponCode, owner, pool);
  const withPromotions = rendered.map((item) => {
    const adjustment = promotion.lines[item.id];
    const baseLineTotal = item.categoryVisible ? item.lineTotal : 0;
    const promotionDiscount = Math.min(baseLineTotal, adjustment?.discount ?? 0);
    const finalLineTotal = Number((baseLineTotal - promotionDiscount).toFixed(2));
    return { ...item, baseLineTotal, promotionDiscount, promotionName: adjustment?.promotionName ?? null, finalUnitPrice: Number((finalLineTotal / item.quantity).toFixed(2)), lineTotal: finalLineTotal };
  });
  const payable = calculatePayableTotals({
    lines: withPromotions.map((item) => ({
      key: item.id,
      merchandiseCents: moneyToCents(item.lineTotal),
      vatRate: item.vatRate,
      taxMode: item.taxMode,
      vatClassifiedAt: item.vatClassifiedAt,
    })),
    shippingCents: 0,
  });
  const taxByLine = new Map(payable.lines.map((line) => [line.key, line.taxCents]));
  const finalized = withPromotions.map((item) => ({ ...item, taxIncluded: centsToMoney(taxByLine.get(item.id) ?? 0) }));
  const subtotal = Number(finalized.reduce((sum, item) => sum + item.baseLineTotal, 0).toFixed(2));
  const discountTotal = Number(finalized.reduce((sum, item) => sum + item.promotionDiscount, 0).toFixed(2));
  const taxTotal = centsToMoney(payable.taxCents);
  const shippingTotal = 0;
  const grandTotal = centsToMoney(payable.payableTotalCents);
   return {
      id: cart.id, currency: cart.currency, items: finalized, promotions: promotion.promotions,
     appliedCouponCode: cart.appliedCouponCode, couponError: promotion.couponError,
     freeShippingEligible: promotion.shippingDiscount > 0,
     totals: { subtotal, discountTotal, shippingTotal, taxTotal, grandTotal, weightKg: Number(totalWeightKg.toFixed(3)) },
      hasUnavailableItems: finalized.some((item) => item.availability !== "available"),
      hasPriceChanges: finalized.some((item) => item.priceChanged),
      hasMinimumQuantityViolations: finalized.some((item) => !item.quantityValid),
      validationErrors: finalized
       .filter((item) => !item.quantityValid)
       .map((item) => ({
         code: "MINIMUM_ORDER_QUANTITY_NOT_MET",
         itemId: item.id,
         productId: item.productId,
         variantId: item.variantId,
         requiredMinimum: item.minimumOrderQuantity,
         minimumOrderQuantity: item.minimumOrderQuantity,
       })),
   };
}

export async function applyCoupon(owner: CartOwner, code: string) {
  const cart = await ensureCart(owner);
  const current = await getCart(owner);
  await validateCoupon(code, current.items
    .filter((item: any) => item.categoryVisible && item.availability === "available")
    .map((item: any) => ({ key: item.id, productId: item.productId, categoryId: item.categoryId, brandId: item.brandId, quantity: item.quantity, lineTotal: item.baseLineTotal })), owner);
  const normalized = code.trim().toUpperCase();
  await getDatabasePool().query("UPDATE carts SET applied_coupon_code=$1,updated_at=now() WHERE id=$2", [normalized, cart.id]);
  return getCart(owner);
}

export async function removeCoupon(owner: CartOwner) {
  const cart = await ensureCart(owner);
  await getDatabasePool().query("UPDATE carts SET applied_coupon_code=NULL,updated_at=now() WHERE id=$1", [cart.id]);
  return getCart(owner);
}

export async function getOrCreateGuestSession(): Promise<string> {
  return createOpaqueToken();
}