import assert from "node:assert/strict";
import { closeDatabase, getDatabasePool } from "../db/client.js";
import { evaluatePromotions, validateCoupon } from "./service.js";

const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
const marker = `promotion-test-${suffix}`;

async function run() {
  const pool = getDatabasePool();
  let categoryId = "";
  let brandId = "";
  let productId = "";
  const campaignIds: string[] = [];
  try {
    categoryId = (await pool.query("INSERT INTO categories (name,slug) VALUES ($1,$2) RETURNING id", [marker, `${marker}-category`])).rows[0].id;
    brandId = (await pool.query("INSERT INTO brands (name,slug) VALUES ($1,$2) RETURNING id", [marker, `${marker}-brand`])).rows[0].id;
    productId = (await pool.query("INSERT INTO products (name,slug,parent_sku,category_id,brand_id,description,cost_price,base_price,vat_rate,weight,status,published_at) VALUES ($1,$2,$3,$4,$5,$6,5,100,19,1,'active',now()) RETURNING id", [marker, `${marker}-product`, `${marker}-sku`, categoryId, brandId, marker])).rows[0].id;
    const line = [{ key: "line", productId, categoryId, brandId, quantity: 10, lineTotal: 800 }];

    const percentage = (await pool.query("INSERT INTO promotion_campaigns (name,start_at,promotion_type,discount_type,discount_value,automatic,active,priority) VALUES ($1,now()-interval '1 minute','product','percentage',10,true,true,10) RETURNING id", [`${marker} percentage`])).rows[0].id;
    campaignIds.push(percentage);
    await pool.query("INSERT INTO promotion_products (campaign_id,product_id) VALUES ($1,$2)", [percentage, productId]);
    let quote = await evaluatePromotions(line);
    assert.equal(quote.discountTotal, 80);
    assert.equal(quote.lines.line?.discount, 80);

    await pool.query("UPDATE promotion_campaigns SET active=false WHERE id=$1", [percentage]);
    const fixed = (await pool.query("INSERT INTO promotion_campaigns (name,start_at,promotion_type,discount_type,discount_value,automatic,active,priority) VALUES ($1,now()-interval '1 minute','category','fixed',50,true,true,10) RETURNING id", [`${marker} fixed`])).rows[0].id;
    campaignIds.push(fixed);
    await pool.query("INSERT INTO promotion_categories (campaign_id,category_id) VALUES ($1,$2)", [fixed, categoryId]);
    quote = await evaluatePromotions(line);
    assert.equal(quote.discountTotal, 50);

    await pool.query("UPDATE promotion_campaigns SET active=false WHERE id=$1", [fixed]);
    const coupon = (await pool.query("INSERT INTO promotion_campaigns (name,start_at,promotion_type,discount_type,discount_value,automatic,coupon_code,active,priority) VALUES ($1,now()-interval '1 minute','brand','percentage',25,false,$2,true,10) RETURNING id", [`${marker} coupon`, `${marker}-code`.toUpperCase()])).rows[0].id;
    campaignIds.push(coupon);
    await pool.query("INSERT INTO promotion_brands (campaign_id,brand_id) VALUES ($1,$2)", [coupon, brandId]);
    quote = await validateCoupon(`${marker}-code`, line);
    assert.equal(quote.discountTotal, 200);
    await assert.rejects(() => validateCoupon("not-valid", line), /invalid|ineligible/i);

    await pool.query("UPDATE promotion_campaigns SET discount_value=60,allow_stacking=true WHERE id=$1", [coupon]);
    const stacked = (await pool.query("INSERT INTO promotion_campaigns (name,start_at,promotion_type,discount_type,discount_value,automatic,allow_stacking,active,priority) VALUES ($1,now()-interval '1 minute','order','percentage',60,true,true,true,20) RETURNING id", [`${marker} stacked`])).rows[0].id;
    campaignIds.push(stacked);
    quote = await validateCoupon(`${marker}-code`, line, { guestSessionId: `${marker}-guest` });
    assert.equal(quote.discountTotal, 800);
    assert.equal(quote.lines.line?.allocations.length, 2);

    await pool.query("UPDATE promotion_campaigns SET active=false WHERE id=ANY($1::uuid[])", [[coupon, stacked]]);
    const future = (await pool.query("INSERT INTO promotion_campaigns (name,start_at,promotion_type,discount_type,discount_value,automatic,coupon_code,active) VALUES ($1,now()+interval '1 day','order','percentage',50,false,$2,true) RETURNING id", [`${marker} future`, `${marker}-future`.toUpperCase()])).rows[0].id;
    campaignIds.push(future);
    await assert.rejects(() => validateCoupon(`${marker}-future`, line), /invalid|ineligible/i);

    console.info("Promotion integration checks passed.");
  } finally {
    if (campaignIds.length) await pool.query("DELETE FROM promotion_campaigns WHERE id=ANY($1::uuid[])", [campaignIds]);
    if (productId) await pool.query("DELETE FROM products WHERE id=$1", [productId]);
    if (brandId) await pool.query("DELETE FROM brands WHERE id=$1", [brandId]);
    if (categoryId) await pool.query("DELETE FROM categories WHERE id=$1", [categoryId]);
    await closeDatabase();
  }
}

run().catch((error) => { console.error(error); process.exitCode = 1; });