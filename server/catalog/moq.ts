import type { Pool, PoolClient } from "pg";
import { AppError } from "../middleware/error-handler.js";

type Queryable = Pick<Pool, "query"> | Pick<PoolClient, "query">;

export type MinimumOrderQuantity = {
  productId: string;
  variantId: string | null;
  minimumOrderQuantity: number;
};

/**
 * The variant value is deliberately selected before the product value.  This
 * is used at every mutable boundary rather than relying on a client supplied
 * product/variant payload.
 */
export async function getMinimumOrderQuantity(
  db: Queryable,
  productId: string,
  variantId: string | null,
): Promise<MinimumOrderQuantity> {
  const result = await db.query<{ productId: string; variantId: string | null; minimumOrderQuantity: number | string }>(
    `SELECT p.id AS "productId", pv.id AS "variantId",
            COALESCE(pv.minimum_order_quantity, p.minimum_order_quantity) AS "minimumOrderQuantity"
       FROM products p
       LEFT JOIN product_variants pv ON pv.product_id = p.id AND pv.id IS NOT DISTINCT FROM $2::uuid
      WHERE p.id = $1`,
    [productId, variantId],
  );
  const row = result.rows[0];
  if (!row) throw new AppError(404, "PRODUCT_NOT_FOUND", "The product was not found.");
  if (variantId && row.variantId !== variantId) throw new AppError(409, "ITEM_NOT_SELLABLE", "This product variant is not currently available.");
  return {
    productId: row.productId,
    variantId: row.variantId,
    minimumOrderQuantity: Math.max(1, Number(row.minimumOrderQuantity)),
  };
}

export function assertMinimumOrderQuantity(
  quantity: number,
  minimum: MinimumOrderQuantity,
): void {
  if (quantity >= minimum.minimumOrderQuantity) return;
  throw new AppError(
    409,
    "MINIMUM_ORDER_QUANTITY_NOT_MET",
    `Quantity must be at least ${minimum.minimumOrderQuantity}.`,
    {
      productId: minimum.productId,
      variantId: minimum.variantId,
      requiredMinimum: minimum.minimumOrderQuantity,
      minimumOrderQuantity: minimum.minimumOrderQuantity,
      quantity,
    },
  );
}