import { createHash } from "node:crypto";

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map((key) => [key, stable((value as Record<string, unknown>)[key])]));
  }
  return value;
}

export function tooniesSupplierSnapshotFingerprint(rows: any[]): string {
  const canonical = rows.map((row) => [
    row.id, row.productId, row.variantId ?? null, String(row.quantity),
    row.supplierId, row.supplierProductLinkId, row.catalogueItemId, row.catalogueVariantId,
    row.productCode, row.skuCode, String(row.supplierCostEur), String(row.supplierCostCny),
    stable(row.supplierCostProvenance), String(row.thresholdPercent),
  ]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export async function loadTooniesSupplierSnapshotFingerprint(db: { query: (sql: string, values?: unknown[]) => Promise<{ rows: any[] }> }, orderId: string): Promise<string | null> {
  const rows = (await db.query(
    `SELECT oi.id,oi.product_id AS "productId",oi.variant_id AS "variantId",oi.quantity,
            oi.supplier_id AS "supplierId",oi.supplier_product_link_id AS "supplierProductLinkId",
            oi.supplier_catalogue_item_id AS "catalogueItemId",oi.supplier_catalogue_variant_id AS "catalogueVariantId",
            oi.supplier_product_code AS "productCode",oi.supplier_sku_code AS "skuCode",
            oi.supplier_cost_eur AS "supplierCostEur",oi.supplier_cost_cny AS "supplierCostCny",
            oi.supplier_cost_provenance AS "supplierCostProvenance",
            oi.supplier_cost_threshold_percent AS "thresholdPercent"
       FROM order_items oi JOIN suppliers s ON s.id=oi.supplier_id AND s.slug='toonies'
      WHERE oi.order_id=$1 ORDER BY oi.id`, [orderId],
  )).rows;
  return rows.length ? tooniesSupplierSnapshotFingerprint(rows) : null;
}