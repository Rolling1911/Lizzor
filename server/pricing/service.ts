import { getDatabasePool } from "../db/client.js";
import { AppError } from "../middleware/error-handler.js";
import { assertMerchandisePriceFloor } from "./floor.js";

export interface PriceTierInput {
  id?: string;
  minQuantity: number;
  maxQuantity: number | null;
  unitPrice: number;
  active: boolean;
}

export interface PriceTier extends PriceTierInput {
  id: string;
  productId: string | null;
  variantId: string | null;
}

export interface TierGroup {
  productId: string | null;
  variantId: string | null;
  tiers: PriceTierInput[];
}

export interface HomepageWholesaleOffer {
  minQuantity: number;
  unitPrice: number;
  additionalQuantity: number;
}

function validateTiers(tiers: PriceTierInput[], basePrice: number | null): void {
  if (!Array.isArray(tiers)) throw new AppError(400, "INVALID_PRICE_TIERS", "Price tiers must be an array.");
  const active = tiers.filter((tier) => tier.active).sort((a, b) => a.minQuantity - b.minQuantity);
  const seen = new Set<string>();
  for (const tier of tiers) {
    if (!Number.isInteger(tier.minQuantity) || tier.minQuantity < 1) throw new AppError(400, "INVALID_TIER_QUANTITY", "Tier quantities must be whole numbers starting at 1.");
    if (tier.maxQuantity !== null && (!Number.isInteger(tier.maxQuantity) || tier.maxQuantity < tier.minQuantity)) throw new AppError(400, "INVALID_TIER_RANGE", "A tier's maximum quantity must be empty or at least its minimum.");
    if (!Number.isFinite(tier.unitPrice) || tier.unitPrice < 0) throw new AppError(400, "INVALID_TIER_PRICE", "Tier prices cannot be negative.");
    const key = `${tier.minQuantity}:${tier.maxQuantity ?? ""}`;
    if (seen.has(key)) throw new AppError(400, "DUPLICATE_TIER_RANGE", "Duplicate quantity ranges are not allowed.");
    seen.add(key);
  }
  for (let index = 1; index < active.length; index += 1) {
    const previous = active[index - 1]!;
    const current = active[index]!;
    if (previous.maxQuantity === null || previous.maxQuantity >= current.minQuantity) throw new AppError(400, "OVERLAPPING_TIER_RANGES", "Active quantity tiers cannot overlap.");
  }
  if (active.filter((tier) => tier.maxQuantity === null).length > 1) throw new AppError(400, "MULTIPLE_OPEN_TIERS", "Only the final active tier may be open-ended.");
  if (active.some((tier) => tier.maxQuantity === null && active.indexOf(tier) !== active.length - 1)) throw new AppError(400, "OPEN_TIER_NOT_LAST", "An open-ended tier must be the final tier.");
  if (basePrice === null && !active.some((tier) => tier.minQuantity === 1)) throw new AppError(400, "QUANTITY_ONE_UNPRICED", "Quantity 1 must always have a price.");
}

async function getTarget(client: { query: (text: string, values?: unknown[]) => Promise<{ rows: any[] }> }, productId: string | null, variantId: string | null) {
  if (!productId && !variantId) throw new AppError(400, "PRICING_SCOPE_REQUIRED", "Provide a product or variant.");
  if (variantId) {
    await client.query(`SELECT v.id FROM supplier_product_links l JOIN suppliers s ON s.id=l.supplier_id AND s.slug='toonies'
      JOIN supplier_catalogue_variants v ON v.id=l.catalogue_variant_id JOIN supplier_catalogue_items i ON i.id=l.catalogue_item_id
      WHERE l.variant_id=$1 FOR SHARE OF v,i,l`, [variantId]);
    const result = await client.query(`SELECT pv.id,pv.product_id AS "productId",pv.base_price AS "basePrice",pv.cost_price AS "costPrice",
      COALESCE((SELECT COALESCE(v.manual_cost_override_eur,v.normalized_eur,i.manual_cost_override_eur,i.normalized_eur)
        FROM supplier_product_links l JOIN suppliers s ON s.id=l.supplier_id AND s.slug='toonies'
        JOIN supplier_catalogue_items i ON i.id=l.catalogue_item_id LEFT JOIN supplier_catalogue_variants v ON v.id=l.catalogue_variant_id
        WHERE l.variant_id=pv.id LIMIT 1),pv.cost_price) AS "authoritativeCost"
      FROM product_variants pv WHERE pv.id=$1 FOR SHARE`, [variantId]);
    if (!result.rows[0]) throw new AppError(404, "VARIANT_NOT_FOUND", "The variant was not found.");
    if (productId && productId !== result.rows[0].productId) throw new AppError(400, "VARIANT_PRODUCT_MISMATCH", "The variant does not belong to the selected product.");
    const product = await client.query("SELECT base_price AS \"basePrice\", cost_price AS \"costPrice\" FROM products WHERE id = $1", [result.rows[0].productId]);
    return {
      productId: result.rows[0].productId as string,
      variantId,
      basePrice: result.rows[0].basePrice === null ? null : Number(result.rows[0].basePrice),
      costPrice: result.rows[0].costPrice === null ? null : Number(result.rows[0].costPrice),
      authoritativeCost: Number(result.rows[0].authoritativeCost),
      productBasePrice: Number(product.rows[0].basePrice),
      productCostPrice: Number(product.rows[0].costPrice),
    };
  }
  await client.query(`SELECT i.id FROM supplier_product_links l JOIN suppliers s ON s.id=l.supplier_id AND s.slug='toonies'
    JOIN supplier_catalogue_items i ON i.id=l.catalogue_item_id WHERE l.product_id=$1 AND l.variant_id IS NULL FOR SHARE OF i,l`, [productId]);
  const result = await client.query(`SELECT p.id,p.base_price AS "basePrice",p.cost_price AS "costPrice",
    COALESCE((SELECT COALESCE(i.manual_cost_override_eur,i.normalized_eur) FROM supplier_product_links l
      JOIN suppliers s ON s.id=l.supplier_id AND s.slug='toonies' JOIN supplier_catalogue_items i ON i.id=l.catalogue_item_id
      WHERE l.product_id=p.id AND l.variant_id IS NULL LIMIT 1),p.cost_price) AS "authoritativeCost"
    FROM products p WHERE p.id=$1 FOR SHARE`, [productId]);
  if (!result.rows[0]) throw new AppError(404, "PRODUCT_NOT_FOUND", "The product was not found.");
  return { productId, variantId: null, basePrice: Number(result.rows[0].basePrice), costPrice: Number(result.rows[0].costPrice), authoritativeCost: Number(result.rows[0].authoritativeCost), productBasePrice: Number(result.rows[0].basePrice), productCostPrice: Number(result.rows[0].costPrice) };
}

type Queryable = { query: (text: string, values?: unknown[]) => Promise<{ rows: any[] }> };

export async function getTiers(productId: string | null, variantId: string | null, queryable: Queryable = getDatabasePool()): Promise<PriceTier[]> {
  const result = await queryable.query(`SELECT id, product_id AS "productId", variant_id AS "variantId", min_quantity AS "minQuantity", max_quantity AS "maxQuantity", unit_price AS "unitPrice", active FROM price_tiers WHERE product_id IS NOT DISTINCT FROM $1::uuid AND variant_id IS NOT DISTINCT FROM $2::uuid ORDER BY min_quantity, id`, [productId, variantId]);
  return result.rows.map((row) => ({ ...row, minQuantity: Number(row.minQuantity), maxQuantity: row.maxQuantity === null ? null : Number(row.maxQuantity), unitPrice: Number(row.unitPrice) }));
}

/**
 * Returns the earliest purchasable bulk tier for homepage merchandising.
 * Product tiers are always candidates; variant tiers additionally require an
 * active variant with positive aggregate available inventory.
 */
export async function getHomepageWholesaleOffer(
  productId: string,
  queryable: Queryable = getDatabasePool(),
): Promise<HomepageWholesaleOffer | null> {
  const result = await queryable.query(
    `SELECT candidate."minQuantity", candidate."unitPrice"
       FROM (
         SELECT pt.min_quantity AS "minQuantity", pt.unit_price AS "unitPrice"
           FROM price_tiers pt
          WHERE pt.product_id = $1
            AND pt.variant_id IS NULL
            AND pt.active = true
            AND pt.min_quantity > 1
         UNION ALL
         SELECT pt.min_quantity, pt.unit_price
           FROM price_tiers pt
           JOIN product_variants pv ON pv.id = pt.variant_id
          WHERE pv.product_id = $1
            AND pv.active = true
            AND pt.active = true
            AND pt.min_quantity > 1
            AND COALESCE((
              SELECT sum(i.quantity_on_hand - i.quantity_reserved)
                FROM inventory i
               WHERE i.active=true AND i.variant_id = pv.id
            ), 0) > 0
       ) candidate
      ORDER BY candidate."minQuantity", candidate."unitPrice"
      LIMIT 1`,
    [productId],
  );
  const tier = result.rows[0] as { minQuantity: string; unitPrice: string } | undefined;
  if (!tier) return null;
  const minQuantity = Number(tier.minQuantity);
  return { minQuantity, unitPrice: Number(tier.unitPrice), additionalQuantity: minQuantity - 1 };
}

export async function replaceTiers(productId: string | null, variantId: string | null, tiers: PriceTierInput[]) {
  const [result] = await replaceTierGroups([{ productId, variantId, tiers }]);
  return result ?? [];
}

export async function validateTierGroup(productId: string | null, variantId: string | null, tiers: PriceTierInput[]) {
  const target = await getTarget(getDatabasePool(), productId, variantId);
    validateTiers(tiers, target.basePrice ?? target.productBasePrice);
    for (const tier of tiers.filter((item) => item.active)) {
      assertMerchandisePriceFloor({
        unitCost: target.authoritativeCost ?? target.costPrice ?? target.productCostPrice,
        merchandiseRevenue: tier.unitPrice,
        code: "PRICE_TIER_BELOW_COST",
        message: "An active quantity-tier price cannot be below the current merchandise cost.",
      });
    }
}

export async function replaceTierGroups(groups: TierGroup[]) {
  const pool = getDatabasePool();
  const client = await pool.connect();
  const results: PriceTier[][] = [];
  try {
    await client.query("BEGIN");
    for (const group of groups) {
      const target = await getTarget(client, group.productId, group.variantId);
      const scopeProductId = target.variantId ? null : target.productId;
      validateTiers(group.tiers, target.basePrice ?? target.productBasePrice);
      for (const tier of group.tiers.filter((item) => item.active)) {
        assertMerchandisePriceFloor({
          unitCost: target.authoritativeCost ?? target.costPrice ?? target.productCostPrice,
          merchandiseRevenue: tier.unitPrice,
          code: "PRICE_TIER_BELOW_COST",
          message: "An active quantity-tier price cannot be below the current merchandise cost.",
        });
      }
      await client.query("DELETE FROM price_tiers WHERE product_id IS NOT DISTINCT FROM $1::uuid AND variant_id IS NOT DISTINCT FROM $2::uuid", [scopeProductId, target.variantId]);
      for (const tier of group.tiers) {
        await client.query(`INSERT INTO price_tiers (product_id, variant_id, min_quantity, max_quantity, unit_price, active) VALUES ($1, $2, $3, $4, $5, $6)`, [scopeProductId, target.variantId, tier.minQuantity, tier.maxQuantity, tier.unitPrice.toFixed(2), tier.active]);
      }
      const saved = await client.query(`SELECT id, product_id AS "productId", variant_id AS "variantId", min_quantity AS "minQuantity", max_quantity AS "maxQuantity", unit_price AS "unitPrice", active FROM price_tiers WHERE product_id IS NOT DISTINCT FROM $1::uuid AND variant_id IS NOT DISTINCT FROM $2::uuid ORDER BY min_quantity, id`, [scopeProductId, target.variantId]);
      results.push(saved.rows.map((row) => ({ ...row, minQuantity: Number(row.minQuantity), maxQuantity: row.maxQuantity === null ? null : Number(row.maxQuantity), unitPrice: Number(row.unitPrice) })));
    }
    await client.query("COMMIT");
    return results;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function getPricing(productId: string | null, variantId: string | null, quantity: number, queryable: Queryable = getDatabasePool()) {
  if (!Number.isInteger(quantity) || quantity < 1) throw new AppError(400, "INVALID_QUANTITY", "Quantity must be a whole number of at least 1.");
  const target = await getTarget(queryable, productId, variantId);
  const variantTiers = variantId ? await getTiers(null, variantId, queryable) : [];
  const productTiers = await getTiers(target.productId, null, queryable);
  const variantTier = variantTiers.find((tier) => tier.active && tier.minQuantity <= quantity && (tier.maxQuantity === null || quantity <= tier.maxQuantity));
  const productTier = productTiers.find((tier) => tier.active && tier.minQuantity <= quantity && (tier.maxQuantity === null || quantity <= tier.maxQuantity));
  const selected = variantTier ?? (!variantId || target.basePrice === null ? productTier : undefined);
  const unitPrice = selected?.unitPrice ?? target.basePrice ?? target.productBasePrice;
  if (unitPrice === null || unitPrice === undefined) throw new AppError(409, "PRICE_UNAVAILABLE", "No price is configured for this quantity.");
  const next = (variantTier ? variantTiers : variantTiers.length ? variantTiers : productTiers)
    .filter((tier) => tier.active && tier.minQuantity > quantity)
    .sort((a, b) => a.minQuantity - b.minQuantity)[0];
  return {
    productId: target.productId,
    variantId: target.variantId,
    quantity,
    unitPrice,
    totalPrice: Number((unitPrice * quantity).toFixed(2)),
    source: selected ? (selected.variantId ? "variant_tier" : "product_tier") : variantId && target.basePrice !== null ? "variant_base" : "product_base",
    costPrice: target.costPrice ?? target.productCostPrice,
    margin: Number((unitPrice - (target.costPrice ?? target.productCostPrice)).toFixed(2)),
    marginPercent: unitPrice > 0 ? Number((((unitPrice - (target.costPrice ?? target.productCostPrice)) / unitPrice) * 100).toFixed(2)) : null,
    nextTier: next ? { minQuantity: next.minQuantity, unitPrice: next.unitPrice, additionalQuantity: next.minQuantity - quantity } : null,
  };
}

export async function listPricingItems(filters: { page?: number; pageSize?: number; search?: string; hasTiers?: boolean; productId?: string } = {}, includeCost = false) {
  const pool = getDatabasePool();
  const page = Math.max(1, Math.floor(filters.page ?? 1));
  const pageSize = Math.min(100, Math.max(1, Math.floor(filters.pageSize ?? 25)));
  const values: unknown[] = [];
  const clauses = ["1 = 1"];
  if (filters.search?.trim()) { values.push(`%${filters.search.trim()}%`); clauses.push(`(s."productName" ILIKE $${values.length} OR s."parentSku" ILIKE $${values.length} OR s."variantSku" ILIKE $${values.length})`); }
  if (filters.productId) { values.push(filters.productId); clauses.push(`s."productId" = $${values.length}`); }
  if (filters.hasTiers !== undefined) clauses.push(filters.hasTiers ? `EXISTS (SELECT 1 FROM price_tiers pt WHERE pt.product_id IS NOT DISTINCT FROM CASE WHEN s."variantId" IS NULL THEN s."productId" ELSE NULL END AND pt.variant_id IS NOT DISTINCT FROM s."variantId")` : `NOT EXISTS (SELECT 1 FROM price_tiers pt WHERE pt.product_id IS NOT DISTINCT FROM CASE WHEN s."variantId" IS NULL THEN s."productId" ELSE NULL END AND pt.variant_id IS NOT DISTINCT FROM s."variantId")`);
  const where = clauses.join(" AND ");
  const scopes = `(SELECT p.id AS "productId", p.name AS "productName", p.parent_sku AS "parentSku", p.base_price AS "productBasePrice", p.cost_price AS "productCostPrice", NULL::uuid AS "variantId", NULL::text AS "variantSku", NULL::text AS "variantTitle", NULL::numeric AS "variantBasePrice", NULL::numeric AS "variantCostPrice" FROM products p
    UNION ALL SELECT p.id, p.name, p.parent_sku, p.base_price, p.cost_price, pv.id, pv.sku, pv.title, pv.base_price, pv.cost_price FROM products p JOIN product_variants pv ON pv.product_id = p.id)`;
  const count = await pool.query<{ count: string }>(`SELECT count(*)::text AS count FROM ${scopes} s WHERE ${where}`, values);
  const offset = (page - 1) * pageSize;
  const rows = await pool.query(`SELECT s.*, (SELECT count(*) FROM price_tiers pt WHERE pt.active AND pt.product_id IS NOT DISTINCT FROM CASE WHEN s."variantId" IS NULL THEN s."productId" ELSE NULL END AND pt.variant_id IS NOT DISTINCT FROM s."variantId")::text AS "tierCount",
    (SELECT min(pt.unit_price) FROM price_tiers pt WHERE pt.active AND pt.product_id IS NOT DISTINCT FROM CASE WHEN s."variantId" IS NULL THEN s."productId" ELSE NULL END AND pt.variant_id IS NOT DISTINCT FROM s."variantId") AS "lowestTierPrice"
    FROM ${scopes} s WHERE ${where} ORDER BY s."productName", s."variantId" NULLS FIRST, s."variantSku" LIMIT $${values.length + 1} OFFSET $${values.length + 2}`, [...values, pageSize, offset]);
  const total = Number(count.rows[0]?.count ?? 0);
  return { items: rows.rows.map((row) => {
    const { productCostPrice, variantCostPrice, ...safe } = row;
    const lowestTierPrice = row.lowestTierPrice === null ? null : Number(row.lowestTierPrice);
    const effectiveCost = variantCostPrice === null ? Number(productCostPrice) : Number(variantCostPrice);
    return { ...safe, ...(includeCost ? { productCostPrice: Number(productCostPrice), variantCostPrice: variantCostPrice === null ? null : Number(variantCostPrice), lowestTierMargin: lowestTierPrice === null ? null : Number((lowestTierPrice - effectiveCost).toFixed(2)) } : {}), productBasePrice: Number(row.productBasePrice), variantBasePrice: row.variantBasePrice === null ? null : Number(row.variantBasePrice), tierCount: Number(row.tierCount), lowestTierPrice };
  }), meta: { page, pageSize, total, hasNext: offset + rows.rows.length < total } };
}

export async function exportPricingTiers(filters: { search?: string; productId?: string } = {}) {
  const values: unknown[] = [];
  const clauses = ["1 = 1"];
  if (filters.search?.trim()) { values.push(`%${filters.search.trim()}%`); clauses.push(`(p.name ILIKE $${values.length} OR p.parent_sku ILIKE $${values.length} OR pv.sku ILIKE $${values.length})`); }
  if (filters.productId) { values.push(filters.productId); clauses.push(`p.id = $${values.length}`); }
  const result = await getDatabasePool().query(
    `SELECT pt.id, COALESCE(pt.variant_id, pt.product_id) AS "scopeId",
            CASE WHEN pt.variant_id IS NULL THEN 'product' ELSE 'variant' END AS "scopeType",
            COALESCE(pv.sku, p.parent_sku) AS sku, pt.min_quantity AS "minQuantity",
            pt.max_quantity AS "maxQuantity", pt.unit_price AS "unitPrice", pt.active
       FROM price_tiers pt
       JOIN products p ON p.id = COALESCE(pt.product_id, (SELECT product_id FROM product_variants WHERE id = pt.variant_id))
       LEFT JOIN product_variants pv ON pv.id = pt.variant_id
      WHERE ${clauses.join(" AND ")}
      ORDER BY p.name, pv.sku NULLS FIRST, pt.min_quantity, pt.id`,
    values,
  );
  return result.rows.map((row) => ({ ...row, minQuantity: Number(row.minQuantity), maxQuantity: row.maxQuantity === null ? null : Number(row.maxQuantity), unitPrice: Number(row.unitPrice) }));
}

export async function copyTiers(sourceProductId: string | null, sourceVariantId: string | null, targets: Array<{ productId: string | null; variantId: string | null }>) {
  const source = await getTiers(sourceProductId, sourceVariantId);
  if (!source.length) throw new AppError(400, "SOURCE_TIERS_EMPTY", "The source has no tiers to copy.");
  const clean = source.map(({ id: _id, productId: _productId, variantId: _variantId, ...tier }) => tier);
  await replaceTierGroups(targets.map((target) => ({ ...target, tiers: clean })));
  return { updated: targets.length };
}