import assert from "node:assert/strict";
import { closeDatabase, getDatabasePool } from "../db/client.js";
import { assertMutableIntegrationTestDatabase } from "../testing/database-safety.js";
import { reconcileDuplicatePrimaryMedia } from "./media-primary-reconciliation.js";

async function run(): Promise<void> {
  assertMutableIntegrationTestDatabase("Product media primary migration integration");
  const pool = getDatabasePool();
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  let productId = "";
  let variantId = "";
  try {
    const category = (await pool.query<{ id: string }>(
      "SELECT id FROM categories WHERE active=true ORDER BY sort_order,id LIMIT 1",
    )).rows[0]!.id;
    productId = (await pool.query<{ id: string }>(
      `INSERT INTO products(name,slug,parent_sku,category_id,description,cost_price,base_price,vat_rate,weight,status)
       VALUES($1,$2,$3,$4,$5,1,2,19,0,'draft') RETURNING id`,
      [`Media repair ${suffix}`, `media-repair-${suffix}`, `MEDIA-${suffix}`, category, `Media repair ${suffix}`],
    )).rows[0]!.id;
    variantId = (await pool.query<{ id: string }>(
      "INSERT INTO product_variants(product_id,sku,title,active) VALUES($1,$2,'Variant',false) RETURNING id",
      [productId, `MEDIA-VARIANT-${suffix}`],
    )).rows[0]!.id;
    const inserted = (await pool.query<{ id: string; variantId: string | null; sortOrder: number }>(
      `INSERT INTO product_media(product_id,variant_id,type,url,is_primary,sort_order,created_at)
       VALUES
         ($1,NULL,'image',$3,true,0,now()),
         ($1,NULL,'image',$4,false,1,now()),
         ($1,NULL,'image',$5,false,2,now()),
         ($1,$2,'image',$6,true,0,now()),
         ($1,$2,'image',$7,false,1,now())
       RETURNING id,variant_id AS "variantId",sort_order AS "sortOrder"`,
      [productId, variantId, `/media/${suffix}-p0`, `/media/${suffix}-p1`, `/media/${suffix}-p2`, `/media/${suffix}-v0`, `/media/${suffix}-v1`],
    )).rows;
    const first = await reconcileDuplicatePrimaryMedia();
    assert.equal(first.updated.length, 0);
    assert.equal(first.remainingViolations, 0);
    const media = (await pool.query<{ id: string; variantId: string | null; isPrimary: boolean }>(
      `SELECT id,variant_id AS "variantId",is_primary AS "isPrimary"
         FROM product_media WHERE product_id=$1 ORDER BY variant_id NULLS FIRST,sort_order,created_at,id`,
      [productId],
    )).rows;
    assert.equal(media.length, inserted.length, "repair must preserve every media row");
    assert.equal(media.filter((row) => row.variantId === null && row.isPrimary).length, 1);
    assert.equal(media.filter((row) => row.variantId === variantId && row.isPrimary).length, 1);
    assert.equal(media.find((row) => row.variantId === null && row.isPrimary)!.id, inserted[0]!.id);
    assert.equal(media.find((row) => row.variantId === variantId && row.isPrimary)!.id, inserted[3]!.id);
    await assert.rejects(
      pool.query(
        "INSERT INTO product_media(product_id,type,url,is_primary,sort_order) VALUES($1,'image',$2,true,3)",
        [productId, `/media/${suffix}-duplicate-product-primary`],
      ),
      (error: { constraint?: string }) => error.constraint === "product_media_primary_product_unique",
    );
    await assert.rejects(
      pool.query(
        "INSERT INTO product_media(product_id,variant_id,type,url,is_primary,sort_order) VALUES($1,$2,'image',$3,true,2)",
        [productId, variantId, `/media/${suffix}-duplicate-variant-primary`],
      ),
      (error: { constraint?: string }) => error.constraint === "product_media_primary_variant_unique",
    );
    const second = await reconcileDuplicatePrimaryMedia();
    assert.equal(second.updated.length, 0, "repair must be idempotent");
    assert.equal(second.remainingViolations, 0);
    console.log("Product media primary migration integration checks passed.");
  } finally {
    if (productId) await pool.query("DELETE FROM products WHERE id=$1", [productId]);
    await closeDatabase();
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});