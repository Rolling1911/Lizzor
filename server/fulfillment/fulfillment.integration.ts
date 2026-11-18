import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { hashOpaqueToken } from "../auth/tokens.js";
import { closeDatabase, getDatabasePool } from "../db/client.js";
import { createReturn, createShipment, getOrderTracking, listCustomerReturns, listFulfillment, quoteShipping, receiveReturn, saveShippingRule, saveShippingZone, transitionFulfillment, updateReturn, updateShipment } from "./service.js";

const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
const marker = `fulfillment-${suffix}`;
const address = { firstName: "Test", lastName: "Buyer", addressLine1: "1 Test Street", city: "Nicosia", postalCode: "1000", countryCode: "CY" };

async function assertCustomerDeliveryRouting(
  pool: ReturnType<typeof getDatabasePool>,
  orderId: string,
  expectedEmail: string,
  recipientKind: "account" | "email",
  expectedCounts: Record<string, number>,
) {
  const eventTypes = Object.keys(expectedCounts);
  const deliveries = (await pool.query(
    `SELECT event_type AS "eventType",recipient_email AS email,metadata_json->>'recipientKind' AS "recipientKind"
       FROM notification_deliveries
      WHERE channel='email' AND metadata_json->>'orderId'=$1 AND event_type=ANY($2::varchar[])
      ORDER BY event_type,id`,
    [orderId, eventTypes],
  )).rows;
  assert.equal(
    deliveries.length,
    Object.values(expectedCounts).reduce((total, count) => total + count, 0),
    "each real fulfillment event must create exactly one customer email delivery",
  );
  for (const [eventType, expectedCount] of Object.entries(expectedCounts)) {
    const routed = deliveries.filter((delivery) => delivery.eventType === eventType);
    assert.equal(routed.length, expectedCount, `${eventType} must produce the expected customer deliveries`);
    assert.ok(
      routed.every((delivery) => delivery.email === expectedEmail && delivery.recipientKind === recipientKind),
      `${eventType} must route only to the order owner's canonical email, never another customer or admin`,
    );
  }
}

async function assertOrderNotFound(operation: () => Promise<unknown>) {
  await assert.rejects(operation, (error: any) => error?.statusCode === 404 && error?.code === "ORDER_NOT_FOUND");
}

async function run() {
  const pool = getDatabasePool();
  let userId = ""; let categoryId = ""; let productId = ""; let variantId = ""; let warehouseId = ""; let orderId = ""; let unpaidOrderId = ""; let guestOrderId = ""; let guestOtherOrderId = ""; let personalOrderId = ""; let companyOrderId = ""; let zoneId = "";
  const accessUserIds: string[] = [];
  const accessCompanyIds: string[] = [];
  try {
    const userEmail = `${marker}@example.com`;
    const guestEmail = `${marker}-guest@example.com`;
    const guestSessionId = randomUUID();
    const guestAccessToken = randomUUID();
    userId = (await pool.query("INSERT INTO users (email,first_name,last_name,status,email_verified_at) VALUES ($1,'Fulfillment','Tester','active',now()) RETURNING id", [userEmail])).rows[0].id;
    categoryId = (await pool.query("INSERT INTO categories (name,slug) VALUES ($1,$2) RETURNING id", [marker, marker])).rows[0].id;
    productId = (await pool.query("INSERT INTO products (name,slug,parent_sku,category_id,description,cost_price,base_price,vat_rate,weight,status) VALUES ($1,$2,$3,$4,$5,5,10,19,2,'active') RETURNING id", [marker, `${marker}-product`, `${marker}-sku`, categoryId, marker])).rows[0].id;
    variantId = (await pool.query("INSERT INTO product_variants (product_id,sku,title,weight,active) VALUES ($1,$2,'Case',1.5,true) RETURNING id", [productId, `${marker}-variant`])).rows[0].id;
    warehouseId = (await pool.query("INSERT INTO warehouses (name,code,country_code) VALUES ($1,$2,'CY') RETURNING id", [marker, marker.slice(-40)])).rows[0].id;
    await pool.query("INSERT INTO inventory (warehouse_id,variant_id,quantity_on_hand) VALUES ($1,$2,10)", [warehouseId, variantId]);
    orderId = (await pool.query(`INSERT INTO orders (order_number,user_id,status,payment_status,subtotal,grand_total,billing_address_snapshot,shipping_address_snapshot) VALUES ($1,$2,'confirmed','paid',20,20,$3,$3) RETURNING id`, [`LZ-${suffix}-paid`, userId, address])).rows[0].id;
    unpaidOrderId = (await pool.query(`INSERT INTO orders (order_number,user_id,status,payment_status,subtotal,grand_total,billing_address_snapshot,shipping_address_snapshot) VALUES ($1,$2,'pending','pending',10,10,$3,$3) RETURNING id`, [`LZ-${suffix}-unpaid`, userId, address])).rows[0].id;
    const itemId = (await pool.query(`INSERT INTO order_items (order_id,product_id,variant_id,sku_snapshot,product_name_snapshot,variant_name_snapshot,quantity,unit_price,cost_price_snapshot,tax_rate_snapshot,line_total) VALUES ($1,$2,$3,$4,$5,'Case',2,10,5,19,20) RETURNING id`, [orderId, productId, variantId, `${marker}-variant`, marker])).rows[0].id;

    await assert.rejects(() => transitionFulfillment(unpaidOrderId, "processing", userId), /paid/i);
    assert.equal((await transitionFulfillment(orderId, "processing", userId)).fulfillmentStage, "processing");
    await assert.rejects(() => transitionFulfillment(orderId, "shipped", userId), /not allowed/i);
    assert.equal((await transitionFulfillment(orderId, "packed", userId)).fulfillmentStage, "packed");
    const shipment = await createShipment(orderId, { courier: "Test Courier", trackingNumber: marker, trackingUrl: "https://example.com/track" }, userId);
    await updateShipment(shipment.id, { status: "shipped" }, userId);
    const secondShipment = await createShipment(orderId, { courier: "Second Courier", trackingNumber: `${marker}-2` }, userId);
    await updateShipment(secondShipment.id, { status: "shipped" }, userId);
    const queueOrder = (await listFulfillment({ search: marker })).items.find((item) => item.id === orderId);
    assert.equal(queueOrder?.shipments.length, 2);
    assert.deepEqual(queueOrder?.shipments.map((item: any) => item.id), [shipment.id, secondShipment.id]);
    assert.equal((await getOrderTracking(orderId, { userId })).shipments[0].status, "shipped");
    await updateShipment(shipment.id, { status: "in_transit" }, userId);
    await updateShipment(shipment.id, { status: "delivered" }, userId);
    assert.equal((await pool.query("SELECT fulfillment_stage AS stage FROM orders WHERE id=$1", [orderId])).rows[0].stage, "shipped");
    await updateShipment(secondShipment.id, { status: "delivered" }, userId);
    assert.equal((await pool.query("SELECT fulfillment_stage AS stage,status FROM orders WHERE id=$1", [orderId])).rows[0].stage, "delivered");
    await updateShipment(shipment.id, { status: "returned" }, userId);
    assert.equal((await pool.query("SELECT fulfillment_stage AS stage FROM orders WHERE id=$1", [orderId])).rows[0].stage, "delivered");
    await updateShipment(secondShipment.id, { status: "returned" }, userId);
    const reopened = (await pool.query("SELECT fulfillment_stage AS stage,fulfillment_status AS \"fulfillmentStatus\",status FROM orders WHERE id=$1", [orderId])).rows[0];
    assert.deepEqual(reopened, { stage: "packed", fulfillmentStatus: "partially_fulfilled", status: "processing" });
    const replacement = await createShipment(orderId, { courier: "Replacement Courier", trackingNumber: `${marker}-3` }, userId);
    await updateShipment(replacement.id, { status: "cancelled" }, userId);
    assert.equal((await pool.query("SELECT fulfillment_stage AS stage FROM orders WHERE id=$1", [orderId])).rows[0].stage, "packed");
    const deliveredReplacement = await createShipment(orderId, { courier: "Replacement Courier", trackingNumber: `${marker}-4` }, userId);
    await updateShipment(deliveredReplacement.id, { status: "shipped" }, userId);
    await updateShipment(deliveredReplacement.id, { status: "delivered" }, userId);
    assert.equal((await pool.query("SELECT fulfillment_stage AS stage FROM orders WHERE id=$1", [orderId])).rows[0].stage, "delivered");
    const timeline = (await getOrderTracking(orderId, { userId })).timeline.map((event) => event.status);
    assert.equal(timeline[0], "processing");
    assert.equal(timeline[1], "packed");
    assert.ok(timeline.filter((status) => status === "shipped").length >= 2);
    assert.ok(timeline.filter((status) => status === "delivered").length >= 2);

    // Company-wide fulfillment access is restricted to active owners/admins;
    // a direct order owner remains able to access their own order.
    const createAccessUser = async (name: string) => {
      const id = (await pool.query(
        "INSERT INTO users (email,first_name,last_name,status,email_verified_at) VALUES ($1,$2,'Access','active',now()) RETURNING id",
        [`${marker}-${name}@example.com`, name],
      )).rows[0].id as string;
      accessUserIds.push(id);
      return id;
    };
    const createAccessCompany = async (name: string, status: "active" | "deactivated" = "active") => {
      const vatNumber = `VAT-${name}-${accessCompanyIds.length}-${suffix.slice(-12)}`;
      const id = (await pool.query(
        "INSERT INTO companies (company_name,vat_number,contact_person,email,status) VALUES ($1,$2,'Access',$3,$4) RETURNING id",
        [`${marker}-${name}`, vatNumber, `${marker}-${name}@example.com`, status],
      )).rows[0].id as string;
      accessCompanyIds.push(id);
      return id;
    };
    const companyOwner = await createAccessUser("company-owner");
    const companyAdmin = await createAccessUser("company-admin");
    const companyBuyer = await createAccessUser("company-buyer");
    const companyViewer = await createAccessUser("company-viewer");
    const suspendedOwner = await createAccessUser("suspended-owner");
    const otherCompanyOwner = await createAccessUser("other-company-owner");
    const personalOwner = await createAccessUser("personal-owner");
    const personalOtherUser = await createAccessUser("personal-other-user");
    const companyId = await createAccessCompany("access-company");
    const otherCompanyId = await createAccessCompany("other-company");
    await pool.query(
      `INSERT INTO company_users (company_id,user_id,role,status) VALUES
        ($1,$2,'owner','active'),($1,$3,'admin','active'),($1,$4,'buyer','active'),
        ($1,$5,'viewer','active'),($1,$6,'owner','suspended'),($7,$8,'owner','active')`,
      [companyId, companyOwner, companyAdmin, companyBuyer, companyViewer, suspendedOwner, otherCompanyId, otherCompanyOwner],
    );
    companyOrderId = (await pool.query(
      `INSERT INTO orders (order_number,user_id,company_id,status,payment_status,subtotal,grand_total,billing_address_snapshot,shipping_address_snapshot)
       VALUES ($1,$2,$3,'confirmed','paid',10,10,$4,$4) RETURNING id`,
      [`LZ-${suffix}-company`, userId, companyId, address],
    )).rows[0].id;
    personalOrderId = (await pool.query(
      `INSERT INTO orders (order_number,user_id,status,payment_status,subtotal,grand_total,billing_address_snapshot,shipping_address_snapshot)
       VALUES ($1,$2,'confirmed','paid',10,10,$3,$3) RETURNING id`,
      [`LZ-${suffix}-personal`, personalOwner, address],
    )).rows[0].id;
    assert.equal((await getOrderTracking(companyOrderId, { userId: companyOwner })).shipments.length, 0);
    assert.equal((await getOrderTracking(companyOrderId, { userId: companyAdmin })).shipments.length, 0);
    await assertOrderNotFound(() => getOrderTracking(companyOrderId, { userId: companyBuyer }));
    await assertOrderNotFound(() => getOrderTracking(companyOrderId, { userId: companyViewer }));
    await assertOrderNotFound(() => getOrderTracking(companyOrderId, { userId: suspendedOwner }));
    await assertOrderNotFound(() => getOrderTracking(companyOrderId, { userId: otherCompanyOwner }));
    await assertOrderNotFound(() => getOrderTracking(personalOrderId, { userId: personalOtherUser }));
    await assertOrderNotFound(() => listCustomerReturns(companyOrderId, { userId: companyBuyer }));
    await assertOrderNotFound(() => createReturn(companyOrderId, { userId: companyBuyer }, { reason: "Unauthorized", items: [] }));
    await pool.query("UPDATE companies SET status='deactivated' WHERE id=$1", [companyId]);
    await assertOrderNotFound(() => getOrderTracking(companyOrderId, { userId: companyOwner }));

    zoneId = await saveShippingZone({ name: marker, active: true, countries: ["CY"] });
    await saveShippingRule({ zoneId, minimumOrderValue: 0, maximumOrderValue: null, minimumWeight: 0, maximumWeight: null, shippingPrice: 8, freeShipping: false, active: true, priority: 10 });
    await saveShippingRule({ zoneId, minimumOrderValue: 100, maximumOrderValue: null, minimumWeight: 0, maximumWeight: null, shippingPrice: 0, freeShipping: true, active: true, priority: 1 });
    assert.equal((await quoteShipping({ countryCode: "CY", orderValue: 20, weight: 3 })).shippingPrice, 8);
    assert.equal((await quoteShipping({ countryCode: "CY", orderValue: 120, weight: 3 })).shippingPrice, 0);
    assert.equal((await quoteShipping({ countryCode: "US", orderValue: 20, weight: 3 })).matched, false);

    const evidence = Buffer.from("%PDF-1.7\nprivate return evidence");
    const createdReturn = await createReturn(orderId, { userId }, { reason: "Damaged", items: [{ orderItemId: itemId, quantity: 1 }], attachments: [{ filename: `${randomUUID()}.pdf`, mimeType: "application/pdf", sizeBytes: evidence.length, data: evidence }] });
    await assert.rejects(() => createReturn(orderId, { userId }, { reason: "Duplicate", items: [{ orderItemId: itemId, quantity: 2 }] }), /exceeds/i);
    await updateReturn(createdReturn.id, "in_review", "Inspection needed", userId);
    await updateReturn(createdReturn.id, "approved", "Approved", userId);
    await assert.rejects(() => updateReturn(createdReturn.id, "received", undefined, userId), /not allowed/i);
    const before = Number((await pool.query("SELECT quantity_on_hand AS quantity FROM inventory WHERE warehouse_id=$1 AND variant_id=$2", [warehouseId, variantId])).rows[0].quantity);
    const received = await receiveReturn(createdReturn.id, warehouseId, userId);
    assert.equal(received.quantity, 1);
    assert.equal(Number((await pool.query("SELECT quantity_on_hand AS quantity FROM inventory WHERE warehouse_id=$1 AND variant_id=$2", [warehouseId, variantId])).rows[0].quantity), before + 1);
    assert.equal((await receiveReturn(createdReturn.id, warehouseId, userId)).replayed, true);
    assert.equal(Number((await pool.query("SELECT count(*)::int AS count FROM inventory_movements WHERE reference_type='return_request' AND reference_id=$1", [createdReturn.id])).rows[0].count), 1);
    await updateReturn(createdReturn.id, "completed", undefined, userId);

    await assertCustomerDeliveryRouting(pool, orderId, userEmail, "account", {
      "shipment.created": 4,
      "fulfillment.shipped": 3,
      "fulfillment.delivered": 3,
      "return.requested": 1,
      "return.updated": 3,
    });

    guestOrderId = (await pool.query(
      `INSERT INTO orders
        (order_number,guest_email,guest_session_id,guest_access_token_hash,status,payment_status,fulfillment_status,fulfillment_stage,subtotal,grand_total,billing_address_snapshot,shipping_address_snapshot)
       VALUES ($1,$2,$3,$4,'confirmed','paid','partially_fulfilled','packed',10,10,$5,$5) RETURNING id`,
      [`LZG-${suffix}`, guestEmail, guestSessionId, hashOpaqueToken(guestAccessToken), address],
    )).rows[0].id;
    const guestItemId = (await pool.query(
      `INSERT INTO order_items
        (order_id,product_id,variant_id,sku_snapshot,product_name_snapshot,variant_name_snapshot,quantity,unit_price,cost_price_snapshot,tax_rate_snapshot,line_total)
       VALUES ($1,$2,$3,$4,$5,'Case',1,10,5,19,10) RETURNING id`,
      [guestOrderId, productId, variantId, `${marker}-variant`, marker],
    )).rows[0].id;
    const guestShipment = await createShipment(guestOrderId, { courier: "Guest Courier", trackingNumber: `${marker}-guest` }, userId);
    await updateShipment(guestShipment.id, { status: "shipped" }, userId);
    await updateShipment(guestShipment.id, { status: "delivered" }, userId);
    const guestReturn = await createReturn(
      guestOrderId,
      { guestSessionId, guestAccessToken },
      { reason: "Guest return", items: [{ orderItemId: guestItemId, quantity: 1 }] },
    );
    await updateReturn(guestReturn.id, "in_review", "Guest return review", userId);
    guestOtherOrderId = (await pool.query(
      `INSERT INTO orders
        (order_number,guest_email,guest_session_id,guest_access_token_hash,status,payment_status,subtotal,grand_total,billing_address_snapshot,shipping_address_snapshot)
       VALUES ($1,$2,$3,$4,'confirmed','paid',10,10,$5,$5) RETURNING id`,
      [`LZG-${suffix}-other`, guestEmail, guestSessionId, hashOpaqueToken(randomUUID()), address],
    )).rows[0].id;
    await assertOrderNotFound(() => getOrderTracking(guestOtherOrderId, { guestSessionId, guestAccessToken }));

    await assertCustomerDeliveryRouting(pool, guestOrderId, guestEmail, "email", {
      "shipment.created": 1,
      "fulfillment.shipped": 1,
      "fulfillment.delivered": 1,
      "return.requested": 1,
      "return.updated": 1,
    });
    const crossOrderLeak = Number((await pool.query(
      `SELECT count(*)::int AS count FROM notification_deliveries
        WHERE channel='email'
          AND metadata_json->>'orderId'=ANY($1::text[])
          AND event_type=ANY($2::varchar[])
          AND recipient_email NOT IN ($3,$4)`,
      [[orderId, guestOrderId], ["shipment.created", "fulfillment.shipped", "fulfillment.delivered", "return.requested", "return.updated"], userEmail, guestEmail],
    )).rows[0].count);
    assert.equal(crossOrderLeak, 0, "fulfillment deliveries must not leak to another order, customer, or administrator");
    console.info("Fulfillment, shipping, shipment tracking, and return integration checks passed.");
  } finally {
    const orderIds = [orderId, unpaidOrderId, guestOrderId, guestOtherOrderId, companyOrderId, personalOrderId].filter(Boolean);
    if (orderIds.length) {
      await pool.query("DELETE FROM notification_deliveries WHERE metadata_json->>'orderId'=ANY($1::text[])", [orderIds]);
      await pool.query("DELETE FROM audit_logs WHERE entity_id = ANY($1::uuid[])", [orderIds]);
    }
    for (const cleanupOrderId of [orderId, guestOrderId, companyOrderId, personalOrderId].filter(Boolean)) {
      await pool.query("DELETE FROM inventory_movements WHERE reference_id IN (SELECT id FROM return_requests WHERE order_id=$1)", [cleanupOrderId]);
      await pool.query("DELETE FROM audit_logs WHERE entity_id IN (SELECT id FROM return_requests WHERE order_id=$1) OR entity_id IN (SELECT id FROM shipments WHERE order_id=$1)", [cleanupOrderId]);
      await pool.query("DELETE FROM return_requests WHERE order_id=$1", [cleanupOrderId]);
    }
    if (orderIds.length) await pool.query("DELETE FROM orders WHERE id = ANY($1::uuid[])", [orderIds]);
    if (zoneId) await pool.query("DELETE FROM shipping_zones WHERE id=$1", [zoneId]);
    if (warehouseId) await pool.query("DELETE FROM warehouses WHERE id=$1", [warehouseId]);
    if (productId) await pool.query("DELETE FROM products WHERE id=$1", [productId]);
    if (categoryId) await pool.query("DELETE FROM categories WHERE id=$1", [categoryId]);
    if (accessCompanyIds.length) await pool.query("DELETE FROM company_users WHERE company_id=ANY($1::uuid[])", [accessCompanyIds]);
    if (accessCompanyIds.length) await pool.query("DELETE FROM companies WHERE id=ANY($1::uuid[])", [accessCompanyIds]);
    if (accessUserIds.length) await pool.query("DELETE FROM users WHERE id=ANY($1::uuid[])", [accessUserIds]);
    if (userId) await pool.query("DELETE FROM users WHERE id=$1", [userId]);
    await closeDatabase();
  }
}

run().catch((error) => { console.error(error); process.exitCode = 1; });