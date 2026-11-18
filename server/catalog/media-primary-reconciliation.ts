import { getDatabasePool } from "../db/client.js";

export interface MediaPrimaryRepair {
  id: string;
  productId: string;
  variantId: string | null;
}

export async function reconcileDuplicatePrimaryMedia(): Promise<{
  updated: MediaPrimaryRepair[];
  remainingViolations: number;
}> {
  const client = await getDatabasePool().connect();
  try {
    await client.query("BEGIN");
    await client.query("LOCK TABLE product_media IN SHARE ROW EXCLUSIVE MODE");
    const updated = await client.query<MediaPrimaryRepair>(
      `WITH ranked AS (
         SELECT id,product_id,variant_id,
                row_number() OVER (
                  PARTITION BY product_id,variant_id
                  ORDER BY sort_order,created_at,id
                ) AS primary_rank
           FROM product_media
          WHERE type='image' AND is_primary=true
       )
       UPDATE product_media media
          SET is_primary=false
         FROM ranked
        WHERE media.id=ranked.id
          AND ranked.primary_rank>1
       RETURNING media.id,media.product_id AS "productId",media.variant_id AS "variantId"`,
    );
    const verification = await client.query<{ count: number }>(
      `SELECT count(*)::int AS count
         FROM (
           SELECT product_id,variant_id
             FROM product_media
            WHERE type='image' AND is_primary=true
            GROUP BY product_id,variant_id
           HAVING count(*)>1
         ) violations`,
    );
    const remainingViolations = Number(verification.rows[0]?.count ?? 0);
    if (remainingViolations !== 0) {
      throw new Error(`Product media primary reconciliation left ${remainingViolations} violating scopes.`);
    }
    await client.query("COMMIT");
    return { updated: updated.rows, remainingViolations };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}