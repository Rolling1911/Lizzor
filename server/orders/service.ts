import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { getDatabasePool } from "../db/client.js";
import { AppError } from "../middleware/error-handler.js";
import { hashOpaqueToken } from "../auth/tokens.js";
import { getPricing } from "../pricing/service.js";
import { assertMerchandisePriceFloor } from "../pricing/floor.js";
import type { CartOwner } from "../cart/service.js";
import { env } from "../config/env.js";
import { assertTooniesProcurementEnabled } from "../suppliers/toonies-procurement-gate.js";
import { assertTooniesSettlementMutationAllowed } from "../suppliers/toonies-settlement-service.js";
import { acquireFinancialOperation, transitionFinancialOperation, pauseAfterFinancialOperationReservation } from "../financial/operation-reservation.js";
import { quoteShipping } from "../fulfillment/service.js";
import { evaluatePromotions, releasePromotionUsages } from "../promotions/service.js";
import { emitAdminNotification, emitNotification } from "../notifications/service.js";
import { assertLegalAcceptance, legalRequirements } from "../legal/requirements.js";
import { assertMinimumOrderQuantity } from "../catalog/moq.js";
import { getSupplierShippingProvider } from "../shipping/supplier-provider.js";
import {
  calculatePayableTotals,
  centsToMoney as fromCents,
  moneyToCents as moneyCents,
  payableTotalFingerprint,
  type TaxMode,
} from "../commerce/payable-total.js";

export interface AddressSnapshot {
  firstName: string;
  lastName: string;
  companyName?: string | null;
  addressLine1: string;
  addressLine2?: string | null;
  city: string;
  postalCode: string;
  region?: string | null;
  countryCode: string;
  phone?: string | null;
}

export interface CheckoutInput {
  email: string;
  phone?: string | null;
  billingAddress: AddressSnapshot;
  shippingAddress: AddressSnapshot;
  idempotencyKey: string;
  expectedGrandTotal?: number;
  purchaseScope?: "b2c" | "b2b";
  legalAcceptance?: string[];
}

export type Access = { userId?: string; guestSessionId?: string; guestAccessToken?: string };

function idempotencyHash(owner: CartOwner, key: string): string {
  if (!key || key.length > 160) throw new AppError(400, "INVALID_IDEMPOTENCY_KEY", "A valid checkout idempotency key is required.");
  return createHash("sha256").update(`${owner.userId ?? owner.guestSessionId}:${key}`).digest("hex");
}

/** Deterministic capability: plaintext is returned only to the matching guest browser. */
function guestOrderCapability(guestSessionId: string, orderId: string): string {
  if (!env.SESSION_SECRET) throw new AppError(500, "SESSION_SECRET_REQUIRED", "Guest order access is temporarily unavailable.");
  return createHmac("sha256", env.SESSION_SECRET)
    .update(`lizzor:guest-order-capability:v1\u0000${guestSessionId}\u0000${orderId}`)
    .digest("base64url");
}

function replayGuestCapability(owner: CartOwner, order: { id: string; guestSessionId?: string | null; guestAccessTokenHash?: string | null }): string | undefined {
  if (!owner.guestSessionId || !order.guestSessionId || owner.guestSessionId !== order.guestSessionId || !order.guestAccessTokenHash || !env.SESSION_SECRET) return undefined;
  const capability = guestOrderCapability(owner.guestSessionId, order.id);
  const expected = Buffer.from(order.guestAccessTokenHash);
  const actual = Buffer.from(hashOpaqueToken(capability));
  return expected.length === actual.length && timingSafeEqual(expected, actual) ? capability : undefined;
}

function checkoutFingerprint(input: CheckoutInput): string {
  // Deliberately exclude the idempotency key itself.  These are the customer-
  // supplied facts that determine the request; current cart/pricing facts are
  // authoritatively read and locked below.
  const address = (value: AddressSnapshot) => ({
    firstName: value.firstName.trim(), lastName: value.lastName.trim(),
    companyName: value.companyName?.trim() || null, addressLine1: value.addressLine1.trim(),
    addressLine2: value.addressLine2?.trim() || null, city: value.city.trim(),
    postalCode: value.postalCode.trim(), region: value.region?.trim() || null,
    countryCode: value.countryCode.trim().toUpperCase(), phone: value.phone?.trim() || null,
  });
  return createHash("sha256").update(JSON.stringify({
    email: input.email.trim().toLowerCase(),
    phone: input.phone?.trim() || null,
    billingAddress: address(input.billingAddress),
    shippingAddress: address(input.shippingAddress),
    purchaseScope: input.purchaseScope,
    expectedGrandTotalCents: input.expectedGrandTotal === undefined ? null : moneyCents(input.expectedGrandTotal),
  })).digest("hex");
}

function cartFingerprint(couponCode: string | null | undefined, lines: Array<{ productId: string; variantId?: string | null; quantity: number; unitPrice: number; lineTotal: number; vatRate?: number; taxMode: TaxMode; vatClassifiedAt?: Date | string | null }>): string {
  return createHash("sha256").update(JSON.stringify({
    couponCode: couponCode?.trim().toUpperCase() || null,
    lines: lines.map((line) => ({
      productId: line.productId, variantId: line.variantId ?? null, quantity: Number(line.quantity),
      unitPriceCents: moneyCents(line.unitPrice), lineTotalCents: moneyCents(line.lineTotal),
      vatRate: line.vatRate === undefined ? null : Number(line.vatRate),
       taxMode: line.taxMode,
       vatClassifiedAt: line.vatClassifiedAt ? new Date(line.vatClassifiedAt).toISOString() : null,
    })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  })).digest("hex");
}

async function currentCartFingerprint(owner: CartOwner, client: any): Promise<string | null> {
  const ownerColumn = owner.userId ? "user_id" : "guest_session_id";
  const ownerValue = owner.userId ?? owner.guestSessionId;
  if (!ownerValue) return null;
  const cart = (await client.query(`SELECT id,applied_coupon_code AS "appliedCouponCode" FROM carts WHERE ${ownerColumn}=$1 AND status='active'`, [ownerValue])).rows[0];
  if (!cart) return null;
  const lines = (await client.query(
    `SELECT ci.product_id AS "productId",ci.variant_id AS "variantId",ci.quantity,p.vat_rate AS "vatRate",p.tax_mode AS "taxMode",p.vat_classified_at AS "vatClassifiedAt"
       FROM cart_items ci JOIN products p ON p.id=ci.product_id
       JOIN categories c ON c.id=p.category_id
      WHERE ci.cart_id=$1 AND c.active=true
        AND (c.parent_id IS NULL OR EXISTS (SELECT 1 FROM categories parent WHERE parent.id=c.parent_id AND parent.active=true))
      ORDER BY ci.id`,
    [cart.id],
  )).rows;
  if (!lines.length) return null;
  const priced = await Promise.all(lines.map(async (line: any) => {
    const price = await getPricing(line.productId, line.variantId, Number(line.quantity), client);
    return { ...line, quantity: Number(line.quantity), unitPrice: price.unitPrice, lineTotal: price.totalPrice, vatRate: Number(line.vatRate), taxMode: line.taxMode as TaxMode };
  }));
  return cartFingerprint(cart.appliedCouponCode, priced);
}

function assertReplayFingerprints(prior: any, requestFingerprint: string, currentFingerprint: string | null) {
  if (prior.checkoutRequestFingerprint && prior.checkoutRequestFingerprint !== requestFingerprint) {
    throw new AppError(409, "IDEMPOTENCY_KEY_REUSED", "This checkout idempotency key was already used with different request details.");
  }
  if (currentFingerprint && prior.checkoutCartFingerprint && prior.checkoutCartFingerprint !== currentFingerprint) {
    throw new AppError(409, "IDEMPOTENCY_KEY_REUSED", "This checkout idempotency key was already used with different cart details.");
  }
}

function serializeOrder(row: any, items: any[] = [], reservations: any[] = []) {
  return {
    id: row.id, orderNumber: row.orderNumber, createdAt: row.createdAt, status: row.status, paymentStatus: row.paymentStatus, fulfillmentStage: row.fulfillmentStage,
    fulfillmentStatus: row.fulfillmentStatus, currency: row.currency, subtotal: Number(row.subtotal), discountTotal: Number(row.discountTotal),
    shippingTotal: Number(row.shippingTotal), taxTotal: Number(row.taxTotal), grandTotal: Number(row.grandTotal), totalFingerprint: row.totalFingerprint ?? null,
    shippingSnapshot: row.shippingRuleId || row.shippingProvider || row.shippingQuotedTotal != null
      ? {
          ruleId: row.shippingRuleId ?? null,
          provider: row.shippingProvider ?? null,
          source: row.shippingSource ?? null,
          authoritativeWeightKg: row.shippingWeightKg === null ? null : Number(row.shippingWeightKg),
          quotedAmount: row.shippingQuotedTotal === null ? null : Number(row.shippingQuotedTotal),
          chargedAmount: row.shippingChargedTotal === null ? null : Number(row.shippingChargedTotal),
          minDeliveryDays: row.shippingMinDeliveryDays === null ? null : Number(row.shippingMinDeliveryDays),
          maxDeliveryDays: row.shippingMaxDeliveryDays === null ? null : Number(row.shippingMaxDeliveryDays),
        }
      : null,
    billingAddress: row.billingAddressSnapshot, shippingAddress: row.shippingAddressSnapshot, promotionSnapshot: row.promotionSnapshot ?? null, reservationExpiresAt: row.reservationExpiresAt,
    customer: row.guestEmail ? { type: "guest", email: row.guestEmail } : { type: row.companyId ? "business" : "personal", email: row.userEmail, name: [row.firstName, row.lastName].filter(Boolean).join(" "), companyName: row.companyName },
    items: items.map((item) => ({ id: item.id, productId: item.productId, variantId: item.variantId, sku: item.skuSnapshot, productName: item.productNameSnapshot, variantName: item.variantNameSnapshot, quantity: Number(item.quantity), unitPrice: Number(item.unitPrice), taxRate: Number(item.taxRateSnapshot), taxMode: item.taxModeSnapshot, vatClassifiedAt: item.vatClassifiedAtSnapshot ?? null, lineTotal: Number(item.lineTotal), promotionSnapshot: item.promotionSnapshot ?? null })),
    reservations: reservations.map((item) => ({ id: item.id, quantity: Number(item.quantity), status: item.status })),
  };
}

async function orderById(client: any, id: string) {
  const order = (await client.query(`SELECT o.id, o.order_number AS "orderNumber", o.user_id AS "userId", o.company_id AS "companyId", o.guest_email AS "guestEmail", u.email AS "userEmail", u.first_name AS "firstName", u.last_name AS "lastName", c.company_name AS "companyName", o.status, o.payment_status AS "paymentStatus", o.fulfillment_status AS "fulfillmentStatus", o.fulfillment_stage AS "fulfillmentStage", o.currency, o.subtotal, o.discount_total AS "discountTotal", o.shipping_total AS "shippingTotal", o.shipping_rule_id AS "shippingRuleId", o.shipping_provider AS "shippingProvider", o.shipping_source AS "shippingSource", o.shipping_weight_kg AS "shippingWeightKg", o.shipping_quoted_total AS "shippingQuotedTotal", o.shipping_charged_total AS "shippingChargedTotal", o.shipping_min_delivery_days AS "shippingMinDeliveryDays", o.shipping_max_delivery_days AS "shippingMaxDeliveryDays", o.tax_total AS "taxTotal", o.grand_total AS "grandTotal", o.total_fingerprint AS "totalFingerprint", o.billing_address_snapshot AS "billingAddressSnapshot", o.shipping_address_snapshot AS "shippingAddressSnapshot", o.promotion_snapshot AS "promotionSnapshot", o.reservation_expires_at AS "reservationExpiresAt", o.created_at AS "createdAt" FROM orders o LEFT JOIN users u ON u.id=o.user_id LEFT JOIN companies c ON c.id=o.company_id WHERE o.id = $1`, [id])).rows[0];
  if (!order) throw new AppError(404, "ORDER_NOT_FOUND", "The order was not found.");
  const items = (await client.query(`SELECT id, product_id AS "productId", variant_id AS "variantId", sku_snapshot AS "skuSnapshot", product_name_snapshot AS "productNameSnapshot", variant_name_snapshot AS "variantNameSnapshot", quantity, unit_price AS "unitPrice", tax_rate_snapshot AS "taxRateSnapshot", tax_mode_snapshot AS "taxModeSnapshot", vat_classified_at_snapshot AS "vatClassifiedAtSnapshot", line_total AS "lineTotal", promotion_snapshot AS "promotionSnapshot" FROM order_items WHERE order_id = $1 ORDER BY created_at, id`, [id])).rows;
  const reservations = (await client.query(`SELECT id, quantity, status FROM inventory_reservations WHERE order_id = $1 ORDER BY created_at, id`, [id])).rows;
  const serialized = serializeOrder(order, items, reservations);
  const paymentRows = (await client.query(`SELECT id, provider, status, amount, currency, payment_method_type AS "paymentMethodType", failure_reason AS "failureReason", paid_at AS "paidAt", created_at AS "createdAt" FROM payments WHERE order_id=$1 ORDER BY created_at DESC`, [id])).rows;
  return { ...serialized, payments: paymentRows.map((payment: any) => ({ ...payment, amount: Number(payment.amount) })) };
}

type ShippingResolution = {
  shippingPrice: number;
  quotedAmount: number;
  ruleId: string | null;
  provider: string | null;
  source: string | null;
  minDeliveryDays: number | null;
  maxDeliveryDays: number | null;
};

async function shippingFor(client: any, countryCode: string, subtotal: number, weight: number, tooniesSupplierId?: string | null): Promise<ShippingResolution> {
  if (tooniesSupplierId) {
    const quote = await getSupplierShippingProvider("toonies_temporary").quote({
      supplierId: tooniesSupplierId,
      countryCode,
      weightKg: weight,
      client,
    });
    if (!quote) throw new AppError(409, "SHIPPING_UNAVAILABLE", "Shipping is currently unavailable for this destination/order.");
    return {
      shippingPrice: quote.amountEur,
      quotedAmount: quote.amountEur,
      ruleId: quote.ruleId,
      provider: quote.provider,
      source: quote.source,
      minDeliveryDays: quote.minDeliveryDays,
      maxDeliveryDays: quote.maxDeliveryDays,
    };
  }
  const quote = await quoteShipping({ countryCode, orderValue: subtotal, weight }, client);
  if (quote.matched) return {
    shippingPrice: quote.shippingPrice,
    quotedAmount: quote.shippingPrice,
    ruleId: quote.ruleId,
    provider: "generic",
    source: "shipping_rule",
    minDeliveryDays: null,
    maxDeliveryDays: null,
  };
  const hasConfiguredRules = Boolean((await client.query("SELECT 1 FROM shipping_rules WHERE active=true LIMIT 1")).rows[0]);
  if (hasConfiguredRules) throw new AppError(409, "SHIPPING_UNAVAILABLE", "Shipping is not available for this destination.");
  return { shippingPrice: quote.shippingPrice, quotedAmount: quote.shippingPrice, ruleId: quote.ruleId, provider: null, source: null, minDeliveryDays: null, maxDeliveryDays: null };
}

type OrderQueryClient = {
  query: (text: string, values?: unknown[]) => Promise<{ rows: any[] }>;
};

function kilogramsToGrams(value: unknown): number {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(String(value ?? "0").trim());
  if (!match) throw new AppError(409, "SHIPPING_UNAVAILABLE", "Shipping is currently unavailable for this destination/order.");
  const fractional = match[2] ?? "";
  if (fractional.length > 3 && /[1-9]/.test(fractional.slice(3))) {
    throw new AppError(409, "SHIPPING_UNAVAILABLE", "Shipping is currently unavailable for this destination/order.");
  }
  const grams = Number(BigInt(match[1]) * 1000n + BigInt((fractional + "000").slice(0, 3)));
  if (!Number.isSafeInteger(grams)) throw new AppError(409, "SHIPPING_UNAVAILABLE", "Shipping is currently unavailable for this destination/order.");
  return grams;
}

async function authoritativeTooniesMapping(
  client: OrderQueryClient,
  productId: string,
  variantId: string | null,
  lock: boolean,
): Promise<{ supplierId: string; supplierProductLinkId: string; weightGrams: number; authoritativeCost: number; supplierCostCny: string | null; supplierCostEur: string; thresholdPercent: string; fxRateSnapshotId?: string | null; fxRateUsed?: string | null; fxSource?: string | null; fxObservedAt?: Date | string | null; catalogueItemId: string; catalogueVariantId: string; productCode: string; skuCode: string } | null> {
  const matches = (await client.query(
    `SELECT l.id AS "supplierProductLinkId",l.supplier_id AS "supplierId",l.catalogue_item_id AS "catalogueItemId",l.catalogue_variant_id AS "catalogueVariantId",
            i.external_product_id AS "productCode",cv.sku_code AS "skuCode",cv.original_amount AS "supplierCostCny",cv.original_currency AS "supplierCostCurrency",cv.fx_rate_snapshot_id AS "fxRateSnapshotId",cv.fx_rate_used AS "fxRateUsed",cv.fx_source AS "fxSource",cv.fx_observed_at AS "fxObservedAt",cv.weight_kg AS "weightKg",
            COALESCE(cv.manual_cost_override_eur,cv.normalized_eur,i.manual_cost_override_eur,i.normalized_eur) AS "supplierCostEur",
            (SELECT r.significant_cost_increase_percent FROM supplier_pricing_rules r WHERE r.supplier_id=l.supplier_id AND r.active=true
              AND COALESCE(cv.manual_cost_override_eur,cv.normalized_eur,i.manual_cost_override_eur,i.normalized_eur) >= r.min_cost_eur
              AND (r.max_cost_eur IS NULL OR COALESCE(cv.manual_cost_override_eur,cv.normalized_eur,i.manual_cost_override_eur,i.normalized_eur) <= r.max_cost_eur)
              ORDER BY r.priority,r.id LIMIT 1)::text AS "thresholdPercent",s.active AS "supplierActive",
            COALESCE(cv.manual_cost_override_eur,cv.normalized_eur,i.manual_cost_override_eur,i.normalized_eur) AS "authoritativeCost"
       FROM supplier_product_links l
       JOIN suppliers s ON s.id=l.supplier_id AND s.slug='toonies'
       JOIN supplier_catalogue_items i ON i.id=l.catalogue_item_id
       JOIN supplier_catalogue_variants cv ON cv.id=l.catalogue_variant_id
      WHERE l.product_id=$1 AND l.variant_id IS NOT DISTINCT FROM $2
      LIMIT 2${lock ? " FOR SHARE OF l,s,i,cv" : ""}`,
    [productId, variantId],
  )).rows;
  if (!matches.length) return null;
  if (matches.length !== 1 || matches[0].supplierActive !== true || !matches[0].catalogueVariantId) {
    throw new AppError(409, "SHIPPING_UNAVAILABLE", "Shipping is currently unavailable for this destination/order.");
  }
  const weightKg = matches[0].weightKg;
  const weightGrams = kilogramsToGrams(weightKg);
  if (weightGrams <= 0) throw new AppError(409, "SHIPPING_UNAVAILABLE", "Shipping is currently unavailable for this destination/order.");
  const authoritativeCost = Number(matches[0].authoritativeCost);
  if (!Number.isFinite(authoritativeCost) || authoritativeCost <= 0) throw new AppError(409, "TOONIES_AUTHORITATIVE_COST_UNAVAILABLE", "The authoritative supplier merchandise cost is unavailable.");
  return { supplierId: matches[0].supplierId, supplierProductLinkId: matches[0].supplierProductLinkId, weightGrams, authoritativeCost, supplierCostCny: String(matches[0].supplierCostCurrency ?? "").toUpperCase() === "CNY" && matches[0].supplierCostCny != null ? String(matches[0].supplierCostCny) : null, supplierCostEur: matches[0].supplierCostEur == null ? "" : String(matches[0].supplierCostEur), thresholdPercent: matches[0].thresholdPercent == null ? "" : String(matches[0].thresholdPercent), fxRateSnapshotId: matches[0].fxRateSnapshotId, fxRateUsed: matches[0].fxRateUsed, fxSource: matches[0].fxSource, fxObservedAt: matches[0].fxObservedAt, catalogueItemId: matches[0].catalogueItemId, catalogueVariantId: matches[0].catalogueVariantId, productCode: matches[0].productCode, skuCode: matches[0].skuCode };
}

export async function validateCheckout(owner: CartOwner, shippingAddress: AddressSnapshot, expectedGrandTotal?: number) {
  const ownerColumn = owner.userId ? "user_id" : "guest_session_id";
  const ownerValue = owner.userId ?? owner.guestSessionId;
  if (!ownerValue) throw new AppError(400, "CART_OWNER_REQUIRED", "A cart owner is required.");
  const pool = getDatabasePool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const cart = (await client.query(`SELECT id, applied_coupon_code AS "appliedCouponCode" FROM carts WHERE ${ownerColumn} = $1 AND status = 'active'`, [ownerValue])).rows[0];
    if (!cart) throw new AppError(409, "CART_EMPTY", "Your cart is empty.");
    const rows = (await client.query(`SELECT ci.id AS "lineKey", ci.product_id AS "productId", ci.variant_id AS "variantId", ci.quantity, p.category_id AS "categoryId", p.brand_id AS "brandId", p.cost_price AS "productCostPrice", p.vat_rate AS "vatRate", p.tax_mode AS "taxMode", p.vat_classified_at AS "vatClassifiedAt", p.status AS "productStatus", p.published_at AS "publishedAt", p.weight AS "productWeight", p.minimum_order_quantity AS "productMinimumOrderQuantity", pv.active AS "variantActive", pv.cost_price AS "variantCostPrice", pv.weight AS "variantWeight", pv.minimum_order_quantity AS "variantMinimumOrderQuantity", c.active AS "categoryActive", c.parent_id AS "categoryParentId", parent.active AS "parentActive"
       FROM cart_items ci JOIN products p ON p.id = ci.product_id
       JOIN categories c ON c.id=p.category_id
       LEFT JOIN categories parent ON parent.id=c.parent_id
       LEFT JOIN product_variants pv ON pv.id = ci.variant_id WHERE ci.cart_id = $1`, [cart.id])).rows;
    if (!rows.length) throw new AppError(409, "CART_EMPTY", "Your cart is empty.");
    let total = 0;
    let weightGrams = 0;
    let tooniesSupplierId: string | null = null;
    for (const row of rows) {
      if (row.productStatus !== "active" || !row.publishedAt || !row.categoryActive || (row.categoryParentId && !row.parentActive) || (row.variantId && !row.variantActive)) throw new AppError(409, "ITEM_NOT_SELLABLE", "One or more cart items are no longer available.");
      assertMinimumOrderQuantity(Number(row.quantity), {
        productId: row.productId,
        variantId: row.variantId,
        minimumOrderQuantity: Math.max(1, Number(row.variantMinimumOrderQuantity ?? row.productMinimumOrderQuantity)),
      });
      row.baseLineTotal = (await getPricing(row.productId, row.variantId, Number(row.quantity), client)).totalPrice;
      total += row.baseLineTotal;
      const tooniesMapping = await authoritativeTooniesMapping(client, row.productId, row.variantId, false);
      if (tooniesMapping) {
           if (!tooniesMapping.supplierCostCny || !tooniesMapping.supplierCostEur || !tooniesMapping.thresholdPercent) {
             throw new AppError(409, "TOONIES_COST_SNAPSHOT_UNAVAILABLE", `${row.productName} cannot be ordered until an exact CNY supplier cost snapshot is available.`);
           }
        row.authoritativeCost = tooniesMapping.authoritativeCost;
           row.tooniesMapping = tooniesMapping;
        if (!row.vatClassifiedAt) throw new AppError(409, "TOONIES_VAT_CLASSIFICATION_REQUIRED", "A cart item requires explicit VAT classification before checkout.");
        const pending = await client.query("SELECT 1 FROM supplier_price_change_reviews WHERE supplier_id=$1 AND product_id=$2 AND variant_id IS NOT DISTINCT FROM $3 AND status IN ('pending','rejected') LIMIT 1", [tooniesMapping.supplierId, row.productId, row.variantId]);
        if (pending.rowCount) throw new AppError(409, "SUPPLIER_PRICE_REVIEW_REQUIRED", "A cart item is offline while a supplier price change is reviewed.");
        tooniesSupplierId = tooniesMapping.supplierId;
        weightGrams += tooniesMapping.weightGrams * Number(row.quantity);
      } else {
        weightGrams += kilogramsToGrams(row.variantId ? row.variantWeight ?? 0 : row.productWeight) * Number(row.quantity);
      }
      const stock = await client.query<{ available: string }>(
        `SELECT COALESCE(sum(quantity_on_hand - quantity_reserved),0)::text AS available FROM inventory WHERE active=true AND ${row.variantId ? "variant_id=$1" : "variant_id IS NULL AND product_id=$1"}`,
        [row.variantId ?? row.productId],
      );
      if (Number(stock.rows[0]?.available ?? 0) < Number(row.quantity)) throw new AppError(409, "INSUFFICIENT_STOCK", "One or more cart items no longer have enough available stock.");
    }
    if (tooniesSupplierId) await assertTooniesProcurementEnabled();
    const subtotalCents = moneyCents(total);
    const subtotal = fromCents(subtotalCents);
    const promotion = await evaluatePromotions(rows.map((row) => ({ key: row.lineKey, productId: row.productId, categoryId: row.categoryId, brandId: row.brandId, quantity: Number(row.quantity), lineTotal: row.baseLineTotal })), cart.appliedCouponCode, owner, client);
    for (const row of rows) {
      const revenue = fromCents(moneyCents(row.baseLineTotal) - moneyCents(promotion.lines[row.lineKey]?.discount ?? 0));
      assertMerchandisePriceFloor({ unitCost: Number(row.authoritativeCost ?? row.variantCostPrice ?? row.productCostPrice), quantity: Number(row.quantity), merchandiseRevenue: revenue, code: "DISCOUNT_BELOW_COST", message: "A discount would reduce merchandise revenue below current cost." });
    }
    const discountTotal = fromCents(moneyCents(promotion.discountTotal));
    const discountedSubtotal = fromCents(subtotalCents - moneyCents(discountTotal));
    const weight = weightGrams / 1000;
    const shipping = await shippingFor(client, shippingAddress.countryCode, discountedSubtotal, weight, tooniesSupplierId);
    const shippingTotal = promotion.shippingDiscount ? 0 : fromCents(moneyCents(shipping.shippingPrice));
    const payable = calculatePayableTotals({
      lines: rows.map((row) => ({
        key: row.lineKey,
        merchandiseCents: moneyCents(row.baseLineTotal) - moneyCents(promotion.lines[row.lineKey]?.discount ?? 0),
        vatRate: row.vatRate,
        taxMode: row.taxMode as TaxMode,
        vatClassifiedAt: row.vatClassifiedAt,
      })),
      shippingCents: moneyCents(shippingTotal),
    });
    const taxTotal = fromCents(payable.taxCents);
    const grandTotal = fromCents(payable.payableTotalCents);
    const shippingSnapshot = {
      ruleId: shipping.ruleId,
      provider: shipping.provider,
      source: shipping.source,
      authoritativeWeightKg: weight,
      quotedAmount: shipping.quotedAmount,
      chargedAmount: shippingTotal,
      minDeliveryDays: shipping.minDeliveryDays,
      maxDeliveryDays: shipping.maxDeliveryDays,
    };
    const result = expectedGrandTotal !== undefined && moneyCents(grandTotal) !== moneyCents(expectedGrandTotal)
      ? { valid: false, priceChanged: true, subtotal, discountTotal, shippingTotal, taxTotal, grandTotal, promotions: promotion.promotions, shippingSnapshot }
      : { valid: true, priceChanged: false, subtotal, discountTotal, shippingTotal, taxTotal, grandTotal, promotions: promotion.promotions, shippingSnapshot };
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function createOrder(owner: CartOwner, input: CheckoutInput) {
  const pool = getDatabasePool();
  const client = await pool.connect();
  const keyHash = idempotencyHash(owner, input.idempotencyKey);
  const requestFingerprint = checkoutFingerprint(input);
  let guestToken: string | undefined;
  try {
    await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
    const prior = (await client.query("SELECT id, guest_session_id AS \"guestSessionId\",guest_access_token_hash AS \"guestAccessTokenHash\",checkout_request_fingerprint AS \"checkoutRequestFingerprint\",checkout_cart_fingerprint AS \"checkoutCartFingerprint\" FROM orders WHERE idempotency_key = $1", [keyHash])).rows[0];
    if (prior) {
      assertReplayFingerprints(prior, requestFingerprint, await currentCartFingerprint(owner, client));
      const existing = await orderById(client, prior.id);
      await client.query("COMMIT");
      return { order: existing, guestAccessToken: replayGuestCapability(owner, prior), replayed: true };
    }
    const ownerColumn = owner.userId ? "user_id" : "guest_session_id";
    const ownerValue = owner.userId ?? owner.guestSessionId;
    if (!ownerValue) throw new AppError(400, "CART_OWNER_REQUIRED", "A cart owner is required.");
    const cart = (await client.query(`SELECT id, applied_coupon_code AS "appliedCouponCode" FROM carts WHERE ${ownerColumn} = $1 AND status = 'active' FOR UPDATE`, [ownerValue])).rows[0];
    if (!cart) throw new AppError(409, "CART_EMPTY", "Your cart is empty.");
    const rows = (await client.query(
      `SELECT ci.product_id AS "productId", ci.variant_id AS "variantId", ci.quantity, p.name AS "productName", p.parent_sku AS "parentSku", p.status AS "productStatus", p.published_at AS "publishedAt",
        p.category_id AS "categoryId", p.brand_id AS "brandId", p.cost_price AS "productCostPrice", p.vat_rate AS "vatRate", p.tax_mode AS "taxMode", p.vat_classified_at AS "vatClassifiedAt", p.weight AS "productWeight", p.minimum_order_quantity AS "productMinimumOrderQuantity", c.active AS "categoryActive", c.parent_id AS "categoryParentId", parent.active AS "parentActive", pv.title AS "variantName", pv.sku AS "variantSku", pv.active AS "variantActive", pv.cost_price AS "variantCostPrice", pv.weight AS "variantWeight", pv.minimum_order_quantity AS "variantMinimumOrderQuantity"
         FROM cart_items ci JOIN products p ON p.id = ci.product_id
         JOIN categories c ON c.id=p.category_id
         LEFT JOIN categories parent ON parent.id=c.parent_id
         LEFT JOIN product_variants pv ON pv.id = ci.variant_id
        WHERE ci.cart_id = $1 ORDER BY ci.created_at, ci.id FOR UPDATE OF ci, p`,
      [cart.id],
    )).rows;
    if (!rows.length) throw new AppError(409, "CART_EMPTY", "Your cart is empty.");
    let subtotalCents = 0;
    let totalWeightGrams = 0;
     let tooniesSupplierId: string | null = null;
    const priced: any[] = [];
    for (const row of rows) {
      if (row.productStatus !== "active" || !row.publishedAt || !row.categoryActive || (row.categoryParentId && !row.parentActive) || (row.variantId && !row.variantActive)) throw new AppError(409, "ITEM_NOT_SELLABLE", `${row.productName} is no longer available.`);
      const quantity = Number(row.quantity);
       assertMinimumOrderQuantity(quantity, {
         productId: row.productId,
         variantId: row.variantId,
         minimumOrderQuantity: Math.max(1, Number(row.variantMinimumOrderQuantity ?? row.productMinimumOrderQuantity)),
       });
      const price = await getPricing(row.productId, row.variantId, quantity, client);
      const lineTotal = fromCents(moneyCents(price.totalPrice));
      const vatRate = Number(row.vatRate);
      subtotalCents += moneyCents(lineTotal);
       const tooniesMapping = await authoritativeTooniesMapping(client, row.productId, row.variantId, true);
       if (tooniesMapping) {
           if (!tooniesMapping.supplierCostCny || !tooniesMapping.supplierCostEur || !tooniesMapping.thresholdPercent) throw new AppError(409, "TOONIES_COST_SNAPSHOT_UNAVAILABLE", `${row.productName} cannot be ordered until an exact CNY supplier cost snapshot is available.`);
          row.authoritativeCost = tooniesMapping.authoritativeCost;
           row.tooniesMapping = tooniesMapping;
          if (!row.vatClassifiedAt) throw new AppError(409, "TOONIES_VAT_CLASSIFICATION_REQUIRED", `${row.productName} requires explicit VAT classification before checkout.`);
          const pending = await client.query("SELECT 1 FROM supplier_price_change_reviews WHERE supplier_id=$1 AND product_id=$2 AND variant_id IS NOT DISTINCT FROM $3 AND status IN ('pending','rejected') LIMIT 1 FOR SHARE", [tooniesMapping.supplierId, row.productId, row.variantId]);
          if (pending.rowCount) throw new AppError(409, "SUPPLIER_PRICE_REVIEW_REQUIRED", `${row.productName} is offline while a supplier price change is reviewed.`);
          tooniesSupplierId = tooniesMapping.supplierId;
          totalWeightGrams += tooniesMapping.weightGrams * quantity;
       } else {
          totalWeightGrams += kilogramsToGrams(row.variantId ? row.variantWeight ?? 0 : row.productWeight) * quantity;
       }
       priced.push({ ...row, quantity, unitPrice: price.unitPrice, lineTotal, costPrice: Number(row.variantCostPrice ?? row.productCostPrice), vatRate, taxMode: row.taxMode as TaxMode });
    }
    if (tooniesSupplierId) await assertTooniesProcurementEnabled();
    const subtotal = fromCents(subtotalCents);
    const lockedCartFingerprint = cartFingerprint(cart.appliedCouponCode, priced);
    await client.query("SELECT id FROM promotion_campaigns WHERE active=true AND archived_at IS NULL FOR UPDATE");
    const promotion = await evaluatePromotions(priced.map((item, index) => ({ key: String(index), productId: item.productId, categoryId: item.categoryId, brandId: item.brandId, quantity: item.quantity, lineTotal: item.lineTotal })), cart.appliedCouponCode, owner, client);
    // The campaign rows were locked immediately before evaluation.  This
    // guarded increment is also a database-enforced last line of defense for
    // global limits; per-customer counts are evaluated while holding the same
    // campaign row lock, so concurrent checkouts cannot both consume a slot.
    for (const applied of promotion.promotions) {
      const consumed = await client.query(
        `UPDATE promotion_campaigns
            SET usage_count=usage_count+1,updated_at=now()
          WHERE id=$1 AND (usage_limit IS NULL OR usage_count < usage_limit)
          RETURNING id`,
        [applied.id],
      );
      if (!consumed.rowCount) throw new AppError(409, "PROMOTION_USAGE_LIMIT_REACHED", "A promotion limit was reached during checkout. Please review your cart.");
    }
    priced.forEach((item, index) => {
      const adjustment = promotion.lines[String(index)];
      item.promotionDiscount = fromCents(Math.min(moneyCents(item.lineTotal), moneyCents(adjustment?.discount ?? 0)));
      const finalLineCents = moneyCents(item.lineTotal) - moneyCents(item.promotionDiscount);
      item.promotionSnapshot = adjustment ? { allocations: adjustment.allocations, baseUnitPrice: item.unitPrice, discountAmount: item.promotionDiscount, finalUnitPrice: fromCents(Math.round(finalLineCents / item.quantity)) } : null;
      item.finalLineTotal = fromCents(finalLineCents);
      assertMerchandisePriceFloor({ unitCost: Number(item.authoritativeCost ?? item.costPrice), quantity: item.quantity, merchandiseRevenue: item.finalLineTotal, code: "DISCOUNT_BELOW_COST", message: `${item.productName} cannot be discounted below its current merchandise cost.` });
    });
    const discountTotal = fromCents(moneyCents(promotion.discountTotal));
    const discountedSubtotal = fromCents(subtotalCents - moneyCents(discountTotal));
     const totalWeight = totalWeightGrams / 1000;
     const shipping = await shippingFor(client, input.shippingAddress.countryCode, discountedSubtotal, totalWeight, tooniesSupplierId);
    const shippingTotal = promotion.shippingDiscount ? 0 : fromCents(moneyCents(shipping.shippingPrice));
    const payable = calculatePayableTotals({
      lines: priced.map((item) => ({
        key: `${item.productId}:${item.variantId ?? "product"}`,
        merchandiseCents: moneyCents(item.finalLineTotal),
        vatRate: item.vatRate,
        taxMode: item.taxMode,
        vatClassifiedAt: item.vatClassifiedAt,
      })),
      shippingCents: moneyCents(shippingTotal),
    });
    const taxTotal = fromCents(payable.taxCents);
    const grandTotal = fromCents(payable.payableTotalCents);
    const totalFingerprint = payableTotalFingerprint({
      currency: "EUR",
      lines: priced.map((item) => ({
        key: `${item.productId}:${item.variantId ?? "product"}`,
        productId: item.productId,
        variantId: item.variantId,
        quantity: item.quantity,
        merchandiseCents: moneyCents(item.finalLineTotal),
        vatRate: item.vatRate,
        taxMode: item.taxMode,
        vatClassifiedAt: item.vatClassifiedAt,
      })),
      shippingCents: moneyCents(shippingTotal),
      payableTotalCents: payable.payableTotalCents,
    });
    if (input.expectedGrandTotal !== undefined && moneyCents(grandTotal) !== moneyCents(input.expectedGrandTotal)) {
      throw new AppError(409, "CHECKOUT_TOTAL_CHANGED", `The order total changed to €${grandTotal.toFixed(2)}. Please review it before placing the order.`);
    }
    let userId: string | null = owner.userId ?? null;
    let companyId: string | null = null;
    let guestEmail: string | null = null;
    let guestSessionId: string | null = null;
    let guestTokenHash: string | null = null;
    if (userId) {
      const account = (await client.query("SELECT account_type AS \"accountType\", email FROM users WHERE id = $1 AND status = 'active'", [userId])).rows[0];
      if (!account) throw new AppError(401, "AUTH_REQUIRED", "Please sign in again.");
      if (account.email.toLowerCase() !== input.email.trim().toLowerCase()) {
        throw new AppError(409, "CHECKOUT_ACCOUNT_EMAIL_MISMATCH", `You are signed in as ${account.email}. Use that account email, or sign out before starting a guest checkout.`);
      }
      // Company attribution is an explicit user choice, never the first
      // membership row. Personal users may also act for a selected company.
      const selected = (await client.query(`SELECT c.id AS "companyId" FROM users u JOIN company_users cu ON cu.company_id=u.active_company_id AND cu.user_id=u.id JOIN companies c ON c.id=cu.company_id WHERE u.id=$1 AND cu.status='active' AND cu.role IN ('owner','admin','buyer') AND c.status='active'`, [userId])).rows[0];
      companyId = selected?.companyId ?? null;
    } else {
      guestEmail = input.email.trim().toLowerCase();
      guestSessionId = owner.guestSessionId ?? null;
    }
    // Contractual acknowledgement is only enforced once the complete, reviewed
    // publication set is active. This keeps unpublished development flows usable.
    // A company order cannot be downgraded by a browser-supplied consumer choice.
    if (!companyId && input.purchaseScope === "b2b") throw new AppError(409, "BUSINESS_ACCOUNT_REQUIRED", "Business checkout requires a signed-in active company.");
    const legalScope = companyId ? "b2b" : "b2c";
    const acceptedPolicies = assertLegalAcceptance(await legalRequirements(client), legalScope, input.legalAcceptance);
    const sequence = (await client.query("SELECT nextval('lizzor_order_number_seq')::text AS value")).rows[0].value;
    const order = (await client.query(
       `INSERT INTO orders (order_number, user_id, company_id, guest_email, guest_session_id, guest_access_token_hash, idempotency_key, checkout_request_fingerprint, checkout_cart_fingerprint, total_fingerprint, purchase_legal_scope, reservation_expires_at, status, payment_status, fulfillment_status, currency, subtotal, discount_total, shipping_total, shipping_rule_id, shipping_provider, shipping_source, shipping_weight_kg, shipping_quoted_total, shipping_charged_total, shipping_min_delivery_days, shipping_max_delivery_days, tax_total, grand_total, billing_address_snapshot, shipping_address_snapshot, promotion_snapshot)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,now() + ($12 || ' minutes')::interval,'pending','pending','unfulfilled','EUR',$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28) RETURNING id`,
         [`LZ-${sequence}`, userId, companyId, guestEmail, guestSessionId, guestTokenHash, keyHash, requestFingerprint, lockedCartFingerprint, totalFingerprint, legalScope, env.CHECKOUT_RESERVATION_MINUTES, subtotal.toFixed(2), discountTotal.toFixed(2), shippingTotal.toFixed(2), shipping.provider === "toonies_temporary" ? shipping.ruleId : null, shipping.provider, shipping.source, totalWeight.toFixed(3), shipping.quotedAmount.toFixed(2), shippingTotal.toFixed(2), shipping.minDeliveryDays, shipping.maxDeliveryDays, taxTotal.toFixed(2), grandTotal.toFixed(2), input.billingAddress, input.shippingAddress, { rule: "after_authoritative_wholesale_price", taxModes: [...new Set(priced.map((item) => item.taxMode))], couponCode: cart.appliedCouponCode, promotions: promotion.promotions, freeShipping: Boolean(promotion.shippingDiscount), shippingQuotedAmount: shipping.quotedAmount, shippingChargedAmount: shippingTotal }],
    )).rows[0];
    if (guestSessionId) {
      guestToken = guestOrderCapability(guestSessionId, order.id);
      guestTokenHash = hashOpaqueToken(guestToken);
      await client.query("UPDATE orders SET guest_access_token_hash=$1 WHERE id=$2", [guestTokenHash, order.id]);
    }
    if (acceptedPolicies.length) {
      await client.query(
        `INSERT INTO legal_policy_acceptances (version_id,user_id,order_id,company_id,source,scope)
         SELECT x.version_id,$1,$2,$3,'checkout',$4 FROM unnest($5::uuid[]) AS x(version_id)`,
        [userId, order.id, companyId, legalScope, acceptedPolicies.map((policy) => policy.versionId)],
      );
    }
    for (const item of priced) {
      await client.query(
        `INSERT INTO order_items (order_id, product_id, variant_id, sku_snapshot, product_name_snapshot, variant_name_snapshot, quantity, unit_price, cost_price_snapshot, tax_rate_snapshot, tax_mode_snapshot, vat_classified_at_snapshot, line_total, promotion_snapshot, supplier_product_link_id, supplier_id, supplier_catalogue_item_id, supplier_catalogue_variant_id, supplier_product_code, supplier_sku_code, supplier_cost_eur, supplier_cost_cny, supplier_cost_provenance, supplier_cost_threshold_percent)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)`,
          [order.id, item.productId, item.variantId, item.variantSku ?? item.parentSku, item.productName, item.variantName, item.quantity, item.promotionSnapshot?.finalUnitPrice ?? item.unitPrice.toFixed(2), item.costPrice.toFixed(2), item.vatRate.toFixed(2), item.taxMode, item.vatClassifiedAt, item.finalLineTotal.toFixed(2), item.promotionSnapshot,
             item.tooniesMapping?.supplierProductLinkId ?? null, item.tooniesMapping?.supplierId ?? null, item.tooniesMapping?.catalogueItemId ?? null, item.tooniesMapping?.catalogueVariantId ?? null,
            item.tooniesMapping?.productCode ?? null, item.tooniesMapping?.skuCode ?? null, item.tooniesMapping?.supplierCostEur ?? null, item.tooniesMapping?.supplierCostCny ?? null,
             item.tooniesMapping ? { source: "checkout_authoritative_catalogue", capturedAt: new Date().toISOString(), fxRateSnapshotId: item.tooniesMapping.fxRateSnapshotId ?? null, fxRateUsed: item.tooniesMapping.fxRateUsed ?? null, fxSource: item.tooniesMapping.fxSource ?? null, fxObservedAt: item.tooniesMapping.fxObservedAt ?? null } : null,
             item.tooniesMapping?.thresholdPercent ?? null],
      );
      const inventory = (await client.query(
        `SELECT id, quantity_on_hand AS "onHand", quantity_reserved AS reserved FROM inventory
          WHERE active=true AND ${item.variantId ? "variant_id = $1" : "variant_id IS NULL AND product_id = $1"}
          ORDER BY id FOR UPDATE`,
        [item.variantId ?? item.productId],
      )).rows;
      let remaining = item.quantity;
      for (const stock of inventory) {
        const available = Number(stock.onHand) - Number(stock.reserved);
        if (available <= 0) continue;
        const allocated = Math.min(available, remaining);
        await client.query("UPDATE inventory SET quantity_reserved = quantity_reserved + $1, updated_at = now() WHERE id = $2", [allocated, stock.id]);
        await client.query("INSERT INTO inventory_reservations (order_id, inventory_id, quantity, status) VALUES ($1,$2,$3,'active')", [order.id, stock.id, allocated]);
        remaining -= allocated;
        if (!remaining) break;
      }
      if (remaining > 0) throw new AppError(409, "INSUFFICIENT_STOCK", `${item.productName} does not have enough stock for this order.`);
    }
    for (const applied of promotion.promotions) {
       await client.query("INSERT INTO promotion_usages (campaign_id,order_id,user_id,guest_session_id,discount_amount) VALUES ($1,$2,$3,$4,$5)", [applied.id, order.id, userId, guestSessionId, applied.discountAmount.toFixed(2)]);
    }
    await client.query("UPDATE carts SET status = 'converted', updated_at = now() WHERE id = $1", [cart.id]);
    await client.query("INSERT INTO audit_logs (actor_user_id, action, entity_type, entity_id, new_values_json) VALUES ($1,'order.created','order',$2,$3)", [userId, order.id, JSON.stringify({ reservations: true, guest: !userId })]);
    await emitNotification({
      type: "order.created", idempotencyKey: `order.created:${order.id}`, userId: userId ?? undefined, email: guestEmail ?? undefined,
      message: `Order LZ-${sequence} has been received.`, metadata: { orderId: order.id, orderNumber: `LZ-${sequence}`, path: `/account/orders/${order.id}` },
    }, client);
    await emitAdminNotification("orders.view", {
      type: "admin.order_created", idempotencyKey: `admin.order_created:${order.id}`,
      message: `Order LZ-${sequence} has been placed and is ready for review.`, metadata: { orderId: order.id, orderNumber: `LZ-${sequence}`, path: `/admin/orders/${order.id}` },
    }, client);
    await client.query("COMMIT");
    const created = await orderById(pool, order.id);
    return { order: created, guestAccessToken: guestToken, replayed: false };
  } catch (error: any) {
    await client.query("ROLLBACK");
    if ((error?.code === "23505" && error?.constraint === "orders_idempotency_key_unique") || error?.code === "40001") {
       const prior = (await pool.query("SELECT id,guest_session_id AS \"guestSessionId\",guest_access_token_hash AS \"guestAccessTokenHash\",checkout_request_fingerprint AS \"checkoutRequestFingerprint\",checkout_cart_fingerprint AS \"checkoutCartFingerprint\" FROM orders WHERE idempotency_key = $1", [keyHash])).rows[0];
       if (prior) {
         assertReplayFingerprints(prior, requestFingerprint, await currentCartFingerprint(owner, pool));
          return { order: await orderById(pool, prior.id), guestAccessToken: replayGuestCapability(owner, prior), replayed: true };
       }
    }
    if (error?.code === "40001") throw new AppError(409, "CHECKOUT_RETRY", "Stock changed during checkout. Please review your cart and try again.");
    throw error;
  } finally {
    client.release();
  }
}

export async function releaseExpiredReservations(limit = 100) {
  const client = await getDatabasePool().connect();
  const released: string[] = [];
  try {
    await client.query("BEGIN");
    const expired = (await client.query(
      `SELECT id,user_id AS "userId",guest_email AS email,order_number AS "orderNumber" FROM orders
        WHERE status='pending' AND payment_status='pending' AND reservation_expires_at <= now()
          AND NOT EXISTS (SELECT 1 FROM payments WHERE payments.order_id=orders.id)
        ORDER BY reservation_expires_at FOR UPDATE SKIP LOCKED LIMIT $1`,
      [Math.min(500, Math.max(1, limit))],
    )).rows;
    for (const order of expired) {
      const reservations = (await client.query("SELECT id,inventory_id AS \"inventoryId\",quantity FROM inventory_reservations WHERE order_id=$1 AND status='active' FOR UPDATE", [order.id])).rows;
      for (const reservation of reservations) {
        const updated = await client.query("UPDATE inventory SET quantity_reserved=quantity_reserved-$1,updated_at=now() WHERE id=$2 AND quantity_reserved >= $1", [reservation.quantity, reservation.inventoryId]);
        if (!updated.rowCount) throw new AppError(409, "RESERVATION_RELEASE_FAILED", "An expired reservation could not be released safely.");
      }
      await client.query("UPDATE inventory_reservations SET status='released',released_at=now() WHERE order_id=$1 AND status='active'", [order.id]);
      await client.query("UPDATE orders SET status='cancelled',fulfillment_status='cancelled',updated_at=now() WHERE id=$1", [order.id]);
      const promotionsReleased = await releasePromotionUsages(client, order.id);
      await client.query("INSERT INTO audit_logs (action,entity_type,entity_id,new_values_json) VALUES ('order.expired','order',$1,$2)", [order.id, JSON.stringify({ reservationsReleased: reservations.length, promotionsReleased })]);
      await emitNotification({ type: "order.cancelled", idempotencyKey: `order.cancelled:${order.id}`, userId: order.userId ?? undefined, email: order.email ?? undefined,
        message: `Order ${order.orderNumber} was cancelled because its checkout reservation expired.`, metadata: { orderId: order.id, orderNumber: order.orderNumber, path: `/account/orders/${order.id}` } }, client);
      released.push(order.id);
    }
    await client.query("COMMIT");
    return { released: released.length, orderIds: released };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function assertOrderAccess(client: any, orderId: string, access: Access, mode: "read" | "mutate" = "read") {
  const order = (await client.query("SELECT id,order_number AS \"orderNumber\",user_id AS \"userId\",guest_email AS email,company_id AS \"companyId\",guest_session_id AS \"guestSessionId\",guest_access_token_hash AS \"guestTokenHash\",status,payment_status AS \"paymentStatus\",fulfillment_status AS \"fulfillmentStatus\" FROM orders WHERE id=$1", [orderId])).rows[0];
  if (!order) throw new AppError(404, "ORDER_NOT_FOUND", "The order was not found.");
  let allowed = Boolean(access.userId && !order.companyId && order.userId === access.userId);
  if (access.userId && order.companyId) {
    const member = (await client.query(
      `SELECT cu.role
         FROM company_users cu
         JOIN companies c ON c.id=cu.company_id
        WHERE cu.user_id=$1 AND cu.company_id=$2
          AND cu.status='active' AND c.status='active'`,
      [access.userId, order.companyId],
    )).rows[0];
    const placedByUser = order.userId === access.userId;
    allowed = Boolean(member && (
      (placedByUser && (mode === "read" || member.role !== "viewer"))
      || ["owner", "admin"].includes(member.role)
    ));
  }
  if (!allowed && access.guestSessionId && order.guestSessionId === access.guestSessionId && access.guestAccessToken) allowed = hashOpaqueToken(access.guestAccessToken) === order.guestTokenHash;
  if (!allowed) throw new AppError(404, "ORDER_NOT_FOUND", "The order was not found.");
  return order;
}

export async function getOrder(orderId: string, access: Access) {
  await assertOrderAccess(getDatabasePool(), orderId, access);
  return orderById(getDatabasePool(), orderId);
}

export async function getGuestEmailOrder(orderId: string, token: string) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new AppError(404, "ORDER_NOT_FOUND", "The order was not found.");
  const client = await getDatabasePool().connect();
  try {
    await client.query("BEGIN");
    const access = (await client.query(
      `SELECT o.id FROM guest_order_email_access_tokens t
         JOIN orders o ON o.id=t.order_id
        WHERE t.order_id=$1 AND t.token_hash=$2 AND t.expires_at>now()
          AND o.guest_email IS NOT NULL AND o.user_id IS NULL
        FOR SHARE OF o`,
      [orderId, hashOpaqueToken(token)],
    )).rows[0];
    if (!access) throw new AppError(404, "ORDER_NOT_FOUND", "The order was not found.");
    const order = await orderById(client, orderId);
    const shipments = await client.query(`SELECT courier,tracking_number AS "trackingNumber",tracking_url AS "trackingUrl",status,
      shipped_at AS "shippedAt",delivered_at AS "deliveredAt",created_at AS "createdAt"
      FROM shipments WHERE order_id=$1 ORDER BY created_at DESC`, [orderId]);
    const timeline = await client.query(`SELECT stage AS status,created_at AS "createdAt"
      FROM fulfillment_events WHERE order_id=$1 ORDER BY created_at`, [orderId]);
    const returns = await client.query(`SELECT reason,status,created_at AS "createdAt"
      FROM return_requests WHERE order_id=$1 ORDER BY created_at DESC`, [orderId]);
    await client.query("COMMIT");
    return {
      id: order.id,
      orderNumber: order.orderNumber,
      createdAt: order.createdAt,
      status: order.status,
      paymentStatus: order.paymentStatus,
      fulfillmentStatus: order.fulfillmentStatus,
      fulfillmentStage: order.fulfillmentStage,
      currency: order.currency,
      subtotal: order.subtotal,
      discountTotal: order.discountTotal,
      shippingTotal: order.shippingTotal,
       shippingSnapshot: order.shippingSnapshot,
      taxTotal: order.taxTotal,
      grandTotal: order.grandTotal,
      shippingAddress: order.shippingAddress,
      items: order.items.map(({ id, productName, variantName, sku, quantity, unitPrice, lineTotal }: any) => ({
        id, productName, variantName, sku, quantity, unitPrice, lineTotal,
      })),
      shipments: shipments.rows,
      timeline: timeline.rows,
      returns: returns.rows,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export type CustomerOrderScope = "all" | "personal" | "placed" | "company";
export async function listCustomerOrders(userId: string, page = 1, pageSize = 20, scope: CustomerOrderScope = "all", companyId?: string) {
  const offset = (Math.max(1, page) - 1) * Math.min(100, Math.max(1, pageSize));
  if (scope === "company" && !companyId) throw new AppError(400, "COMPANY_ID_REQUIRED", "A companyId is required for company order scope.");
  if (scope === "company") {
    const permitted = (await getDatabasePool().query(`SELECT 1 FROM company_users cu JOIN companies c ON c.id=cu.company_id
      WHERE cu.user_id=$1 AND cu.company_id=$2 AND cu.status='active' AND cu.role IN ('owner','admin') AND c.status='active'`, [userId, companyId])).rows[0];
    if (!permitted) throw new AppError(403, "COMPANY_ORDER_ACCESS_DENIED", "Owner or administrator access is required for company order history.");
  }
  const conditions: Record<CustomerOrderScope, string> = {
    personal: "o.user_id=$1 AND o.company_id IS NULL",
    placed: `o.user_id=$1 AND (o.company_id IS NULL OR EXISTS (
      SELECT 1 FROM company_users cu JOIN companies c2 ON c2.id=cu.company_id
       WHERE cu.company_id=o.company_id AND cu.user_id=$1 AND cu.status='active' AND c2.status='active'
    ))`,
    company: "o.company_id=$4",
    all: `(o.user_id=$1 AND o.company_id IS NULL OR EXISTS (
      SELECT 1 FROM company_users cu JOIN companies c2 ON c2.id=cu.company_id
       WHERE cu.company_id=o.company_id AND cu.user_id=$1 AND cu.status='active' AND c2.status='active'
         AND (o.user_id=$1 OR cu.role IN ('owner','admin'))
    ))`,
  };
  const values: unknown[] = [userId, pageSize, offset];
  if (scope === "company") values.push(companyId!);
  const result = await getDatabasePool().query(
    `SELECT o.id, o.order_number AS "orderNumber", o.created_at AS "createdAt", o.status, o.payment_status AS "paymentStatus", o.fulfillment_status AS "fulfillmentStatus", o.currency, o.grand_total AS "grandTotal", o.company_id AS "companyId", c.company_name AS "companyName",
      CASE WHEN o.company_id IS NULL THEN 'personal' WHEN o.user_id=$1 THEN 'placed' ELSE 'company' END AS source
       FROM orders o LEFT JOIN companies c ON c.id=o.company_id
       WHERE ${conditions[scope]} ORDER BY o.created_at DESC LIMIT $2 OFFSET $3`,
    values,
  );
  return { items: result.rows.map((row) => ({ ...row, grandTotal: Number(row.grandTotal) })), meta: { page, pageSize, hasNext: result.rows.length === pageSize } };
}

export async function cancelOrder(orderId: string, access: Access) {
  const client = await getDatabasePool().connect();
  try {
    await client.query("BEGIN");
    // Serialize cancellation with payment creation. createPayment takes the
    // same row lock before creating a provider-side payment attempt.
    await client.query("SELECT id FROM orders WHERE id = $1 FOR UPDATE /* cancel-order-lock */", [orderId]);
    await assertTooniesSettlementMutationAllowed(client, orderId);
    const order = await assertOrderAccess(client, orderId, access, "mutate");
    if (order.status !== "pending" || order.paymentStatus !== "pending" || order.fulfillmentStatus !== "unfulfilled") throw new AppError(409, "ORDER_NOT_CANCELLABLE", "This order can no longer be cancelled.");
    const cancellationReservation = await acquireFinancialOperation(client, {
      orderId,
      operationType: "payment_cancellation",
      operationReferenceId: `order-cancel:${orderId}`,
      leaseSeconds: 120,
    });
    await pauseAfterFinancialOperationReservation();
    const activePayment = (await client.query("SELECT 1 FROM payments WHERE order_id=$1 AND status IN ('pending','requires_action','processing','authorized','failed') LIMIT 1", [orderId])).rows[0];
    if (activePayment) throw new AppError(409, "ORDER_PAYMENT_ACTIVE", "This order has an active payment attempt and cannot be cancelled until the provider resolves it.");
    const reservations = (await client.query("SELECT id, inventory_id AS \"inventoryId\", quantity FROM inventory_reservations WHERE order_id = $1 AND status = 'active' FOR UPDATE", [orderId])).rows;
    for (const reservation of reservations) {
      const updated = await client.query("UPDATE inventory SET quantity_reserved = quantity_reserved - $1, updated_at = now() WHERE id = $2 AND quantity_reserved >= $1", [reservation.quantity, reservation.inventoryId]);
      if (!updated.rowCount) throw new AppError(409, "RESERVATION_RELEASE_FAILED", "The inventory reservation could not be released safely.");
    }
    await client.query("UPDATE inventory_reservations SET status = 'released', released_at = now() WHERE order_id = $1 AND status = 'active'", [orderId]);
    await client.query("UPDATE orders SET status = 'cancelled', fulfillment_status = 'cancelled', updated_at = now() WHERE id = $1", [orderId]);
    const promotionsReleased = await releasePromotionUsages(client, orderId);
    await client.query("INSERT INTO audit_logs (actor_user_id, action, entity_type, entity_id, new_values_json) VALUES ($1,'order.cancelled','order',$2,$3)", [access.userId ?? null, orderId, JSON.stringify({ reservationsReleased: reservations.length, promotionsReleased })]);
    await emitNotification({ type: "order.cancelled", idempotencyKey: `order.cancelled:${order.id}`, userId: order.userId ?? undefined, email: order.email ?? undefined,
      message: `Order ${order.orderNumber} was cancelled.`, metadata: { orderId: order.id, orderNumber: order.orderNumber, path: `/account/orders/${order.id}` } }, client);
    await transitionFinancialOperation(client, {
      id: cancellationReservation.id,
      leaseToken: cancellationReservation.leaseToken,
      version: cancellationReservation.version,
      state: "released",
      recoveryEvidence: { orderId, operation: "order_cancel" },
    });
    await client.query("COMMIT");
    return orderById(getDatabasePool(), orderId);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function buyAgain(orderId: string, userId: string) {
  await assertOrderAccess(getDatabasePool(), orderId, { userId }, "mutate");
  const items = (await getDatabasePool().query("SELECT product_id AS \"productId\", variant_id AS \"variantId\", quantity FROM order_items WHERE order_id = $1", [orderId])).rows;
  const { addItem } = await import("../cart/service.js");
  const added: any[] = [];
  const skipped: any[] = [];
  for (const item of items) {
    try {
      await addItem({ userId }, { productId: item.productId, variantId: item.variantId, quantity: Number(item.quantity) });
      added.push({ productId: item.productId, variantId: item.variantId });
    } catch (error: any) {
      skipped.push({ productId: item.productId, variantId: item.variantId, reason: error?.message ?? "Unavailable" });
    }
  }
  return { added, skipped };
}

export async function listAdminOrders(filters: { search?: string; status?: string; page?: number; pageSize?: number }) {
  const values: unknown[] = [];
  const clauses = ["1=1"];
  if (filters.search?.trim()) { values.push(`%${filters.search.trim()}%`); clauses.push(`(o.order_number ILIKE $${values.length} OR o.guest_email ILIKE $${values.length} OR u.email ILIKE $${values.length})`); }
  if (filters.status) { values.push(filters.status); clauses.push(`o.status = $${values.length}`); }
  const page = Math.max(1, filters.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, filters.pageSize ?? 25));
  values.push(pageSize, (page - 1) * pageSize);
  const result = await getDatabasePool().query(
    `SELECT o.id, o.order_number AS "orderNumber", o.created_at AS "createdAt", o.status, o.payment_status AS "paymentStatus", o.fulfillment_status AS "fulfillmentStatus", o.currency, o.grand_total AS "grandTotal", COALESCE(o.guest_email,u.email) AS email, c.company_name AS "companyName"
       FROM orders o LEFT JOIN users u ON u.id=o.user_id LEFT JOIN companies c ON c.id=o.company_id
      WHERE ${clauses.join(" AND ")} ORDER BY o.created_at DESC LIMIT $${values.length - 1} OFFSET $${values.length}`,
    values,
  );
  return { items: result.rows.map((row) => ({ ...row, grandTotal: Number(row.grandTotal) })), meta: { page, pageSize, hasNext: result.rows.length === pageSize } };
}

export async function getAdminOrder(orderId: string) {
  return orderById(getDatabasePool(), orderId);
}