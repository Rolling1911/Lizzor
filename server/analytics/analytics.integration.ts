import assert from "node:assert/strict";
import type { Server } from "node:http";
import { createApp } from "../app.js";
import { hashPassword } from "../auth/password.js";
import { closeDatabase, getDatabasePool } from "../db/client.js";
import { getAnalytics, getAnalyticsCsv, resolveAnalyticsRange } from "./service.js";
import { assertMutableIntegrationTestDatabase } from "../testing/database-safety.js";

const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
const marker = `analytics-${suffix}`;
const password = "AnalyticsTestPassword1";

class Client {
  private cookies = new Map<string, string>();
  constructor(private readonly baseUrl: string) {}
  async request(path: string) {
    const headers = new Headers();
    if (this.cookies.size) headers.set("cookie", [...this.cookies].map(([key, value]) => `${key}=${value}`).join("; "));
    const response = await fetch(`${this.baseUrl}/api/v1${path}`, { headers });
    const getSetCookie = (response.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie;
    for (const cookie of getSetCookie ? getSetCookie.call(response.headers) : []) {
      const [pair] = cookie.split(";");
      const separator = pair.indexOf("=");
      this.cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
    }
    return { response, body: response.headers.get("content-type")?.includes("json") ? await response.json() : await response.text() };
  }
  async login(email: string) {
    await this.request("/auth/me");
    const csrf = decodeURIComponent(this.cookies.get("lizzor_csrf") ?? "");
    const response = await fetch(`${this.baseUrl}/api/v1/auth/admin/login`, { method: "POST", headers: { "content-type": "application/json", cookie: [...this.cookies].map(([key, value]) => `${key}=${value}`).join("; "), "x-csrf-token": csrf }, body: JSON.stringify({ email, password }) });
    const getSetCookie = (response.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie;
    for (const cookie of getSetCookie ? getSetCookie.call(response.headers) : []) {
      const [pair] = cookie.split(";");
      const separator = pair.indexOf("=");
      this.cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
    }
    assert.equal(response.status, 200);
  }
}

async function run() {
  assertMutableIntegrationTestDatabase("analytics integration");
  const pool = getDatabasePool();
  const app = await createApp({ serveFrontend: false });
  const server: Server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const ids: Record<string, string[]> = { users: [], roles: [], orders: [], campaigns: [], products: [], categories: [], warehouses: [], returns: [], inventoryMovements: [] };
  try {
    const categoryId = (await pool.query("INSERT INTO categories (name,slug) VALUES ($1,$2) RETURNING id", [marker, marker])).rows[0].id;
    ids.categories.push(categoryId);
    const productId = (await pool.query("INSERT INTO products (name,slug,parent_sku,category_id,description,cost_price,base_price,vat_rate,weight,status,published_at) VALUES ($1,$2,$3,$4,$5,20,50,19,1,'active',now()) RETURNING id", [marker, `${marker}-product`, `${marker}-sku`, categoryId, marker])).rows[0].id;
    ids.products.push(productId);
    const customerId = (await pool.query("INSERT INTO users (email,first_name,last_name,status,email_verified_at) VALUES ($1,'Metric','Customer','active',now()) RETURNING id", [`${marker}-customer@example.test`])).rows[0].id;
    ids.users.push(customerId);
    const limitedEmail = `${marker}-limited@example.test`;
    const fullEmail = `${marker}-full@example.test`;
    for (const [email, first] of [[limitedEmail, "Limited"], [fullEmail, "Full"]]) {
      ids.users.push((await pool.query("INSERT INTO users (email,password_hash,first_name,last_name,status,email_verified_at) VALUES ($1,$2,$3,'Admin','active',now()) RETURNING id", [email, await hashPassword(password), first])).rows[0].id);
    }
    const limitedRole = (await pool.query("INSERT INTO admin_roles (name) VALUES ($1) RETURNING id", [`${marker}-limited`])).rows[0].id;
    const fullRole = (await pool.query("INSERT INTO admin_roles (name) VALUES ($1) RETURNING id", [`${marker}-full`])).rows[0].id;
    ids.roles.push(limitedRole, fullRole);
    const permissionKeys = ["analytics.view", "analytics.sales", "analytics.customers", "analytics.inventory", "analytics.margin", "analytics.promotions", "reports.view", "reports.export"];
    await pool.query("INSERT INTO admin_permissions (permission_key) SELECT unnest($1::text[]) ON CONFLICT (permission_key) DO NOTHING", [permissionKeys]);
    await pool.query("INSERT INTO admin_role_permissions (role_id,permission_id) SELECT $1,id FROM admin_permissions WHERE permission_key='analytics.view'", [limitedRole]);
    await pool.query("INSERT INTO admin_role_permissions (role_id,permission_id) SELECT $1,id FROM admin_permissions WHERE permission_key=ANY($2::text[])", [fullRole, permissionKeys]);
    await pool.query("INSERT INTO admin_user_roles (user_id,role_id) VALUES ($1,$2),($3,$4)", [ids.users[1], limitedRole, ids.users[2], fullRole]);

    const addressSnapshot = JSON.stringify({ countryCode: "CY" });
    const addOrder = async (number: string, status: string, payment: string, userId: string | null, guest: string | null, subtotal: number, discount: number, shipping: number, vat: number) => {
      const order = (await pool.query(`INSERT INTO orders (order_number,user_id,guest_email,status,payment_status,subtotal,discount_total,shipping_total,tax_total,grand_total,billing_address_snapshot,shipping_address_snapshot,created_at) VALUES ($1,$2,$3,$4::order_status,$5::payment_status,$6,$7,$8,$9,$10,$11,$11,now()-interval '1 day') RETURNING id`, [`LZ-${number}-${suffix}`, userId, guest, status, payment, subtotal, discount, shipping, vat, subtotal + shipping, addressSnapshot])).rows[0];
      ids.orders.push(order.id);
      await pool.query("INSERT INTO order_items (order_id,product_id,sku_snapshot,product_name_snapshot,quantity,unit_price,cost_price_snapshot,tax_rate_snapshot,line_total) VALUES ($1,$2,$3,$4,2,50,20,19,$5)", [order.id, productId, `${marker}-sku`, marker, subtotal]);
      return order.id as string;
    };
    const paidOne = await addOrder("1", "completed", "paid", customerId, null, 90, 10, 5, 14.37);
    await addOrder("2", "completed", "paid", customerId, null, 100, 0, 0, 15.97);
    await addOrder("3", "completed", "paid", null, `${marker}-guest@example.test`, 50, 0, 0, 7.98);
    await addOrder("4", "cancelled", "paid", customerId, null, 999, 0, 0, 0);
    await addOrder("5", "completed", "failed", customerId, null, 777, 0, 0, 0);
    const paidLater = await addOrder("6", "completed", "paid", customerId, null, 30, 0, 0, 4.79);
    await pool.query("UPDATE orders SET created_at=now()-interval '20 days' WHERE id=$1", [paidLater]);
    await pool.query("INSERT INTO payments (order_id,provider,status,amount,currency,paid_at,created_at) VALUES ($1,'fake','paid',30,'EUR',now()-interval '1 day',now()-interval '20 days')", [paidLater]);
    await pool.query("INSERT INTO refunds (order_id,amount,currency,status,created_at) VALUES ($1,20,'EUR','completed',now()-interval '6 hours')", [paidOne]);

    const campaignId = (await pool.query("INSERT INTO promotion_campaigns (name,start_at,promotion_type,discount_type,discount_value,automatic,active) VALUES ($1,now()-interval '2 days','order','fixed',10,true,true) RETURNING id", ["=SUM(1,1)"])).rows[0].id;
    ids.campaigns.push(campaignId);
    await pool.query("INSERT INTO promotion_usages (campaign_id,order_id,user_id,discount_amount,created_at) VALUES ($1,$2,$3,10,now()-interval '1 day')", [campaignId, paidOne, customerId]);
    const orderItemId = (await pool.query("SELECT id FROM order_items WHERE order_id=$1", [paidOne])).rows[0].id;
    const returnId = (await pool.query("INSERT INTO return_requests (order_id,user_id,reason,status,created_at) VALUES ($1,$2,'Damaged','approved',now()-interval '12 hours') RETURNING id", [paidOne, customerId])).rows[0].id;
    ids.returns.push(returnId);
    await pool.query("INSERT INTO return_items (return_request_id,order_id,order_item_id,quantity,approved_quantity) VALUES ($1,$2,$3,1,1)", [returnId, paidOne, orderItemId]);
    const secondOrderItemId = (await pool.query("INSERT INTO order_items (order_id,product_id,sku_snapshot,product_name_snapshot,quantity,unit_price,cost_price_snapshot,tax_rate_snapshot,line_total) VALUES ($1,$2,$3,$4,1,0,0,19,0) RETURNING id", [paidOne, productId, `${marker}-return-item`, `${marker}-return-item`])).rows[0].id;
    await pool.query("INSERT INTO return_items (return_request_id,order_id,order_item_id,quantity,approved_quantity) VALUES ($1,$2,$3,1,1)", [returnId, paidOne, secondOrderItemId]);
    const warehouseId = (await pool.query("INSERT INTO warehouses (name,code,country_code) VALUES ($1,$2,'CY') RETURNING id", [marker, marker.slice(-45)])).rows[0].id;
    ids.warehouses.push(warehouseId);
    await pool.query("INSERT INTO inventory (warehouse_id,product_id,quantity_on_hand,quantity_reserved,low_stock_threshold) VALUES ($1,$2,4,1,5)", [warehouseId, productId]);
    const movements = await pool.query(`INSERT INTO inventory_movements (warehouse_id,product_id,movement_type,quantity,created_at)
      VALUES ($1,$2,'adjustment',3,now()-interval '1 day'),($1,$2,'adjustment',9,now()-interval '20 days') RETURNING id`, [warehouseId, productId]);
    ids.inventoryMovements.push(...movements.rows.map((row) => row.id));

    const overview: any = await getAnalytics("overview", { range: "7d" });
    assert.equal(overview.metrics.orders.value, 4);
    assert.equal(overview.metrics.netProductSales.value, 270);
    assert.equal(overview.metrics.grossSales.value, 280);
    assert.equal(overview.metrics.discounts, 10);
    assert.equal(overview.metrics.unitsSold, 9);
    assert.equal(overview.metrics.refunds, 20);
    assert.equal(overview.metrics.collected.value, 255);
    assert.equal(overview.metrics.repeatCustomers, 1);
    assert.equal(overview.metrics.returns, 1);
    const products: any = await getAnalytics("products", { range: "7d" });
    assert.equal(products.items.find((item: any) => item.productId === productId)?.units, 9);
    const margin: any = await getAnalytics("margin", { range: "7d" });
    assert.equal(margin.summary.productCost, 160);
    assert.equal(margin.summary.productContribution, 110);
    const promotions: any = await getAnalytics("promotions", { range: "7d" });
    assert.equal(promotions.items.find((item: any) => item.id === campaignId)?.uses, 1);
    assert.match(await getAnalyticsCsv("promotions", { range: "7d" }), /\"'=SUM\(1,1\)\"/);
    const returns: any = await getAnalytics("returns", { range: "7d" });
    assert.equal(returns.summary.items, 2);
    const inventory: any = await getAnalytics("inventory", { range: "7d" });
    assert.equal(inventory.movements.find((item: any) => item.type === "adjustment")?.quantity, 3, "inventory movements must honor the selected date range");
    for (let index = 0; index < 26; index += 1) await addOrder(`e${index}`, "completed", "paid", customerId, null, 1, 0, 0, 0);
    assert.match(await getAnalyticsCsv("orders", { range: "7d" }), new RegExp(`LZ-e25-${suffix}`), "orders CSV must include rows beyond the first visible page");
    assert.throws(() => resolveAnalyticsRange({ range: "custom", start: "2020-01-01T00:00:00.000Z", end: "2022-01-01T00:00:00.000Z" }), /366 days/);
    for (const range of ["today", "yesterday", "7d", "30d", "month", "previousMonth", "year"]) {
      const resolved = resolveAnalyticsRange({ range });
      assert.ok(resolved.start < resolved.end, `${range} should resolve to a positive range`);
    }
    const customStart = new Date(Date.now() - 2 * 86400000).toISOString();
    const customEnd = new Date(Date.now() - 86400000).toISOString();
    assert.ok(resolveAnalyticsRange({ range: "custom", start: customStart, end: customEnd }).start < new Date(customEnd));

    const anonymous = new Client(baseUrl);
    assert.equal((await anonymous.request("/admin/analytics")).response.status, 403);
    const limited = new Client(baseUrl);
    await limited.login(limitedEmail);
    assert.equal((await limited.request("/admin/analytics?range=7d")).response.status, 200);
    assert.equal((await limited.request("/admin/analytics/sales?range=7d")).response.status, 403);
    assert.equal((await limited.request("/admin/reports/overview?range=7d")).response.status, 403);
    assert.equal((await limited.request("/admin/reports/export?report=overview&range=7d")).response.status, 403);
    const full = new Client(baseUrl);
    await full.login(fullEmail);
    const csv = await full.request("/admin/reports/export?report=margin&range=7d");
    assert.equal(csv.response.status, 200);
    assert.match(csv.response.headers.get("content-type") ?? "", /text\/csv/);
    assert.equal((await full.request(`/admin/analytics/inventory?range=7d&companyId=${customerId}`)).response.status, 400);
    for (const report of ["overview", "sales", "orders", "products", "customers", "promotions", "inventory", "margin", "fulfillment", "returns"]) {
      const analyticsResponse = await full.request(`/admin/analytics/${report}?range=7d`);
      assert.equal(analyticsResponse.response.status, 200, `${report} analytics route`);
      assert.ok(analyticsResponse.body?.data, `${report} analytics response shape`);
      const aliasResponse = await full.request(`/admin/reports/${report}?range=7d`);
      assert.equal(aliasResponse.response.status, 200, `${report} reports route`);
      assert.ok(aliasResponse.body?.data, `${report} reports response shape`);
      const zeroResponse = await full.request(`/admin/analytics/${report}?range=custom&start=2000-01-01T00:00:00.000Z&end=2000-01-02T00:00:00.000Z`);
      assert.equal(zeroResponse.response.status, 200, `${report} zero range`);
      const populatedResponse = await full.request(`/admin/analytics/${report}?range=custom&start=${encodeURIComponent(new Date(Date.now() - 3 * 86400000).toISOString())}&end=${encodeURIComponent(new Date().toISOString())}`);
      assert.equal(populatedResponse.response.status, 200, `${report} populated custom range`);
      const exported = await full.request(`/admin/reports/export?report=${report}&range=custom&start=2000-01-01T00:00:00.000Z&end=2000-01-02T00:00:00.000Z`);
      assert.equal(exported.response.status, 200, `${report} CSV`);
    }
    assert.equal((await full.request("/admin/analytics/sales?range=7d&productId=00000000-0000-0000-0000-000000000000")).response.status, 400);
    const audited = await pool.query("SELECT 1 FROM audit_logs WHERE actor_user_id=$1 AND action='analytics.margin.exported'", [ids.users[2]]);
    assert.ok(Number(audited.rowCount) >= 2, "each authorized margin export should be audited");
    console.info("Analytics totals, exclusions, snapshots, RBAC, exports, and audit checks passed.");
  } finally {
    await pool.query("DELETE FROM audit_logs WHERE actor_user_id=ANY($1::uuid[])", [ids.users]);
    await pool.query("DELETE FROM promotion_campaigns WHERE id=ANY($1::uuid[])", [ids.campaigns]);
    await pool.query("DELETE FROM return_requests WHERE id=ANY($1::uuid[])", [ids.returns]);
    await pool.query("DELETE FROM refunds WHERE order_id=ANY($1::uuid[])", [ids.orders]);
    await pool.query("DELETE FROM orders WHERE id=ANY($1::uuid[])", [ids.orders]);
    await pool.query("DELETE FROM admin_roles WHERE id=ANY($1::uuid[])", [ids.roles]);
    await pool.query("DELETE FROM users WHERE id=ANY($1::uuid[])", [ids.users]);
    await pool.query("DELETE FROM inventory_movements WHERE id=ANY($1::uuid[])", [ids.inventoryMovements]);
    await pool.query("DELETE FROM warehouses WHERE id=ANY($1::uuid[])", [ids.warehouses]);
    await pool.query("DELETE FROM products WHERE id=ANY($1::uuid[])", [ids.products]);
    await pool.query("DELETE FROM categories WHERE id=ANY($1::uuid[])", [ids.categories]);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await closeDatabase();
  }
}

run().catch((error) => { console.error(error); process.exitCode = 1; });