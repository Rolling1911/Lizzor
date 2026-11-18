import assert from "node:assert/strict";
import type { Server } from "node:http";
import { closeDatabase, getDatabasePool } from "../db/client.js";
import { createApp } from "../app.js";
import { addItem, applyCoupon, clearCart, getCart, updateItem } from "../cart/service.js";
import { buyAgain, cancelOrder, createOrder, getGuestEmailOrder, getOrder, listCustomerOrders, releaseExpiredReservations, validateCheckout } from "./service.js";
import { replaceTiers } from "../pricing/service.js";
import { createOpaqueToken, hashOpaqueToken } from "../auth/tokens.js";
import { claimGuestOrder } from "../accounts/service.js";
import { hashPassword } from "../auth/password.js";
import { randomUUID } from "node:crypto";
import { orderWeight } from "../fulfillment/service.js";

const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
const marker = `phase5a-${suffix}`;
const address = {
  firstName: "Test", lastName: "Buyer", addressLine1: "1 Test Street", city: "Nicosia",
  postalCode: "1000", countryCode: "CY", phone: "+35700000000",
};

async function assertCancellationDelivery(pool: ReturnType<typeof getDatabasePool>, orderId: string, email: string, recipientKind: "account" | "email") {
  const deliveries = (await pool.query(
    `SELECT recipient_email AS email,metadata_json->>'recipientKind' AS "recipientKind"
       FROM notification_deliveries
      WHERE channel='email' AND event_type='order.cancelled' AND metadata_json->>'orderId'=$1
      ORDER BY id`,
    [orderId],
  )).rows;
  assert.deepEqual(
    deliveries,
    [{ email, recipientKind }],
    "order.cancelled must route only to the owning customer, never another order, customer, or administrator",
  );
}

class Browser {
  private readonly cookies = new Map<string, string>();
  constructor(private readonly baseUrl: string) {}
  cookie(name: string) { return this.cookies.get(name); }
  async request(path: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    headers.set("content-type", "application/json");
    const csrf = this.cookies.get("lizzor_csrf");
    if (csrf && !["GET", "HEAD"].includes(init.method?.toUpperCase() ?? "GET")) headers.set("x-csrf-token", decodeURIComponent(csrf));
    if (this.cookies.size) headers.set("cookie", [...this.cookies].map(([key, value]) => `${key}=${value}`).join("; "));
    const response = await fetch(`${this.baseUrl}/api/v1${path}`, { ...init, headers });
    const getSetCookie = (response.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie;
    const values = getSetCookie ? getSetCookie.call(response.headers) : (response.headers.get("set-cookie")?.split(/,(?=[^;]+?=)/) ?? []);
    for (const value of values) {
      const [pair] = value.split(";");
      const separator = pair.indexOf("=");
      if (separator > 0) this.cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
    }
    const body = await response.json().catch(() => null);
    return { response, body };
  }
}

async function run() {
  const pool = getDatabasePool();
  const app = await createApp({ serveFrontend: false });
  const server: Server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const serverAddress = server.address();
  assert.ok(serverAddress && typeof serverAddress !== "string");
  const baseUrl = `http://127.0.0.1:${serverAddress.port}`;
  let categoryId = "";
  let productId = "";
  let variantId = "";
  let warehouseId = "";
  let visibleCategoryId = "";
  let visibleProductId = "";
  let visibleVariantId = "";
  let visibleWarehouseId = "";
  let moqProductId = "";
  let moqVariantId = "";
  let moqWarehouseId = "";
  let userId = "";
  const shippingZoneIds: string[] = [];
  const campaignIds: string[] = [];
  const orderIds: string[] = [];
  const companyIds: string[] = [];
  const companyUserIds: string[] = [];
  const sessions: Array<{ session: string; token?: string; orderId?: string }> = [];
  try {
    categoryId = (await pool.query("INSERT INTO categories (name,slug,description) VALUES ($1,$2,$3) RETURNING id", [`Phase 5A ${suffix}`, marker, marker])).rows[0].id;
    productId = (await pool.query(`INSERT INTO products (name,slug,parent_sku,category_id,description,cost_price,base_price,vat_rate,weight,status,published_at) VALUES ($1,$2,$3,$4,$5,4,12,19,1,'active',now()) RETURNING id`, [`Phase 5A Product ${suffix}`, `${marker}-product`, `${marker}-sku`, categoryId, marker])).rows[0].id;
    variantId = (await pool.query("INSERT INTO product_variants (product_id,sku,title,cost_price,base_price,active) VALUES ($1,$2,'Case',5,10,true) RETURNING id", [productId, `${marker}-variant`])).rows[0].id;
    warehouseId = (await pool.query("INSERT INTO warehouses (name,code,country_code) VALUES ($1,$2,'CY') RETURNING id", [`Phase 5A ${suffix}`, marker])).rows[0].id;
    await pool.query("INSERT INTO inventory (warehouse_id,variant_id,quantity_on_hand,quantity_reserved,low_stock_threshold) VALUES ($1,$2,30,0,5)", [warehouseId, variantId]);
    visibleCategoryId = (await pool.query("INSERT INTO categories (name,slug,description) VALUES ($1,$2,$3) RETURNING id", [`Phase 5A Visible ${suffix}`, `${marker}-visible`, marker])).rows[0].id;
    visibleProductId = (await pool.query(`INSERT INTO products (name,slug,parent_sku,category_id,description,cost_price,base_price,vat_rate,weight,status,published_at) VALUES ($1,$2,$3,$4,$5,4,12,19,1,'active',now()) RETURNING id`, [`Phase 5A Visible Product ${suffix}`, `${marker}-visible-product`, `${marker}-visible-sku`, visibleCategoryId, marker])).rows[0].id;
    visibleVariantId = (await pool.query("INSERT INTO product_variants (product_id,sku,title,cost_price,base_price,active) VALUES ($1,$2,'Visible Case',5,10,true) RETURNING id", [visibleProductId, `${marker}-visible-variant`])).rows[0].id;
    visibleWarehouseId = (await pool.query("INSERT INTO warehouses (name,code,country_code) VALUES ($1,$2,'CY') RETURNING id", [`Phase 5A Visible ${suffix}`, `${marker}-visible`])).rows[0].id;
    await pool.query("INSERT INTO inventory (warehouse_id,variant_id,quantity_on_hand,quantity_reserved,low_stock_threshold) VALUES ($1,$2,30,0,5)", [visibleWarehouseId, visibleVariantId]);
    await replaceTiers(null, variantId, [
      { minQuantity: 2, maxQuantity: 19, unitPrice: 9, active: true },
      { minQuantity: 20, maxQuantity: null, unitPrice: 8, active: true },
    ]);

    // Isolated MOQ/weight fixture. Keep this separate from the broad commerce
    // fixture so the older quantity-tier coverage remains unchanged.
    moqProductId = (await pool.query(
      `INSERT INTO products (name,slug,parent_sku,category_id,description,cost_price,base_price,vat_rate,weight,minimum_order_quantity,status,published_at)
       VALUES ($1,$2,$3,$4,$5,4,10,19,10,3,'active',now()) RETURNING id`,
      [`${marker} MOQ Product`, `${marker}-moq-product`, `${marker}-moq-parent`, categoryId, marker],
    )).rows[0].id;
    moqVariantId = (await pool.query(
      `INSERT INTO product_variants (product_id,sku,title,weight,minimum_order_quantity,active)
       VALUES ($1,$2,'MOQ Variant',2,5,true) RETURNING id`,
      [moqProductId, `${marker}-moq-variant`],
    )).rows[0].id;
    moqWarehouseId = (await pool.query(
      "INSERT INTO warehouses (name,code,country_code) VALUES ($1,$2,'CY') RETURNING id",
      [`${marker} MOQ Warehouse`, `${marker}-moq-warehouse`],
    )).rows[0].id;
    await pool.query(
      "INSERT INTO inventory (warehouse_id,variant_id,quantity_on_hand,quantity_reserved,low_stock_threshold) VALUES ($1,$2,20,0,5)",
      [moqWarehouseId, moqVariantId],
    );

    await assert.rejects(
      () => addItem({ guestSessionId: `${marker}-moq-parent-rejected` }, { productId: moqProductId, quantity: 2 }),
      (error: any) => error?.code === "MINIMUM_ORDER_QUANTITY_NOT_MET" && error.details?.requiredMinimum === 3,
      "product MOQ must reject a below-minimum cart add",
    );
    const exactParentCart = await addItem(
      { guestSessionId: `${marker}-moq-parent-exact` },
      { productId: moqProductId, quantity: 3 },
    );
    assert.equal(exactParentCart.items[0]!.quantity, 3, "exact product MOQ should succeed");
    assert.equal(exactParentCart.items[0]!.minimumOrderQuantity, 3);

    await assert.rejects(
      () => addItem({ guestSessionId: `${marker}-moq-variant-rejected` }, { productId: moqProductId, variantId: moqVariantId, quantity: 3 }),
      (error: any) => error?.code === "MINIMUM_ORDER_QUANTITY_NOT_MET" && error.details?.requiredMinimum === 5,
      "selected variant MOQ must override the parent MOQ",
    );
    const exactVariantSession = `${marker}-moq-variant-exact`;
    const exactVariantCart = await addItem({ guestSessionId: exactVariantSession }, { productId: moqProductId, variantId: moqVariantId, quantity: 5 });
    assert.equal(exactVariantCart.items[0]!.minimumOrderQuantity, 5);
    assert.equal(exactVariantCart.items[0]!.weightKg, 2);
    assert.equal(exactVariantCart.totals.weightKg, 10, "cart weight must use selected variant weight × quantity");

    const publicProduct = await fetch(`${baseUrl}/api/v1/catalog/products/${marker}-moq-product`);
    assert.equal(publicProduct.status, 200);
    const publicPayload = (await publicProduct.json()).data;
    assert.equal(publicPayload.minimumOrderQuantity, 3);
    assert.equal(publicPayload.variants.find((variant: any) => variant.id === moqVariantId).minimumOrderQuantity, 5);

    const tamperedSession = `${marker}-moq-tampered`;
    sessions.push({ session: tamperedSession });
    await addItem({ guestSessionId: tamperedSession }, { productId: moqProductId, variantId: moqVariantId, quantity: 5 });
    const tamperedCartId = (await pool.query(
      "SELECT c.id FROM carts c WHERE c.guest_session_id=$1 AND c.status='active'",
      [tamperedSession],
    )).rows[0].id;
    await pool.query("UPDATE cart_items SET quantity=1 WHERE cart_id=$1", [tamperedCartId]);
    const invalidCart = await getCart({ guestSessionId: tamperedSession });
    assert.equal(invalidCart.items[0]!.quantityValid, false);
    assert.equal(invalidCart.items[0]!.minimumOrderQuantity, 5);
    assert.equal(invalidCart.hasMinimumQuantityViolations, true);
    assert.equal(invalidCart.validationErrors?.[0]?.requiredMinimum, 5);
    await assert.rejects(
      () => validateCheckout({ guestSessionId: tamperedSession }, address),
      (error: any) => error?.code === "MINIMUM_ORDER_QUANTITY_NOT_MET" && error.details?.requiredMinimum === 5,
      "checkout validation must re-read MOQ instead of trusting the cart row",
    );
    await assert.rejects(
      () => createOrder({ guestSessionId: tamperedSession }, { email: `${tamperedSession}@example.com`, billingAddress: address, shippingAddress: address, idempotencyKey: `${tamperedSession}-order` }),
      (error: any) => error?.code === "MINIMUM_ORDER_QUANTITY_NOT_MET" && error.details?.requiredMinimum === 5,
      "local order creation must reject a tampered below-MOQ cart",
    );

    const exactVariantOrder = await createOrder(
      { guestSessionId: exactVariantSession },
      { email: `${exactVariantSession}@example.com`, billingAddress: address, shippingAddress: address, idempotencyKey: `${exactVariantSession}-order` },
    );
    orderIds.push(exactVariantOrder.order.id);
    assert.equal(await orderWeight(pool, exactVariantOrder.order.id), 10, "fulfillment weight must use selected variant weight × quantity");

    const noPhoneBrowser = new Browser(baseUrl);
    await noPhoneBrowser.request("/cart");
    sessions.push({ session: noPhoneBrowser.cookie("lizzor_guest_cart")! });
    assert.equal((await noPhoneBrowser.request("/cart/items", { method: "POST", body: JSON.stringify({ productId, variantId, quantity: 1 }) })).response.status, 201);
    await pool.query("UPDATE categories SET active=false WHERE id=$1", [categoryId]);
    const hiddenCategoryCart = await getCart({ guestSessionId: sessions[0]!.session });
    assert.equal(hiddenCategoryCart.items.length, 1);
    assert.equal(hiddenCategoryCart.items[0]!.availability, "unavailable");
    assert.equal(hiddenCategoryCart.items[0]!.categoryVisible, false);
    assert.equal(hiddenCategoryCart.totals.subtotal, 0);
    assert.equal(hiddenCategoryCart.totals.grandTotal, 0);
    assert.equal(hiddenCategoryCart.promotions.length, 0);
    await pool.query("UPDATE categories SET active=true WHERE id=$1", [categoryId]);
    const optionalBlanks = { ...address, companyName: "", addressLine2: "", region: "", phone: "" };
    const separateShipping = { ...optionalBlanks, addressLine1: "2 Separate Shipping Street" };
    const validated = await noPhoneBrowser.request("/checkout/validate", { method: "POST", body: JSON.stringify({ shippingAddress: optionalBlanks, expectedGrandTotal: 15 }) });
    assert.equal(validated.response.status, 200, JSON.stringify(validated.body));
    const noPhoneOrder = await noPhoneBrowser.request("/checkout/order", { method: "POST", body: JSON.stringify({
      email: `${marker}-api-no-phone@example.com`, phone: "", billingAddress: optionalBlanks, shippingAddress: separateShipping,
      idempotencyKey: `${marker}-api-no-phone-order`, expectedGrandTotal: validated.body.data.grandTotal,
    }) });
    assert.equal(noPhoneOrder.response.status, 201, JSON.stringify(noPhoneOrder.body));
    orderIds.push(noPhoneOrder.body.data.order.id);
    assert.equal(noPhoneOrder.body.data.order.billingAddress.phone, null);
    assert.equal(noPhoneOrder.body.data.order.billingAddress.addressLine2, null);
    assert.equal(noPhoneOrder.body.data.order.shippingAddress.addressLine1, "2 Separate Shipping Street");
    await cancelOrder(noPhoneOrder.body.data.order.id, {
      guestSessionId: noPhoneBrowser.cookie("lizzor_guest_cart"),
      guestAccessToken: noPhoneOrder.body.data.guestAccessToken,
    });
    const mixedVisibilitySession = `${marker}-mixed-visibility`;
    sessions.push({ session: mixedVisibilitySession });
    await addItem({ guestSessionId: mixedVisibilitySession }, { productId, variantId, quantity: 1 });
    await pool.query("UPDATE categories SET active=false WHERE id=$1", [categoryId]);
    await addItem({ guestSessionId: mixedVisibilitySession }, { productId: visibleProductId, variantId: visibleVariantId, quantity: 1 });
    const visibilityCampaign = (await pool.query(
      `INSERT INTO promotion_campaigns (name,start_at,promotion_type,discount_type,discount_value,automatic,active)
       VALUES ($1,now()-interval '1 minute','product','percentage',10,true,true) RETURNING id`,
      [`${marker} visible-line discount`],
    )).rows[0].id;
    campaignIds.push(visibilityCampaign);
    await pool.query("INSERT INTO promotion_products (campaign_id,product_id) VALUES ($1,$2)", [visibilityCampaign, visibleProductId]);
    const mixedVisibilityCart = await getCart({ guestSessionId: mixedVisibilitySession });
    const hiddenLine = mixedVisibilityCart.items.find((item) => item.productId === productId)!;
    const visibleLine = mixedVisibilityCart.items.find((item) => item.productId === visibleProductId)!;
    assert.equal(hiddenLine.categoryVisible, false);
    assert.equal(hiddenLine.baseLineTotal, 0);
    assert.equal(visibleLine.categoryVisible, true);
    assert.equal(visibleLine.baseLineTotal, 10);
    assert.equal(visibleLine.promotionDiscount, 1);
    assert.equal(mixedVisibilityCart.totals.subtotal, 10);
    assert.equal(mixedVisibilityCart.totals.discountTotal, 1);
    assert.equal(mixedVisibilityCart.totals.taxTotal, 1.44);
    assert.equal(mixedVisibilityCart.totals.grandTotal, 9);
    const hiddenCoupon = (await pool.query(
      `INSERT INTO promotion_campaigns (name,start_at,promotion_type,discount_type,discount_value,automatic,coupon_code,active)
       VALUES ($1,now()-interval '1 minute','product','fixed',5,false,$2,true) RETURNING id`,
      [`${marker} hidden-line coupon`, `${marker}-hidden`.toUpperCase()],
    )).rows[0].id;
    campaignIds.push(hiddenCoupon);
    await pool.query("INSERT INTO promotion_products (campaign_id,product_id) VALUES ($1,$2)", [hiddenCoupon, productId]);
    await assert.rejects(
      () => applyCoupon({ guestSessionId: mixedVisibilitySession }, `${marker}-hidden`),
      /coupon invalid|ineligible/i,
      "a coupon targeting a hidden category line must not be eligible",
    );
    await clearCart({ guestSessionId: mixedVisibilitySession });
    await pool.query("UPDATE categories SET active=true WHERE id=$1", [categoryId]);

    const cyPhoneBrowser = new Browser(baseUrl);
    await cyPhoneBrowser.request("/cart");
    sessions.push({ session: cyPhoneBrowser.cookie("lizzor_guest_cart")! });
    await cyPhoneBrowser.request("/cart/items", { method: "POST", body: JSON.stringify({ productId, variantId, quantity: 1 }) });
    const cyPhoneAddress = { ...optionalBlanks, phone: "+35799123456" };
    const cyPhoneOrder = await cyPhoneBrowser.request("/checkout/order", { method: "POST", body: JSON.stringify({
      email: `${marker}-api-cy-phone@example.com`, phone: "+35799123456", billingAddress: cyPhoneAddress, shippingAddress: cyPhoneAddress,
      idempotencyKey: `${marker}-api-cy-phone-order`,
    }) });
    assert.equal(cyPhoneOrder.response.status, 201, JSON.stringify(cyPhoneOrder.body));
    orderIds.push(cyPhoneOrder.body.data.order.id);
    assert.equal(cyPhoneOrder.body.data.order.billingAddress.phone, "+35799123456");
    await cancelOrder(cyPhoneOrder.body.data.order.id, {
      guestSessionId: cyPhoneBrowser.cookie("lizzor_guest_cart"),
      guestAccessToken: cyPhoneOrder.body.data.guestAccessToken,
    });

    const validationBrowser = new Browser(baseUrl);
    await validationBrowser.request("/cart");
    sessions.push({ session: validationBrowser.cookie("lizzor_guest_cart")! });
    const nonCyprus = await validationBrowser.request("/checkout/order", { method: "POST", body: JSON.stringify({
      email: `${marker}-api-gr-phone@example.com`, phone: "+306912345678", billingAddress: { ...optionalBlanks, countryCode: "GR", phone: "+306912345678" },
      shippingAddress: { ...optionalBlanks, countryCode: "GR", phone: "+306912345678" }, idempotencyKey: `${marker}-api-gr-phone-order`, expectedGrandTotal: 15,
    }) });
    assert.equal(nonCyprus.response.status, 409);
    assert.equal(nonCyprus.body.error.code, "CART_EMPTY", "valid non-Cyprus E.164 phone must pass request validation");
    const invalidCountry = await validationBrowser.request("/checkout/validate", { method: "POST", body: JSON.stringify({ shippingAddress: { ...optionalBlanks, countryCode: "+357" } }) });
    assert.equal(invalidCountry.response.status, 400);
    assert.match(invalidCountry.body.error.message, /country/i);
    assert.doesNotMatch(invalidCountry.body.error.message, /request could not be validated/i);

    const guest = `${marker}-guest`;
    sessions.push({ session: guest });
    let cart = await addItem({ guestSessionId: guest }, { productId, variantId, quantity: 19 });
    assert.equal(cart.items[0].unitPrice, 9);
    assert.equal(cart.items[0].nextTier?.additionalQuantity, 1);
    cart = await updateItem({ guestSessionId: guest }, cart.items[0].id, 20);
    assert.equal(cart.items[0].unitPrice, 8);
    assert.equal(cart.totals.grandTotal, 160);
    assert.equal("costPrice" in cart.items[0], false);

    const created = await createOrder({ guestSessionId: guest }, { email: `${marker}@example.com`, billingAddress: address, shippingAddress: address, idempotencyKey: `${marker}-checkout`, expectedGrandTotal: 160 });
    orderIds.push(created.order.id);
    const guestADelivery = (await pool.query(
      "SELECT recipient_email AS email FROM notification_deliveries WHERE event_type='order.created' AND metadata_json->>'orderId'=$1",
      [created.order.id],
    )).rows[0];
    assert.equal(guestADelivery.email, `${marker}@example.com`, "Guest A confirmation must route only to Guest A");
    sessions[0]!.token = created.guestAccessToken;
    sessions[0]!.orderId = created.order.id;
    assert.equal(created.order.items[0].unitPrice, 8);
    assert.equal(created.order.items[0].sku, `${marker}-variant`);
    assert.equal(created.order.paymentStatus, "pending");
    assert.equal(created.order.taxTotal, 25.55); // 19% VAT included in €160.00
    assert.equal(created.order.grandTotal, created.order.subtotal - created.order.discountTotal + created.order.shippingTotal);
    assert.equal(Number((await pool.query("SELECT quantity_reserved AS reserved FROM inventory WHERE variant_id=$1", [variantId])).rows[0].reserved), 20);
    assert.equal("costPriceSnapshot" in created.order.items[0], false);
    const emailAccessToken = createOpaqueToken();
    await pool.query(`UPDATE guest_order_email_access_tokens SET token_hash=$1,expires_at=now()+interval '180 days' WHERE order_id=$2`, [hashOpaqueToken(emailAccessToken), created.order.id]);
    const emailOrder = await getGuestEmailOrder(created.order.id, emailAccessToken);
    assert.equal(emailOrder.id, created.order.id);
    assert.equal(emailOrder.items[0].productName, created.order.items[0].productName);
    assert.equal("payments" in emailOrder, false);
    assert.equal("reservations" in emailOrder, false);
    assert.equal("billingAddress" in emailOrder, false);
    assert.equal("customer" in emailOrder, false);
    const cleanBrowserResponse = await fetch(`${baseUrl}/api/v1/guest/email-orders/${created.order.id}`, {
      headers: { "x-guest-order-email-token": emailAccessToken },
    });
    assert.equal(cleanBrowserResponse.status, 200);
    assert.match(cleanBrowserResponse.headers.get("cache-control") ?? "", /no-store/);
    const responseCookies = cleanBrowserResponse.headers.get("set-cookie") ?? "";
    assert.equal(responseCookies.includes("lizzor_session="), false, "read-only email access must not create an authenticated session");
    assert.equal(responseCookies.includes("lizzor_guest_cart="), false, "read-only email access must not create a checkout session");
    const cleanBrowserOrder = (await cleanBrowserResponse.json()).data;
    assert.equal(cleanBrowserOrder.id, created.order.id);
    assert.equal("payments" in cleanBrowserOrder, false);
    assert.equal((await fetch(`${baseUrl}/api/v1/guest/email-orders/${created.order.id}`, {
      headers: { "x-guest-order-email-token": createOpaqueToken() },
    })).status, 404);
    assert.equal((await pool.query("SELECT token_hash=$1 AS leaked FROM guest_order_email_access_tokens WHERE order_id=$2", [emailAccessToken, created.order.id])).rows[0].leaked, false);
    await assert.rejects(() => getGuestEmailOrder(created.order.id, "malformed"), /not found/i);
    await assert.rejects(() => getGuestEmailOrder(created.order.id, createOpaqueToken()), /not found/i);
    await pool.query("UPDATE guest_order_email_access_tokens SET expires_at=now()-interval '1 second' WHERE order_id=$1", [created.order.id]);
    await assert.rejects(() => getGuestEmailOrder(created.order.id, emailAccessToken), /not found/i);
    await pool.query("UPDATE guest_order_email_access_tokens SET expires_at=now()+interval '180 days' WHERE order_id=$1", [created.order.id]);
    const replay = await createOrder({ guestSessionId: guest }, { email: `${marker}@example.com`, billingAddress: address, shippingAddress: address, idempotencyKey: `${marker}-checkout`, expectedGrandTotal: 160 });
    assert.equal(replay.order.id, created.order.id);
    assert.equal(replay.replayed, true);
    await assert.rejects(
      () => createOrder({ guestSessionId: guest }, { email: `changed-${marker}@example.com`, billingAddress: address, shippingAddress: address, idempotencyKey: `${marker}-checkout`, expectedGrandTotal: 160 }),
      /already used with different request details/i,
    );
    await pool.query("UPDATE product_variants SET sku=$1,base_price=15 WHERE id=$2", [`${marker}-changed`, variantId]);
    const historical = await getOrder(created.order.id, { guestSessionId: guest, guestAccessToken: created.guestAccessToken });
    assert.equal(historical.items[0].sku, `${marker}-variant`);
    assert.equal(historical.items[0].unitPrice, 8);
    await assert.rejects(() => getOrder(created.order.id, { guestSessionId: `${marker}-other`, guestAccessToken: created.guestAccessToken }), /not found/i);
    await cancelOrder(created.order.id, { guestSessionId: guest, guestAccessToken: created.guestAccessToken });
    await assertCancellationDelivery(pool, created.order.id, `${marker}@example.com`, "email");
    assert.equal(Number((await pool.query("SELECT quantity_reserved AS reserved FROM inventory WHERE variant_id=$1", [variantId])).rows[0].reserved), 0);

    userId = (await pool.query(`INSERT INTO users (email,first_name,last_name,account_type,status,email_verified_at) VALUES ($1,'Account','Buyer','personal','active',now()) RETURNING id`, [`${marker}-user@example.com`])).rows[0].id;
    await claimGuestOrder(userId, created.order.id, guest, created.guestAccessToken!);
    await assert.rejects(() => getGuestEmailOrder(created.order.id, emailAccessToken), /not found/i, "email capability must stop working after account claim");
    const mergeSession = `${marker}-merge`;
    sessions.push({ session: mergeSession });
    await addItem({ guestSessionId: mergeSession }, { productId, variantId, quantity: 1 });
    // Existing authenticated lines and guest lines for the same SKU coalesce
    // once at sign-in rather than creating duplicate rows or re-claiming.
    await addItem({ userId }, { productId, variantId, quantity: 2 });
    const userCart = await getCart({ userId, guestSessionId: mergeSession });
    assert.equal(userCart.items[0].unitPrice, 9);
    assert.equal(userCart.items.length, 1);
    assert.equal(userCart.items[0].quantity, 3);
    assert.equal((await pool.query("SELECT guest_session_id AS guest FROM carts WHERE user_id=$1 AND status='active'", [userId])).rows[0].guest, null);
    assert.equal((await getCart({ userId, guestSessionId: mergeSession })).items[0].quantity, 3);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM carts WHERE guest_session_id=$1 AND status='active'", [mergeSession])).rows[0].n, 0);
    assert.equal((await validateCheckout({ userId }, address, 27)).valid, true);
    const userOrder = await createOrder({ userId }, { email: `${marker}-user@example.com`, billingAddress: address, shippingAddress: address, idempotencyKey: `${marker}-user-order`, expectedGrandTotal: 27 });
    orderIds.push(userOrder.order.id);
    assert.equal((await pool.query(
      "SELECT recipient_email AS email FROM notification_deliveries WHERE event_type='order.created' AND metadata_json->>'orderId'=$1",
      [userOrder.order.id],
    )).rows[0].email, `${marker}-user@example.com`, "authenticated confirmation must route to its account");
    assert.ok((await listCustomerOrders(userId)).items.some((item) => item.id === userOrder.order.id));
    await addItem({ userId }, { productId, variantId, quantity: 2 });
    const authenticatedOrderCount = Number((await pool.query("SELECT count(*) FROM orders WHERE user_id=$1", [userId])).rows[0].count);
    await assert.rejects(
      () => createOrder({ userId }, { email: `${marker}-other-customer@example.com`, billingAddress: address, shippingAddress: address, idempotencyKey: `${marker}-mismatched-user-order`, expectedGrandTotal: 18 }),
      /signed in as/i,
    );
    assert.equal(Number((await pool.query("SELECT count(*) FROM orders WHERE user_id=$1", [userId])).rows[0].count), authenticatedOrderCount);
    await assert.rejects(
      () => createOrder({ userId }, { email: `${marker}-user@example.com`, billingAddress: address, shippingAddress: address, idempotencyKey: `${marker}-user-order`, expectedGrandTotal: 27 }),
      /already used with different cart details/i,
    );
    await assert.rejects(() => getOrder(userOrder.order.id, { userId: "00000000-0000-0000-0000-000000000000" }), /not found/i);
    await cancelOrder(userOrder.order.id, { userId });
    await assertCancellationDelivery(pool, userOrder.order.id, `${marker}-user@example.com`, "account");

    // Company order access is deliberately narrower than membership: a buyer
    // owns what they placed, while active owners and administrators may act for
    // the company. Exercise both service and authenticated HTTP entry points.
    const companyPassword = "CommerceCompanyOrderPassword1";
    const companyPasswordHash = await hashPassword(companyPassword);
    const companyUsers = await Promise.all(["buyer-a", "buyer-b", "viewer", "owner", "admin", "suspended-owner", "company-b", "personal-outsider"].map(async (name) => {
      const email = `${marker}-${name}@example.com`;
      const row = (await pool.query(
        "INSERT INTO users (email,password_hash,first_name,last_name,account_type,status,email_verified_at) VALUES ($1,$2,$3,'Company','personal','active',now()) RETURNING id",
        [email, companyPasswordHash, name],
      )).rows[0];
      companyUserIds.push(row.id);
      return { id: row.id as string, email };
    }));
    const [buyerA, buyerB, viewer, owner, admin, suspendedOwner, companyBMember, personalOutsider] = companyUsers;
    const companyAId = (await pool.query(
      "INSERT INTO companies (company_name,vat_number,contact_person,email,status) VALUES ($1,$2,'Company',$3,'active') RETURNING id",
      [`${marker}-company-a`, `COMMERCE-A-${suffix.slice(-20)}`, `${marker}-company-a@example.com`],
    )).rows[0].id as string;
    const companyBId = (await pool.query(
      "INSERT INTO companies (company_name,vat_number,contact_person,email,status) VALUES ($1,$2,'Company',$3,'active') RETURNING id",
      [`${marker}-company-b`, `COMMERCE-B-${suffix.slice(-20)}`, `${marker}-company-b@example.com`],
    )).rows[0].id as string;
    companyIds.push(companyAId, companyBId);
    await pool.query(
      `INSERT INTO company_users (company_id,user_id,role,status) VALUES
        ($1,$2,'buyer','active'),($1,$3,'buyer','active'),($1,$4,'viewer','active'),
        ($1,$5,'owner','active'),($1,$6,'admin','active'),($1,$7,'owner','suspended'),
        ($8,$9,'buyer','active')`,
      [companyAId, buyerA.id, buyerB.id, viewer.id, owner.id, admin.id, suspendedOwner.id, companyBId, companyBMember.id],
    );
    await pool.query("UPDATE users SET active_company_id=$1 WHERE id=$2", [companyAId, buyerA.id]);
    const placeCompanyOrder = async (name: string) => {
      await addItem({ userId: buyerA.id }, { productId, variantId, quantity: 1 });
      const placed = await createOrder(
        { userId: buyerA.id },
        { email: buyerA.email, billingAddress: address, shippingAddress: address, idempotencyKey: `${marker}-company-${name}` },
      );
      orderIds.push(placed.order.id);
      assert.equal(
        (await pool.query('SELECT company_id AS "companyId" FROM orders WHERE id=$1', [placed.order.id])).rows[0].companyId,
        companyAId,
      );
      return placed.order.id as string;
    };
    const serviceDetailOrder = await placeCompanyOrder("service-detail");
    const viewerOwnedOrder = await placeCompanyOrder("viewer-owned");
    await pool.query("UPDATE orders SET user_id=$1 WHERE id=$2", [viewer.id, viewerOwnedOrder]);
    const serviceBuyAgainOrder = await placeCompanyOrder("service-buy-again");
    const serviceCancelOrder = await placeCompanyOrder("service-cancel");
    const serviceOwnerCancelOrder = await placeCompanyOrder("service-owner-cancel");
    const serviceAdminCancelOrder = await placeCompanyOrder("service-admin-cancel");
    const httpOwnerBuyAgainOrder = await placeCompanyOrder("http-owner-buy-again");
    const httpOwnerCancelOrder = await placeCompanyOrder("http-owner-cancel");
    const httpAdminBuyAgainOrder = await placeCompanyOrder("http-admin-buy-again");
    const httpAdminCancelOrder = await placeCompanyOrder("http-admin-cancel");
    const deniedOrder = await placeCompanyOrder("denied");
    const deactivatedOrder = await placeCompanyOrder("deactivated");

    assert.equal((await getOrder(serviceDetailOrder, { userId: buyerA.id })).id, serviceDetailOrder);
    await buyAgain(serviceBuyAgainOrder, buyerA.id);
    await cancelOrder(serviceCancelOrder, { userId: buyerA.id });
    assert.equal((await getOrder(serviceCancelOrder, { userId: buyerA.id })).status, "cancelled");
    for (const [actor, cancellableOrder] of [[owner, serviceOwnerCancelOrder], [admin, serviceAdminCancelOrder]] as const) {
      assert.equal((await getOrder(serviceDetailOrder, { userId: actor.id })).id, serviceDetailOrder);
      await buyAgain(serviceBuyAgainOrder, actor.id);
      await cancelOrder(cancellableOrder, { userId: actor.id });
      assert.equal((await getOrder(cancellableOrder, { userId: buyerA.id })).status, "cancelled");
    }

    const browsers = new Map(companyUsers.map((account) => [account.id, new Browser(baseUrl)]));
    for (const account of companyUsers) {
      const browser = browsers.get(account.id)!;
      await browser.request("/auth/me");
      assert.equal((await browser.request("/auth/login", { method: "POST", body: JSON.stringify({ email: account.email, password: companyPassword }) })).response.status, 200);
    }
    const ownerBrowser = browsers.get(owner.id)!;
    const adminBrowser = browsers.get(admin.id)!;
    const buyerABrowser = browsers.get(buyerA.id)!;
    const viewerBrowser = browsers.get(viewer.id)!;
    assert.equal((await buyerABrowser.request(`/account/orders/${serviceDetailOrder}`)).response.status, 200);
    assert.equal((await buyerABrowser.request(`/account/orders/${serviceBuyAgainOrder}/buy-again`, { method: "POST" })).response.status, 200);
    assert.equal((await viewerBrowser.request(`/account/orders/${viewerOwnedOrder}`)).response.status, 200);
    assert.ok((await listCustomerOrders(viewer.id)).items.some((item) => item.id === viewerOwnedOrder), "viewers may read only company orders they placed");
    assert.equal((await viewerBrowser.request(`/account/orders/${viewerOwnedOrder}/buy-again`, { method: "POST" })).response.status, 404);
    assert.equal((await viewerBrowser.request(`/account/orders/${viewerOwnedOrder}/cancel`, { method: "POST" })).response.status, 404);
    for (const [browser, buyAgainOrder, cancellableOrder] of [[ownerBrowser, httpOwnerBuyAgainOrder, httpOwnerCancelOrder], [adminBrowser, httpAdminBuyAgainOrder, httpAdminCancelOrder]] as const) {
      assert.equal((await browser.request(`/account/orders/${serviceDetailOrder}`)).response.status, 200);
      assert.equal((await browser.request(`/account/orders/${buyAgainOrder}/buy-again`, { method: "POST" })).response.status, 200);
      assert.equal((await browser.request(`/account/orders/${cancellableOrder}/cancel`, { method: "POST" })).response.status, 200);
      assert.equal((await getOrder(cancellableOrder, { userId: buyerA.id })).status, "cancelled");
    }

    const cartLineCount = async (actorId: string) => Number((await pool.query(
      "SELECT count(*)::int AS count FROM cart_items ci JOIN carts c ON c.id=ci.cart_id WHERE c.user_id=$1 AND c.status='active'",
      [actorId],
    )).rows[0].count);
    const deniedActors = [buyerB, viewer, suspendedOwner, companyBMember, personalOutsider];
    for (const actor of deniedActors) {
      const browser = browsers.get(actor.id)!;
      const beforeCartLines = await cartLineCount(actor.id);
      assert.equal((await browser.request(`/account/orders/${deniedOrder}`)).response.status, 404);
      assert.equal((await browser.request(`/account/orders/${deniedOrder}/buy-again`, { method: "POST" })).response.status, 404);
      assert.equal((await browser.request(`/account/orders/${deniedOrder}/cancel`, { method: "POST" })).response.status, 404);
      assert.equal(await cartLineCount(actor.id), beforeCartLines, "denied buy-again must not change a cart");
      assert.equal((await getOrder(deniedOrder, { userId: buyerA.id })).status, "pending", "denied cancellation must not change an order");
      await assert.rejects(() => getOrder(deniedOrder, { userId: actor.id }), /not found/i);
      await assert.rejects(() => buyAgain(deniedOrder, actor.id), /not found/i);
      await assert.rejects(() => cancelOrder(deniedOrder, { userId: actor.id }), /not found/i);
    }
    const unknownOrderId = randomUUID();
    for (const path of [`/account/orders/${unknownOrderId}`, `/account/orders/${unknownOrderId}/buy-again`, `/account/orders/${unknownOrderId}/cancel`]) {
      assert.equal((await browsers.get(personalOutsider.id)!.request(path, path.endsWith(unknownOrderId) ? {} : { method: "POST" })).response.status, 404);
    }

    await pool.query("UPDATE companies SET status='deactivated' WHERE id=$1", [companyAId]);
    assert.equal((await buyerABrowser.request(`/account/orders/${serviceDetailOrder}`)).response.status, 404, "inactive companies must not expose company orders");
    assert.ok(!(await listCustomerOrders(buyerA.id)).items.some((item) => item.id === serviceDetailOrder), "inactive company orders must disappear from account history");
    for (const actor of [owner, admin]) {
      const browser = browsers.get(actor.id)!;
      const beforeCartLines = await cartLineCount(actor.id);
      assert.equal((await browser.request(`/account/orders/${deactivatedOrder}`)).response.status, 404, "authenticated email CTA destination must not expose a deactivated company order");
      assert.equal((await browser.request(`/account/orders/${deactivatedOrder}/buy-again`, { method: "POST" })).response.status, 404);
      assert.equal((await browser.request(`/account/orders/${deactivatedOrder}/cancel`, { method: "POST" })).response.status, 404);
      assert.equal(await cartLineCount(actor.id), beforeCartLines);
      assert.equal((await pool.query("SELECT status FROM orders WHERE id=$1", [deactivatedOrder])).rows[0].status, "pending");
      await assert.rejects(() => getOrder(deactivatedOrder, { userId: actor.id }), /not found/i);
      await assert.rejects(() => buyAgain(deactivatedOrder, actor.id), /not found/i);
      await assert.rejects(() => cancelOrder(deactivatedOrder, { userId: actor.id }), /not found/i);
    }

    const expirySession = `${marker}-expiry`;
    sessions.push({ session: expirySession });
    await addItem({ guestSessionId: expirySession }, { productId, variantId, quantity: 1 });
    const expiring = await createOrder({ guestSessionId: expirySession }, { email: `${expirySession}@example.com`, billingAddress: address, shippingAddress: address, idempotencyKey: `${expirySession}-order`, expectedGrandTotal: 15 });
    orderIds.push(expiring.order.id);
    assert.equal((await pool.query(
      "SELECT recipient_email AS email FROM notification_deliveries WHERE event_type='order.created' AND metadata_json->>'orderId'=$1",
      [expiring.order.id],
    )).rows[0].email, `${expirySession}@example.com`, "Guest B confirmation must route only to Guest B");
    assert.notEqual(`${expirySession}@example.com`, guestADelivery.email);
    await assert.rejects(() => getGuestEmailOrder(expiring.order.id, emailAccessToken), /not found/i, "an Order A token must not open Order B");
    await pool.query("UPDATE orders SET reservation_expires_at=now()-interval '1 minute' WHERE id=$1", [expiring.order.id]);
    const expiryResult = await releaseExpiredReservations();
    assert.ok(expiryResult.orderIds.includes(expiring.order.id));
    assert.equal((await getOrder(expiring.order.id, { guestSessionId: expirySession, guestAccessToken: expiring.guestAccessToken })).status, "cancelled");
    assert.equal((await pool.query("SELECT status FROM inventory_reservations WHERE order_id=$1", [expiring.order.id])).rows[0].status, "released");
    await assertCancellationDelivery(pool, expiring.order.id, `${expirySession}@example.com`, "email");

    const duplicateSession = `${marker}-duplicate`;
    sessions.push({ session: duplicateSession });
    await addItem({ guestSessionId: duplicateSession }, { productId, variantId, quantity: 1 });
    const duplicateInput = { email: `${duplicateSession}@example.com`, billingAddress: address, shippingAddress: address, idempotencyKey: `${duplicateSession}-same-key`, expectedGrandTotal: 15 };
    const duplicateResults = await Promise.all([
      createOrder({ guestSessionId: duplicateSession }, duplicateInput),
      createOrder({ guestSessionId: duplicateSession }, duplicateInput),
    ]);
    assert.equal(duplicateResults[0].order.id, duplicateResults[1].order.id);
    orderIds.push(duplicateResults[0].order.id);
    const duplicateToken = duplicateResults.find((result) => result.guestAccessToken)?.guestAccessToken;
    assert.ok(duplicateToken);
    assert.equal((await getOrder(duplicateResults[0].order.id, { guestSessionId: duplicateSession, guestAccessToken: duplicateToken })).id, duplicateResults[0].order.id);
    await cancelOrder(duplicateResults[0].order.id, { guestSessionId: duplicateSession, guestAccessToken: duplicateToken });

    // A globally limited coupon is consumed exactly once even when two
    // separate carts reach checkout concurrently.
    await pool.query("UPDATE inventory SET quantity_on_hand=10,quantity_reserved=0 WHERE variant_id=$1", [variantId]);
    const limitedCoupon = (await pool.query(
      `INSERT INTO promotion_campaigns (name,start_at,promotion_type,discount_type,discount_value,automatic,coupon_code,usage_limit,active)
       VALUES ($1,now()-interval '1 minute','order','fixed',1,false,$2,1,true) RETURNING id`,
      [`${marker} limited coupon`, `${marker}-limited`.toUpperCase()],
    )).rows[0].id;
    campaignIds.push(limitedCoupon);
    const couponSessions = [`${marker}-coupon-a`, `${marker}-coupon-b`];
    for (const session of couponSessions) {
      sessions.push({ session });
      await addItem({ guestSessionId: session }, { productId, variantId, quantity: 1 });
      await applyCoupon({ guestSessionId: session }, `${marker}-limited`);
    }
    const couponAttempts = await Promise.allSettled(couponSessions.map((session) => createOrder(
      { guestSessionId: session },
      { email: `${session}@example.com`, billingAddress: address, shippingAddress: address, idempotencyKey: `${session}-order`, expectedGrandTotal: 14 },
    )));
    assert.equal(couponAttempts.filter((attempt) => attempt.status === "fulfilled").length, 1);
    assert.equal(Number((await pool.query("SELECT usage_count FROM promotion_campaigns WHERE id=$1", [limitedCoupon])).rows[0].usage_count), 1);
    assert.equal(Number((await pool.query("SELECT count(*) FROM promotion_usages WHERE campaign_id=$1", [limitedCoupon])).rows[0].count), 1);
    const couponWinner = couponAttempts.find((attempt): attempt is PromiseFulfilledResult<Awaited<ReturnType<typeof createOrder>>> => attempt.status === "fulfilled")!;
    orderIds.push(couponWinner.value.order.id);
    await cancelOrder(couponWinner.value.order.id, { guestSessionId: couponSessions[couponAttempts.indexOf(couponWinner)]!, guestAccessToken: couponWinner.value.guestAccessToken });
    assert.equal(Number((await pool.query("SELECT usage_count FROM promotion_campaigns WHERE id=$1", [limitedCoupon])).rows[0].usage_count), 0);
    assert.equal(Number((await pool.query("SELECT count(*) FROM promotion_usages WHERE campaign_id=$1", [limitedCoupon])).rows[0].count), 0);

    const couponExpirySession = `${marker}-coupon-expiry`;
    sessions.push({ session: couponExpirySession });
    await addItem({ guestSessionId: couponExpirySession }, { productId, variantId, quantity: 1 });
    await applyCoupon({ guestSessionId: couponExpirySession }, `${marker}-limited`);
    const couponExpiring = await createOrder({ guestSessionId: couponExpirySession }, { email: `${couponExpirySession}@example.com`, billingAddress: address, shippingAddress: address, idempotencyKey: `${couponExpirySession}-order`, expectedGrandTotal: 14 });
    orderIds.push(couponExpiring.order.id);
    await pool.query("UPDATE orders SET reservation_expires_at=now()-interval '1 minute' WHERE id=$1", [couponExpiring.order.id]);
    await releaseExpiredReservations();
    assert.equal(Number((await pool.query("SELECT usage_count FROM promotion_campaigns WHERE id=$1", [limitedCoupon])).rows[0].usage_count), 0);
    assert.equal(Number((await pool.query("SELECT count(*) FROM promotion_usages WHERE order_id=$1", [couponExpiring.order.id])).rows[0].count), 0);

    await pool.query("UPDATE inventory SET quantity_on_hand=5,quantity_reserved=0 WHERE variant_id=$1", [variantId]);
    const concurrent = [`${marker}-race-a`, `${marker}-race-b`];
    for (const session of concurrent) {
      sessions.push({ session });
      await addItem({ guestSessionId: session }, { productId, variantId, quantity: 4 });
    }
    const attempts = await Promise.allSettled(concurrent.map((session, index) => createOrder({ guestSessionId: session }, { email: `${session}@example.com`, billingAddress: address, shippingAddress: address, idempotencyKey: `${session}-order`, expectedGrandTotal: 36 })));
    assert.equal(attempts.filter((attempt) => attempt.status === "fulfilled").length, 1);
    const winner = attempts.find((attempt): attempt is PromiseFulfilledResult<Awaited<ReturnType<typeof createOrder>>> => attempt.status === "fulfilled")!;
    orderIds.push(winner.value.order.id);
    const winnerSession = concurrent[attempts.indexOf(winner)]!;
    await cancelOrder(winner.value.order.id, { guestSessionId: winnerSession, guestAccessToken: winner.value.guestAccessToken });
    assert.equal(Number((await pool.query("SELECT quantity_reserved AS reserved FROM inventory WHERE variant_id=$1", [variantId])).rows[0].reserved), 0);

    const paidZone = (await pool.query("INSERT INTO shipping_zones (name,active) VALUES ($1,true) RETURNING id", [`${marker}-paid-shipping`])).rows[0].id;
    shippingZoneIds.push(paidZone);
    await pool.query("INSERT INTO shipping_zone_countries (zone_id,country_code) VALUES ($1,'GR')", [paidZone]);
    await pool.query("INSERT INTO shipping_rules (zone_id,shipping_price,free_shipping,active,priority) VALUES ($1,7,false,true,10)", [paidZone]);
    const paidShippingSession = `${marker}-shipping-paid`;
    sessions.push({ session: paidShippingSession });
    await addItem({ guestSessionId: paidShippingSession }, { productId, variantId, quantity: 1 });
    const greekAddress = { ...address, countryCode: "GR" };
    const changedTotal = await validateCheckout({ guestSessionId: paidShippingSession }, greekAddress, 15);
    assert.deepEqual({ valid: changedTotal.valid, shippingTotal: changedTotal.shippingTotal, grandTotal: changedTotal.grandTotal }, { valid: false, shippingTotal: 7, grandTotal: 22 });
    const shippedOrder = await createOrder({ guestSessionId: paidShippingSession }, { email: `${paidShippingSession}@example.com`, billingAddress: greekAddress, shippingAddress: greekAddress, idempotencyKey: `${paidShippingSession}-order`, expectedGrandTotal: 22 });
    orderIds.push(shippedOrder.order.id);
    assert.equal(shippedOrder.order.shippingTotal, 7);
    assert.equal(shippedOrder.order.grandTotal, 22);
    await cancelOrder(shippedOrder.order.id, { guestSessionId: paidShippingSession, guestAccessToken: shippedOrder.guestAccessToken });

    const freeZone = (await pool.query("INSERT INTO shipping_zones (name,active) VALUES ($1,true) RETURNING id", [`${marker}-free-shipping`])).rows[0].id;
    shippingZoneIds.push(freeZone);
    await pool.query("INSERT INTO shipping_zone_countries (zone_id,country_code) VALUES ($1,'DE')", [freeZone]);
    await pool.query("INSERT INTO shipping_rules (zone_id,shipping_price,free_shipping,active,priority) VALUES ($1,99,true,true,10)", [freeZone]);
    const freeShippingSession = `${marker}-shipping-free`;
    sessions.push({ session: freeShippingSession });
    await addItem({ guestSessionId: freeShippingSession }, { productId, variantId, quantity: 1 });
    const germanAddress = { ...address, countryCode: "DE" };
    const freeShipping = await createOrder({ guestSessionId: freeShippingSession }, { email: `${freeShippingSession}@example.com`, billingAddress: germanAddress, shippingAddress: germanAddress, idempotencyKey: `${freeShippingSession}-order`, expectedGrandTotal: 15 });
    orderIds.push(freeShipping.order.id);
    assert.equal(freeShipping.order.shippingTotal, 0);
    assert.equal(freeShipping.order.grandTotal, 15);
    await cancelOrder(freeShipping.order.id, { guestSessionId: freeShippingSession, guestAccessToken: freeShipping.guestAccessToken });

    const unmatchedSession = `${marker}-shipping-unmatched`;
    sessions.push({ session: unmatchedSession });
    await addItem({ guestSessionId: unmatchedSession }, { productId, variantId, quantity: 1 });
    const frenchAddress = { ...address, countryCode: "FR" };
    await assert.rejects(() => validateCheckout({ guestSessionId: unmatchedSession }, frenchAddress, 15), /not available/i);
    await assert.rejects(() => createOrder({ guestSessionId: unmatchedSession }, { email: `${unmatchedSession}@example.com`, billingAddress: frenchAddress, shippingAddress: frenchAddress, idempotencyKey: `${unmatchedSession}-order`, expectedGrandTotal: 15 }), /not available/i);

    assert.equal((await getCart({ guestSessionId: `${marker}-quantity-one` })).items.length, 0);
    console.info("Phase 5A cart, checkout, order, and reservation integration checks passed.");
  } finally {
    for (const orderId of orderIds) await pool.query("DELETE FROM audit_logs WHERE entity_id=$1", [orderId]);
    if (orderIds.length) await pool.query("DELETE FROM orders WHERE id = ANY($1::uuid[])", [orderIds]);
    if (campaignIds.length) await pool.query("DELETE FROM promotion_campaigns WHERE id=ANY($1::uuid[])", [campaignIds]);
    await pool.query("DELETE FROM carts WHERE guest_session_id LIKE $1 OR guest_session_id=ANY($2::text[]) OR user_id=$3 OR user_id=ANY($4::uuid[])", [`${marker}%`, sessions.map((entry) => entry.session), userId || null, companyUserIds]);
    if (shippingZoneIds.length) await pool.query("DELETE FROM shipping_zones WHERE id=ANY($1::uuid[])", [shippingZoneIds]);
    if (companyIds.length) await pool.query("DELETE FROM company_users WHERE company_id=ANY($1::uuid[])", [companyIds]);
    if (companyUserIds.length) await pool.query("DELETE FROM users WHERE id=ANY($1::uuid[])", [companyUserIds]);
    if (companyIds.length) await pool.query("DELETE FROM companies WHERE id=ANY($1::uuid[])", [companyIds]);
    if (userId) await pool.query("DELETE FROM users WHERE id=$1", [userId]);
    if (productId) await pool.query("DELETE FROM products WHERE id=$1", [productId]);
    if (visibleProductId) await pool.query("DELETE FROM products WHERE id=$1", [visibleProductId]);
    if (moqProductId) await pool.query("DELETE FROM products WHERE id=$1", [moqProductId]);
    if (warehouseId) await pool.query("DELETE FROM warehouses WHERE id=$1", [warehouseId]);
    if (visibleWarehouseId) await pool.query("DELETE FROM warehouses WHERE id=$1", [visibleWarehouseId]);
    if (moqWarehouseId) await pool.query("DELETE FROM warehouses WHERE id=$1", [moqWarehouseId]);
    if (categoryId) await pool.query("DELETE FROM categories WHERE id=$1", [categoryId]);
    if (visibleCategoryId) await pool.query("DELETE FROM categories WHERE id=$1", [visibleCategoryId]);
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await closeDatabase();
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});