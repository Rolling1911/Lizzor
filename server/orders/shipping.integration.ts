import assert from "node:assert/strict";
import { closeDatabase, getDatabasePool } from "../db/client.js";
import { addItem } from "../cart/service.js";
import { createOrder, validateCheckout } from "./service.js";
import { createPayment } from "../payments/service.js";
import { assertMutableIntegrationTestDatabase } from "../testing/database-safety.js";
import { saveShippingRule } from "../suppliers/toonies-service.js";

const pool = getDatabasePool();
const suffix = `${Date.now().toString(36)}${Math.random().toString(16).slice(2, 8)}`;
const marker = `ship-${suffix}`;
const address = {
  firstName: "Shipping", lastName: "Tester", addressLine1: "1 Test Street",
  city: "Nicosia", postalCode: "1000", countryCode: "DE",
};
const sessions: string[] = [];
const orderIds: string[] = [];
const productIds: string[] = [];
const variantIds: string[] = [];
const inventoryIds: string[] = [];
const warehouseIds: string[] = [];
const catalogueIds: string[] = [];
const catalogueVariantIds: string[] = [];
const linkIds: string[] = [];
const ruleIds: string[] = [];
let categoryId = "";
let supplierId = "";
let createdSupplierId = "";

assertMutableIntegrationTestDatabase("shipping integration");

async function setupFixtures() {
  const client = await pool.connect();
  let tooniesProduct = "";
  let tooniesVariant = "";
  let secondTooniesProduct = "";
  let secondTooniesVariant = "";
  let genericProduct = "";
  try {
    await client.query("BEGIN");
    supplierId = (await client.query("SELECT id FROM suppliers WHERE slug='toonies' AND active=true LIMIT 1")).rows[0]?.id;
    if (!supplierId) {
      supplierId = (await client.query(
        "INSERT INTO suppliers(name,slug,active,publication_enabled,compliance_excluded) VALUES($1,'toonies',true,false,true) RETURNING id",
        [`${marker} Toonies`],
      )).rows[0].id;
      createdSupplierId = supplierId;
    }
    categoryId = (await client.query(
      "INSERT INTO categories(name,slug,description,active) VALUES($1,$2,$3,true) RETURNING id",
      [`${marker} Category`, marker, marker],
    )).rows[0].id;
    tooniesProduct = (await client.query(
      `INSERT INTO products(name,slug,parent_sku,category_id,description,cost_price,base_price,vat_rate,vat_classified_at,weight,status,published_at)
       VALUES($1,$2,$3,$4,$5,4,10,0,now(),0,'active',now()) RETURNING id`,
      [`${marker} Toonies`, `${marker}-toonies`, `${marker}-toonies-sku`, categoryId, marker],
    )).rows[0].id;
    productIds.push(tooniesProduct);
    tooniesVariant = (await client.query(
      "INSERT INTO product_variants(product_id,sku,title,cost_price,base_price,weight,active) VALUES($1,$2,$3,4,10,.5,true) RETURNING id",
      [tooniesProduct, `${marker}-toonies-variant`, `${marker} SKU`],
    )).rows[0].id;
    variantIds.push(tooniesVariant);
    secondTooniesProduct = (await client.query(
      `INSERT INTO products(name,slug,parent_sku,category_id,description,cost_price,base_price,vat_rate,vat_classified_at,weight,status,published_at)
       VALUES($1,$2,$3,$4,$5,2,10,0,now(),0,'active',now()) RETURNING id`,
      [`${marker} Toonies Two`, `${marker}-toonies-two`, `${marker}-toonies-two-sku`, categoryId, marker],
    )).rows[0].id;
    productIds.push(secondTooniesProduct);
    secondTooniesVariant = (await client.query(
      "INSERT INTO product_variants(product_id,sku,title,cost_price,base_price,weight,active) VALUES($1,$2,$3,2,10,.9,true) RETURNING id",
      [secondTooniesProduct, `${marker}-toonies-two-variant`, `${marker} SKU Two`],
    )).rows[0].id;
    variantIds.push(secondTooniesVariant);
    genericProduct = (await client.query(
      `INSERT INTO products(name,slug,parent_sku,category_id,description,cost_price,base_price,vat_rate,weight,status,published_at)
       VALUES($1,$2,$3,$4,$5,3,7,0,.5,'active',now()) RETURNING id`,
      [`${marker} Generic`, `${marker}-generic`, `${marker}-generic-sku`, categoryId, marker],
    )).rows[0].id;
    productIds.push(genericProduct);

    const warehouse = (await client.query(
      "INSERT INTO warehouses(name,code,country_code) VALUES($1,$2,'DE') RETURNING id",
      [`${marker} Warehouse`, `${marker}-warehouse`],
    )).rows[0].id;
    warehouseIds.push(warehouse);
    for (const [productId, variantId] of [[tooniesProduct, tooniesVariant], [secondTooniesProduct, secondTooniesVariant], [genericProduct, null] as const]) {
      const inventory = (await client.query(
        `INSERT INTO inventory(warehouse_id,product_id,variant_id,quantity_on_hand,quantity_reserved,low_stock_threshold)
         VALUES($1,$2,$3,100,0,1) RETURNING id`,
        [warehouse, variantId ? null : productId, variantId],
      )).rows[0].id;
      inventoryIds.push(inventory);
    }

    const catalogue = (await client.query(
      `INSERT INTO supplier_catalogue_items(supplier_id,external_product_id,title,original_amount,original_currency,normalized_eur,stock,minimum_order_quantity)
       VALUES($1,$2,$3,1,'CNY',.5,100,1) RETURNING id`,
      [supplierId, `${marker}-catalogue`, `${marker} Catalogue`],
    )).rows[0].id;
    catalogueIds.push(catalogue);
    const catalogueVariant = (await client.query(
      `INSERT INTO supplier_catalogue_variants(supplier_id,catalogue_item_id,external_variant_id,sku_code,title,original_amount,original_currency,normalized_eur,stock,weight_kg,minimum_order_quantity)
       VALUES($1,$2,$3,$4,$5,1,'CNY',.5,100,.499,1) RETURNING id`,
      [supplierId, catalogue, `${marker}-external-variant`, `${marker}-sku`, `${marker} SKU`],
    )).rows[0].id;
    catalogueVariantIds.push(catalogueVariant);
    const link = (await client.query(
      "INSERT INTO supplier_product_links(supplier_id,catalogue_item_id,catalogue_variant_id,product_id,variant_id) VALUES($1,$2,$3,$4,$5) RETURNING id",
      [supplierId, catalogue, catalogueVariant, tooniesProduct, tooniesVariant],
    )).rows[0].id;
    linkIds.push(link);
    const secondCatalogueVariant = (await client.query(
      `INSERT INTO supplier_catalogue_variants(supplier_id,catalogue_item_id,external_variant_id,sku_code,title,original_amount,original_currency,normalized_eur,stock,weight_kg,minimum_order_quantity)
       VALUES($1,$2,$3,$4,$5,1,'CNY',.5,100,.2,1) RETURNING id`,
      [supplierId, catalogue, `${marker}-external-variant-two`, `${marker}-sku-two`, `${marker} SKU Two`],
    )).rows[0].id;
    catalogueVariantIds.push(secondCatalogueVariant);
    const secondLink = (await client.query(
      "INSERT INTO supplier_product_links(supplier_id,catalogue_item_id,catalogue_variant_id,product_id,variant_id) VALUES($1,$2,$3,$4,$5) RETURNING id",
      [supplierId, catalogue, secondCatalogueVariant, secondTooniesProduct, secondTooniesVariant],
    )).rows[0].id;
    linkIds.push(secondLink);
    for (const [min, max, amount, minDays, maxDays] of [
      [0, .5, 10, 2, 4],
      [.5, 1, 20, 5, 7],
      [1, null, 30, 8, 10],
    ] as const) {
      const rule = (await client.query(
        `INSERT INTO supplier_shipping_rules(supplier_id,country_code,min_weight_kg,max_weight_kg,amount_eur,min_delivery_days,max_delivery_days,temporary,active)
         VALUES($1,'DE',$2,$3,$4,$5,$6,true,true) RETURNING id`,
        [supplierId, min, max, amount, minDays, maxDays],
      )).rows[0].id;
      ruleIds.push(rule);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
    return { tooniesProduct, tooniesVariant, secondTooniesProduct, secondTooniesVariant, genericProduct };
}

async function cleanupFixtures() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (orderIds.length) {
      await client.query("DELETE FROM notification_deliveries WHERE metadata_json->>'orderId'=ANY($1::text[])", [orderIds]);
      await client.query("DELETE FROM notifications WHERE data_json->>'orderId'=ANY($1::text[])", [orderIds]);
      await client.query("DELETE FROM audit_logs WHERE entity_id=ANY($1::uuid[])", [orderIds]);
      await client.query("DELETE FROM inventory_movements WHERE reference_id=ANY($1::uuid[])", [orderIds]);
      await client.query("DELETE FROM inventory_reservations WHERE order_id=ANY($1::uuid[])", [orderIds]);
      await client.query("DELETE FROM payments WHERE order_id=ANY($1::uuid[])", [orderIds]);
      await client.query("DELETE FROM orders WHERE id=ANY($1::uuid[])", [orderIds]);
    }
    if (sessions.length) await client.query("DELETE FROM carts WHERE guest_session_id=ANY($1::text[])", [sessions]);
    if (linkIds.length) await client.query("DELETE FROM supplier_product_links WHERE id=ANY($1::uuid[])", [linkIds]);
    if (catalogueVariantIds.length) await client.query("DELETE FROM supplier_catalogue_variants WHERE id=ANY($1::uuid[])", [catalogueVariantIds]);
    if (catalogueIds.length) await client.query("DELETE FROM supplier_catalogue_items WHERE id=ANY($1::uuid[])", [catalogueIds]);
    if (ruleIds.length) await client.query("DELETE FROM supplier_shipping_rules WHERE id=ANY($1::uuid[])", [ruleIds]);
    if (inventoryIds.length) await client.query("DELETE FROM inventory WHERE id=ANY($1::uuid[])", [inventoryIds]);
    if (warehouseIds.length) await client.query("DELETE FROM warehouses WHERE id=ANY($1::uuid[])", [warehouseIds]);
    if (variantIds.length) await client.query("DELETE FROM product_variants WHERE id=ANY($1::uuid[])", [variantIds]);
    if (productIds.length) await client.query("DELETE FROM products WHERE id=ANY($1::uuid[])", [productIds]);
    if (categoryId) await client.query("DELETE FROM categories WHERE id=$1", [categoryId]);
    if (createdSupplierId) await client.query("DELETE FROM suppliers WHERE id=$1", [createdSupplierId]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function run() {
  const fixture = await setupFixtures();
  try {
    const unavailableSession = `${marker}-unavailable`;
    sessions.push(unavailableSession);
    await addItem({ guestSessionId: unavailableSession }, { productId: fixture.tooniesProduct, variantId: fixture.tooniesVariant, quantity: 1 });
    await assert.rejects(
      () => validateCheckout({ guestSessionId: unavailableSession }, { ...address, countryCode: "FR" }),
      (error: any) => error?.code === "SHIPPING_UNAVAILABLE" && error.message === "Shipping is currently unavailable for this destination/order.",
    );
    await assert.rejects(
      () => createOrder({ guestSessionId: unavailableSession }, {
        email: `${unavailableSession}@example.com`, billingAddress: address, shippingAddress: { ...address, countryCode: "FR" },
        idempotencyKey: `${unavailableSession}-order`,
      }),
      (error: any) => error?.code === "SHIPPING_UNAVAILABLE" && error.message === "Shipping is currently unavailable for this destination/order.",
    );
    await pool.query("UPDATE supplier_catalogue_variants SET weight_kg=NULL WHERE id=$1", [catalogueVariantIds[0]]);
    await assert.rejects(
      () => validateCheckout({ guestSessionId: unavailableSession }, address),
      (error: any) => error?.code === "SHIPPING_UNAVAILABLE" && error.message === "Shipping is currently unavailable for this destination/order.",
    );
    await pool.query("UPDATE supplier_catalogue_variants SET weight_kg=0 WHERE id=$1", [catalogueVariantIds[0]]);
    await assert.rejects(
      () => validateCheckout({ guestSessionId: unavailableSession }, address),
      (error: any) => error?.code === "SHIPPING_UNAVAILABLE" && error.message === "Shipping is currently unavailable for this destination/order.",
    );
    await pool.query("UPDATE supplier_catalogue_variants SET weight_kg=.499 WHERE id=$1", [catalogueVariantIds[0]]);

    const boundarySession = `${marker}-boundary`;
    sessions.push(boundarySession);
    await addItem({ guestSessionId: boundarySession }, { productId: fixture.tooniesProduct, variantId: fixture.tooniesVariant, quantity: 1 });
    const belowBoundary = await validateCheckout({ guestSessionId: boundarySession }, address);
    assert.equal(belowBoundary.shippingTotal, 10);
    await pool.query("UPDATE supplier_catalogue_variants SET weight_kg=.5 WHERE id=$1", [catalogueVariantIds[0]]);
    const exactBoundary = await validateCheckout({ guestSessionId: boundarySession }, address);
    assert.equal(exactBoundary.shippingTotal, 20);

    const exactDecimalRuleA = await saveShippingRule({
      countryCode: "CY", minWeightKg: 0, maxWeightKg: .3, amountEur: 11,
      minDeliveryDays: 2, maxDeliveryDays: 4, temporary: true, active: true, expiresAt: null,
    });
    const exactDecimalRuleB = await saveShippingRule({
      countryCode: "CY", minWeightKg: .3, maxWeightKg: 1, amountEur: 22,
      minDeliveryDays: 5, maxDeliveryDays: 7, temporary: true, active: true, expiresAt: null,
    });
    ruleIds.push(exactDecimalRuleA!, exactDecimalRuleB!);
    await pool.query("UPDATE supplier_catalogue_variants SET weight_kg=.1 WHERE id=$1", [catalogueVariantIds[0]]);
    const exactDecimalSession = `${marker}-exact-decimal`;
    sessions.push(exactDecimalSession);
    await addItem({ guestSessionId: exactDecimalSession }, { productId: fixture.tooniesProduct, variantId: fixture.tooniesVariant, quantity: 3 });
    const exactDecimalValidation = await validateCheckout({ guestSessionId: exactDecimalSession }, { ...address, countryCode: "CY" });
    assert.equal(exactDecimalValidation.shippingTotal, 22, "0.100kg x 3 must match the exact 0.300kg half-open band");
    assert.equal(exactDecimalValidation.shippingSnapshot.authoritativeWeightKg, .3);
    const exactDecimalOrder = await createOrder({ guestSessionId: exactDecimalSession }, {
      email: `${exactDecimalSession}@example.com`,
      billingAddress: { ...address, countryCode: "CY" },
      shippingAddress: { ...address, countryCode: "CY" },
      idempotencyKey: `${exactDecimalSession}-order`,
      expectedGrandTotal: 52,
    });
    orderIds.push(exactDecimalOrder.order.id);
    assert.ok(exactDecimalOrder.order.shippingSnapshot);
    assert.equal(exactDecimalOrder.order.shippingSnapshot!.authoritativeWeightKg, .3);
    assert.equal(exactDecimalOrder.order.shippingSnapshot!.chargedAmount, 22);
    await pool.query("UPDATE supplier_catalogue_variants SET weight_kg=.5 WHERE id=$1", [catalogueVariantIds[0]]);

    const mixedSession = `${marker}-mixed`;
    sessions.push(mixedSession);
    await addItem({ guestSessionId: mixedSession }, { productId: fixture.tooniesProduct, variantId: fixture.tooniesVariant, quantity: 1 });
    await addItem({ guestSessionId: mixedSession }, { productId: fixture.secondTooniesProduct, variantId: fixture.secondTooniesVariant, quantity: 2 });
    await addItem({ guestSessionId: mixedSession }, { productId: fixture.genericProduct, quantity: 1 });
    const mixed = await validateCheckout({ guestSessionId: mixedSession }, address);
    assert.equal(mixed.shippingTotal, 30, "combined 1.4kg must select one combined rule, not sum two line quotes");
    assert.equal(mixed.shippingSnapshot.authoritativeWeightKg, 1.4);
    const wrongExpected = await validateCheckout({ guestSessionId: mixedSession }, address, 37);
    assert.equal(wrongExpected.valid, false);
    assert.equal(wrongExpected.priceChanged, true);
    await assert.rejects(
      () => createOrder({ guestSessionId: mixedSession }, {
         email: `${mixedSession}@example.com`, billingAddress: address, shippingAddress: address,
         idempotencyKey: `${mixedSession}-wrong-total`, expectedGrandTotal: 37,
      }),
      (error: any) => error?.code === "CHECKOUT_TOTAL_CHANGED",
    );
    const raceSession = `${marker}-checkout-rate-race`;
    sessions.push(raceSession);
    await addItem({ guestSessionId: raceSession }, { productId: fixture.tooniesProduct, variantId: fixture.tooniesVariant, quantity: 3 });
    const updatedRate = saveShippingRule({
      countryCode: "DE", minWeightKg: 1, maxWeightKg: null, amountEur: 31,
      minDeliveryDays: 8, maxDeliveryDays: 10, temporary: true, active: true, expiresAt: null,
    }, ruleIds[2]);
    const raced = await Promise.allSettled([
      createOrder({ guestSessionId: raceSession }, {
        email: `${raceSession}@example.com`, billingAddress: address, shippingAddress: address,
        idempotencyKey: `${raceSession}-order`,
      }),
      updatedRate,
    ]);
    let raceCheckoutResult: PromiseSettledResult<any> = raced[0];
    if (raceCheckoutResult.status === "rejected" && ["40001", "CHECKOUT_RETRY"].includes((raceCheckoutResult.reason as any)?.code)) {
      raceCheckoutResult = (await Promise.allSettled([
        createOrder({ guestSessionId: raceSession }, {
          email: `${raceSession}@example.com`, billingAddress: address, shippingAddress: address,
          idempotencyKey: `${raceSession}-order-retry`,
        }),
        Promise.resolve(),
      ]))[0];
    }
    assert.equal(raceCheckoutResult.status, "fulfilled", "checkout must complete during a concurrent rate edit");
    const raceOrder = (raceCheckoutResult as PromiseFulfilledResult<any>).value;
    orderIds.push(raceOrder.order.id);
    const raceSnapshot = raceOrder.order.shippingSnapshot;
    assert.ok(raceSnapshot);
    assert.ok([30, 31].includes(raceSnapshot.quotedAmount));
    assert.equal(raceSnapshot.quotedAmount, raceSnapshot.chargedAmount);
    assert.equal(raceSnapshot.provider, "toonies_temporary");
    await saveShippingRule({
      countryCode: "DE", minWeightKg: 1, maxWeightKg: null, amountEur: 30,
      minDeliveryDays: 8, maxDeliveryDays: 10, temporary: true, active: true, expiresAt: null,
    }, ruleIds[2]);
    const created = await createOrder({ guestSessionId: mixedSession }, {
      email: `${mixedSession}@example.com`, billingAddress: address, shippingAddress: address,
         idempotencyKey: `${mixedSession}-order`, expectedGrandTotal: 67,
    });
    orderIds.push(created.order.id);
    const snapshot = created.order.shippingSnapshot;
    assert.ok(snapshot);
    assert.equal(snapshot.ruleId, ruleIds[2]);
    assert.equal(snapshot.provider, "toonies_temporary");
    assert.equal(snapshot.source, "temporary_supplier_rule");
    assert.equal(snapshot.authoritativeWeightKg, 1.4);
    assert.equal(snapshot.quotedAmount, 30);
    assert.equal(snapshot.chargedAmount, 30);
    assert.equal(snapshot.minDeliveryDays, 8);
    assert.equal(snapshot.maxDeliveryDays, 10);
    const persisted = (await pool.query(
      `SELECT shipping_rule_id AS "ruleId",shipping_provider AS provider,shipping_source AS source,shipping_weight_kg AS weight,
              shipping_quoted_total AS quoted,shipping_charged_total AS charged,shipping_min_delivery_days AS "minDays",shipping_max_delivery_days AS "maxDays"
         FROM orders WHERE id=$1`,
      [created.order.id],
    )).rows[0];
    assert.equal(persisted.ruleId, ruleIds[2]);
    assert.equal(persisted.provider, "toonies_temporary");
    assert.equal(Number(persisted.weight), 1.4);
    assert.equal(Number(persisted.quoted), 30);
    assert.equal(Number(persisted.charged), 30);
    assert.equal(Number(persisted.minDays), 8);
    assert.equal(Number(persisted.maxDays), 10);
    await pool.query("DELETE FROM supplier_shipping_rules WHERE id=$1", [ruleIds[2]]);
    assert.equal((await pool.query("SELECT shipping_rule_id FROM orders WHERE id=$1", [created.order.id])).rows[0].shipping_rule_id, ruleIds[2], "shipping rule snapshot must survive source deletion");

    const payment = await createPayment(created.order.id, { guestSessionId: mixedSession, guestAccessToken: created.guestAccessToken }, `${marker}-payment`);
    assert.equal(payment.payment.amount, 67, "provider/payment amount must use locked grand total including shipping");
    assert.equal(Number((await pool.query("SELECT grand_total FROM orders WHERE id=$1", [created.order.id])).rows[0].grand_total), 67);

    const inactiveSupplierSession = `${marker}-inactive-supplier`;
    sessions.push(inactiveSupplierSession);
    await addItem({ guestSessionId: inactiveSupplierSession }, { productId: fixture.tooniesProduct, variantId: fixture.tooniesVariant, quantity: 1 });
    await pool.query("UPDATE suppliers SET active=false WHERE id=$1", [supplierId]);
    await assert.rejects(
      () => validateCheckout({ guestSessionId: inactiveSupplierSession }, address),
      (error: any) => error?.code === "SHIPPING_UNAVAILABLE",
    );
    await assert.rejects(
      () => createOrder({ guestSessionId: inactiveSupplierSession }, {
        email: `${inactiveSupplierSession}@example.com`,
        billingAddress: address,
        shippingAddress: address,
        idempotencyKey: `${inactiveSupplierSession}-order`,
      }),
      (error: any) => error?.code === "SHIPPING_UNAVAILABLE",
    );
    await pool.query("UPDATE suppliers SET active=true WHERE id=$1", [supplierId]);

    const duplicateCatalogueVariant = (await pool.query<{ id: string }>(
      `INSERT INTO supplier_catalogue_variants
        (supplier_id,catalogue_item_id,external_variant_id,sku_code,title,original_amount,original_currency,stock,weight_kg,minimum_order_quantity)
       VALUES($1,$2,$3,$4,$5,1,'CNY',100,.25,1) RETURNING id`,
      [supplierId, catalogueIds[0], `${marker}-duplicate-external`, `${marker}-duplicate-sku`, `${marker} Duplicate SKU`],
    )).rows[0].id;
    catalogueVariantIds.push(duplicateCatalogueVariant);
    const duplicateLink = (await pool.query<{ id: string }>(
      `INSERT INTO supplier_product_links
        (supplier_id,catalogue_item_id,catalogue_variant_id,product_id,variant_id)
       VALUES($1,$2,$3,$4,$5) RETURNING id`,
      [supplierId, catalogueIds[0], duplicateCatalogueVariant, fixture.tooniesProduct, fixture.tooniesVariant],
    )).rows[0].id;
    linkIds.push(duplicateLink);
    const duplicateMappingSession = `${marker}-duplicate-mapping`;
    sessions.push(duplicateMappingSession);
    await addItem({ guestSessionId: duplicateMappingSession }, { productId: fixture.tooniesProduct, variantId: fixture.tooniesVariant, quantity: 1 });
    await assert.rejects(
      () => validateCheckout({ guestSessionId: duplicateMappingSession }, address),
      (error: any) => error?.code === "SHIPPING_UNAVAILABLE",
    );
    await assert.rejects(
      () => createOrder({ guestSessionId: duplicateMappingSession }, {
        email: `${duplicateMappingSession}@example.com`,
        billingAddress: address,
        shippingAddress: address,
        idempotencyKey: `${duplicateMappingSession}-order`,
      }),
      (error: any) => error?.code === "SHIPPING_UNAVAILABLE",
    );
    console.info("Toonies temporary shipping, mixed-cart, snapshot, and payment amount checks passed.");
  } finally {
    await cleanupFixtures();
    await closeDatabase();
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});