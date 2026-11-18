import assert from "node:assert/strict";
import type { Server } from "node:http";
import { createApp } from "../app.js";
import { closeDatabase, getDatabasePool } from "../db/client.js";
import { listProducts } from "./service.js";

const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
const marker = `storefront-${suffix}`;

async function request(baseUrl: string, path: string) {
  const response = await fetch(`${baseUrl}/api/v1${path}`);
  const body = await response.json();
  return { response, body };
}

async function run() {
  const pool = getDatabasePool();
  const app = await createApp({ serveFrontend: false });
  const server: Server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  let categoryId = "";
  let brandId = "";
  let productId = "";
  let hiddenProductId = "";
  let inactiveProductId = "";
  let outOfStockProductId = "";
  let variantId = "";
  let warehouseId = "";
  try {
    categoryId = (await pool.query("INSERT INTO categories (name,slug,description) VALUES ($1,$2,$3) RETURNING id", [`${marker} Category`, `${marker}-category`, "Public category"])).rows[0].id;
    brandId = (await pool.query("INSERT INTO brands (name,slug,description) VALUES ($1,$2,$3) RETURNING id", [`${marker} Brand`, `${marker}-brand`, "Public brand"])).rows[0].id;
    productId = (await pool.query(
       `INSERT INTO products (name,slug,parent_sku,brand_id,category_id,description,cost_price,base_price,vat_rate,weight,status,published_at,featured,new_arrival,homepage_wholesale)
        VALUES ($1,$2,$3,$4,$5,$6,4,12,19,1,'active',now(),true,true,true) RETURNING id`,
      [`${marker} Product`, `${marker}-product`, `${marker}-sku`, brandId, categoryId, "Customer-safe description"],
    )).rows[0].id;
    hiddenProductId = (await pool.query(
       `INSERT INTO products (name,slug,parent_sku,category_id,description,cost_price,base_price,vat_rate,weight,status,homepage_wholesale)
        VALUES ($1,$2,$3,$4,$5,3,8,19,1,'draft',true) RETURNING id`,
      [`${marker} Hidden`, `${marker}-hidden`, `${marker}-hidden-sku`, categoryId, "Hidden"],
    )).rows[0].id;
    inactiveProductId = (await pool.query(
      `INSERT INTO products (name,slug,parent_sku,category_id,description,cost_price,base_price,vat_rate,weight,status,published_at,featured)
       VALUES ($1,$2,$3,$4,$5,3,8,19,1,'inactive',now(),true) RETURNING id`,
      [`${marker} Inactive`, `${marker}-inactive`, `${marker}-inactive-sku`, categoryId, "Operationally unavailable"],
    )).rows[0].id;
    // The admin product query uses status as its lifecycle filter: inactive is
    // retained for operations while All retains all lifecycle states.
    assert.equal((await listProducts({ ids: [inactiveProductId], status: "inactive" })).items.length, 1);
    assert.equal((await listProducts({ ids: [inactiveProductId], status: "active" })).items.length, 0);
    assert.equal((await listProducts({ ids: [inactiveProductId] })).items.length, 1);
    outOfStockProductId = (await pool.query(
      `INSERT INTO products (name,slug,parent_sku,category_id,description,cost_price,base_price,vat_rate,weight,status,published_at,homepage_wholesale)
       VALUES ($1,$2,$3,$4,$5,3,8,19,1,'active',now(),true) RETURNING id`,
      [`${marker} Out of Stock`, `${marker}-out-of-stock`, `${marker}-out-of-stock-sku`, categoryId, "Published but unavailable"],
    )).rows[0].id;
    variantId = (await pool.query("INSERT INTO product_variants (product_id,sku,title,base_price,active) VALUES ($1,$2,'Case',11,true) RETURNING id", [productId, `${marker}-variant`])).rows[0].id;
    warehouseId = (await pool.query("INSERT INTO warehouses (name,code,country_code) VALUES ($1,$2,'CY') RETURNING id", [marker, marker.slice(-40)])).rows[0].id;
    await pool.query("INSERT INTO inventory (warehouse_id,variant_id,quantity_on_hand) VALUES ($1,$2,7)", [warehouseId, variantId]);
    await pool.query("INSERT INTO price_tiers (variant_id,min_quantity,max_quantity,unit_price,active) VALUES ($1,1,9,11,true),($1,10,NULL,9,true)", [variantId]);
    const outOfStockVariantId = (await pool.query(
      "INSERT INTO product_variants (product_id,sku,title,base_price,active) VALUES ($1,$2,'Unavailable case',7,true) RETURNING id",
      [outOfStockProductId, `${marker}-out-of-stock-variant`],
    )).rows[0].id;
    await pool.query(
      "INSERT INTO price_tiers (variant_id,min_quantity,max_quantity,unit_price,active) VALUES ($1,5,NULL,6,true)",
      [outOfStockVariantId],
    );

    const homepage = await request(baseUrl, "/storefront/homepage-products");
    assert.equal(homepage.response.status, 200);
    assert.deepEqual(Object.keys(homepage.body.data).sort(), ["bestSellers", "liveWholesalePricing"]);
    assert.ok(homepage.body.data.bestSellers.some((item: any) => item.id === productId));
    assert.ok(homepage.body.data.liveWholesalePricing.some((item: any) => item.id === productId));
    const homepageIds = new Set([
      ...homepage.body.data.bestSellers.map((item: any) => item.id),
      ...homepage.body.data.liveWholesalePricing.map((item: any) => item.id),
    ]);
    assert.equal(homepageIds.has(hiddenProductId), false);
    assert.equal(homepageIds.has(inactiveProductId), false);
    assert.equal(homepageIds.has(outOfStockProductId), false);
    const homepageCard = homepage.body.data.bestSellers.find((item: any) => item.id === productId);
    assert.ok(homepageCard);
    assert.equal(homepageCard.price, 12);
    assert.deepEqual(homepageCard.homepageWholesaleOffer, { minQuantity: 10, unitPrice: 9, additionalQuantity: 9 });
    assert.equal(homepageCard.available, 7);
    assert.equal(homepageCard.availability, "in_stock");
    assert.equal("costPrice" in homepageCard, false);
    assert.equal("margin" in homepageCard, false);
    assert.equal("warehouseId" in homepageCard, false);

    const search = await request(baseUrl, `/catalog/products?search=${encodeURIComponent(marker)}&pageSize=10`);
    assert.equal(search.response.status, 200);
    assert.equal(search.body.data.items.length, 2);
    assert.equal(search.body.data.items.some((item: any) => item.id === inactiveProductId), false);
    const card = search.body.data.items.find((item: any) => item.id === productId);
    assert.ok(card);
    assert.equal(card.name, `${marker} Product`);
    assert.equal(card.available, 7);
    assert.equal(card.availability, "in_stock");
    assert.equal("costPrice" in card, false);
    assert.equal("margin" in card, false);
    assert.equal(card.homepageWholesale, true);
    assert.deepEqual(card.homepageWholesaleOffer, { minQuantity: 10, unitPrice: 9, additionalQuantity: 9 });
    const wholesaleOnly = await request(baseUrl, `/catalog/products?search=${encodeURIComponent(marker)}&homepageWholesale=true`);
    assert.equal(wholesaleOnly.response.status, 200);
    assert.deepEqual(
      new Set(wholesaleOnly.body.data.items.map((item: any) => item.id)),
      new Set([productId, outOfStockProductId]),
    );
    const outOfStockCard = wholesaleOnly.body.data.items.find((item: any) => item.id === outOfStockProductId);
    assert.ok(outOfStockCard);
    assert.equal(outOfStockCard.homepageWholesaleOffer, null);
    const inStockWholesaleOnly = await request(baseUrl, `/catalog/products?search=${encodeURIComponent(marker)}&homepageWholesale=true&availability=in_stock`);
    assert.equal(inStockWholesaleOnly.response.status, 200);
    assert.deepEqual(inStockWholesaleOnly.body.data.items.map((item: any) => item.id), [productId]);
    const nonWholesale = await request(baseUrl, `/catalog/products?search=${encodeURIComponent(marker)}&homepageWholesale=false`);
    assert.equal(nonWholesale.response.status, 200);
    assert.equal(nonWholesale.body.data.items.length, 0);

    const categories = await request(baseUrl, "/catalog/categories");
    assert.equal(categories.response.status, 200);
    assert.ok(categories.body.data.some((item: any) => item.id === categoryId));
    const brands = await request(baseUrl, "/catalog/brands");
    assert.equal(brands.response.status, 200);
    assert.ok(brands.body.data.some((item: any) => item.id === brandId));

    const detail = await request(baseUrl, `/catalog/products/${marker}-product`);
    assert.equal(detail.response.status, 200);
    assert.equal(detail.body.data.variants[0].tiers.length, 2);
    assert.equal(detail.body.data.variants[0].tiers[1].unitPrice, 9);
    assert.equal(detail.body.data.variants[0].available, 7);
    assert.equal("costPrice" in detail.body.data, false);
    assert.equal("costPrice" in detail.body.data.variants[0], false);
    assert.equal("warehouseId" in detail.body.data, false);
    assert.equal((await request(baseUrl, `/catalog/products/${marker}-hidden`)).response.status, 404);
    assert.equal((await request(baseUrl, `/catalog/products/${marker}-inactive`)).response.status, 404);
    const filtered = await request(baseUrl, `/catalog/products?search=${encodeURIComponent(marker)}&minPrice=12&maxPrice=12&availability=in_stock`);
    assert.equal(filtered.response.status, 200);
    assert.equal(filtered.body.data.items.length, 1);
    const excluded = await request(baseUrl, `/catalog/products?search=${encodeURIComponent(marker)}&maxPrice=11&availability=in_stock`);
    assert.equal(excluded.body.data.items.length, 0);
    const tierQuote = await request(baseUrl, `/catalog/products/${marker}-product/quote?variantId=${variantId}&quantity=10`);
    assert.equal(tierQuote.body.data.unitPrice, 9);
    assert.equal(tierQuote.body.data.totalPrice, 90);
    await pool.query("DELETE FROM price_tiers WHERE variant_id=$1", [variantId]);
    await pool.query("INSERT INTO price_tiers (product_id,min_quantity,max_quantity,unit_price,active) VALUES ($1,10,NULL,7,true)", [productId]);
    const variantBaseQuote = await request(baseUrl, `/catalog/products/${marker}-product/quote?variantId=${variantId}&quantity=10`);
    assert.equal(variantBaseQuote.body.data.unitPrice, 11);
    assert.equal(variantBaseQuote.body.data.totalPrice, 110);

    const session = await fetch(`${baseUrl}/api/v1/auth/me`);
    const setCookies = (session.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];
    const cookies = setCookies.map((cookie) => cookie.split(";")[0]).join("; ");
    const csrfCookie = setCookies.map((cookie) => cookie.split(";")[0]).find((cookie) => cookie.startsWith("lizzor_csrf="));
    assert.ok(csrfCookie);
    const csrf = decodeURIComponent(csrfCookie.slice(csrfCookie.indexOf("=") + 1));
    const unpublishedAdd = await fetch(`${baseUrl}/api/v1/cart/items`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: cookies, "x-csrf-token": csrf },
      body: JSON.stringify({ productId: hiddenProductId, quantity: 1 }),
    });
    assert.equal(unpublishedAdd.status, 409);
    const inactiveAdd = await fetch(`${baseUrl}/api/v1/cart/items`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: cookies, "x-csrf-token": csrf },
      body: JSON.stringify({ productId: inactiveProductId, quantity: 1 }),
    });
    assert.equal(inactiveAdd.status, 409);
    console.log("Storefront API integration passed.");
  } finally {
    await pool.query("DELETE FROM price_tiers WHERE variant_id=$1", [variantId]).catch(() => undefined);
    await pool.query("DELETE FROM inventory WHERE variant_id=$1", [variantId]).catch(() => undefined);
    await pool.query("DELETE FROM warehouses WHERE id=$1", [warehouseId]).catch(() => undefined);
    await pool.query("DELETE FROM products WHERE id=ANY($1::uuid[])", [[productId, hiddenProductId, inactiveProductId, outOfStockProductId].filter(Boolean)]).catch(() => undefined);
    await pool.query("DELETE FROM brands WHERE id=$1", [brandId]).catch(() => undefined);
    await pool.query("DELETE FROM categories WHERE id=$1", [categoryId]).catch(() => undefined);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await closeDatabase();
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});