import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { createApp } from "../app.js";
import { closeDatabase, getDatabasePool } from "../db/client.js";
import { hashPassword } from "../auth/password.js";
import { adminPermissions, adminRolePermissions, adminRoles, adminUserRoles, users } from "../db/schema.js";
import { assertMutableIntegrationTestDatabase } from "../testing/database-safety.js";
import { createReturn, updateReturn } from "./service.js";

const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
const marker = `return-api-${suffix}`;
const password = "ReturnApiTestPassword1";
const customerEmail = `${marker}-customer@example.com`;
const regularEmail = `${marker}-regular@example.com`;
const limitedEmail = `${marker}-limited@example.com`;
const adminEmail = `${marker}-admin@example.com`;

class Client {
  private cookies = new Map<string, string>();
  constructor(private readonly baseUrl: string) {}

  async request(path: string, init: RequestInit = {}, csrf: "auto" | "none" | "invalid" = "auto") {
    const headers = new Headers(init.headers);
    if (init.body && !headers.has("content-type") && !(init.body instanceof FormData)) headers.set("content-type", "application/json");
    if (this.cookies.size) headers.set("cookie", [...this.cookies].map(([key, value]) => `${key}=${value}`).join("; "));
    if (csrf !== "none" && !["GET", "HEAD"].includes(init.method?.toUpperCase() ?? "GET")) {
      const token = csrf === "invalid" ? "invalid-csrf-token" : this.cookies.get("lizzor_csrf");
      if (token) headers.set("x-csrf-token", decodeURIComponent(token));
    }
    const response = await fetch(`${this.baseUrl}/api/v1${path}`, { ...init, headers });
    const getSetCookie = (response.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie;
    const setCookies = getSetCookie ? getSetCookie.call(response.headers) : (response.headers.get("set-cookie")?.split(/,(?=[^;]+?=)/) ?? []);
    for (const cookie of setCookies) {
      const [pair] = cookie.split(";");
      const separator = pair.indexOf("=");
      const name = pair.slice(0, separator);
      const value = pair.slice(separator + 1);
      if (value) this.cookies.set(name, value);
      else this.cookies.delete(name);
    }
    const contentType = response.headers.get("content-type") ?? "";
    const body = contentType.includes("application/json") ? await response.json() : await response.arrayBuffer();
    return { response, body };
  }
}

async function run() {
  assertMutableIntegrationTestDatabase("fulfillment return API integration");
  const pool = getDatabasePool();
  const app = await createApp({ serveFrontend: false });
  const server: Server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const anonymous = new Client(baseUrl);
  const regular = new Client(baseUrl);
  const customerClient = new Client(baseUrl);
  const limited = new Client(baseUrl);
  const admin = new Client(baseUrl);
  const companyBuyerA = new Client(baseUrl);
  const companyBuyerB = new Client(baseUrl);
  const companyViewer = new Client(baseUrl);
  const companyOwner = new Client(baseUrl);
  const companyAdmin = new Client(baseUrl);
  const companySuspended = new Client(baseUrl);
  const companyBMember = new Client(baseUrl);
  const personalOutsider = new Client(baseUrl);
  let customerId = "";
  let regularId = "";
  let limitedId = "";
  let adminId = "";
  let customerRoleId = "";
  let limitedRoleId = "";
  let fullRoleId = "";
  let categoryId = "";
  let productId = "";
  let orderId = "";
  let itemId = "";
  let warehouseId = "";
  let returnOneId = "";
  let returnTwoId = "";
  let attachmentId = "";
  let companyOrderId = "";
  let companyItemId = "";
  let viewerOwnedOrderId = "";
  let viewerOwnedItemId = "";
  let companyAId = "";
  let companyBId = "";
  const companyUserIds: string[] = [];
  let testFailure: unknown;
  try {
    const customer = (await pool.query("INSERT INTO users (email,password_hash,first_name,last_name,status,email_verified_at) VALUES ($1,$2,'Return','Customer','active',now()) RETURNING id", [customerEmail, await hashPassword(password)])).rows[0];
    customerId = customer.id;
    regularId = (await pool.query("INSERT INTO users (email,password_hash,first_name,last_name,status,email_verified_at) VALUES ($1,$2,'Regular','User','active',now()) RETURNING id", [regularEmail, await hashPassword(password)])).rows[0].id;
    limitedId = (await pool.query("INSERT INTO users (email,password_hash,first_name,last_name,status,email_verified_at) VALUES ($1,$2,'Limited','Admin','active',now()) RETURNING id", [limitedEmail, await hashPassword(password)])).rows[0].id;
    adminId = (await pool.query("INSERT INTO users (email,password_hash,first_name,last_name,status,email_verified_at) VALUES ($1,$2,'Full','Admin','active',now()) RETURNING id", [adminEmail, await hashPassword(password)])).rows[0].id;

    const requiredPermissions = (await pool.query<{ id: string; permissionKey: string }>(
      "SELECT id,permission_key AS \"permissionKey\" FROM admin_permissions WHERE permission_key=ANY($1::text[])",
      [["dashboard.view", "returns.view", "returns.manage"]],
    )).rows;
    assert.equal(requiredPermissions.length, 3, "the migrated return API permission catalog must be present");
    const permissionIds = new Map(requiredPermissions.map((permission) => [permission.permissionKey, permission.id]));
    const dashboardPermission = permissionIds.get("dashboard.view")!;
    const returnsView = permissionIds.get("returns.view")!;
    const returnsManage = permissionIds.get("returns.manage")!;
    customerRoleId = (await pool.query("INSERT INTO admin_roles (name) VALUES ($1) RETURNING id", [`${marker}-customer-role`])).rows[0].id;
    limitedRoleId = (await pool.query("INSERT INTO admin_roles (name) VALUES ($1) RETURNING id", [`${marker}-limited-role`])).rows[0].id;
    fullRoleId = (await pool.query("INSERT INTO admin_roles (name) VALUES ($1) RETURNING id", [`${marker}-full-role`])).rows[0].id;
    await pool.query("INSERT INTO admin_role_permissions (role_id,permission_id) VALUES ($1,$2),($3,$4),($3,$5)", [limitedRoleId, dashboardPermission, fullRoleId, dashboardPermission, returnsView]);
    await pool.query("INSERT INTO admin_role_permissions (role_id,permission_id) VALUES ($1,$2)", [fullRoleId, returnsManage]);
    await pool.query("INSERT INTO admin_user_roles (user_id,role_id) VALUES ($1,$2),($3,$4)", [limitedId, limitedRoleId, adminId, fullRoleId]);
    if (process.env.RETURN_API_TEST_FORCE_FAILURE_AFTER_FIXTURES === "1") {
      throw new Error("Forced return API integration failure after role fixtures.");
    }

    categoryId = (await pool.query("INSERT INTO categories (name,slug) VALUES ($1,$2) RETURNING id", [marker, marker])).rows[0].id;
    productId = (await pool.query("INSERT INTO products (name,slug,parent_sku,category_id,description,cost_price,base_price,vat_rate,weight,status) VALUES ($1,$2,$3,$4,$5,5,10,19,1,'active') RETURNING id", [marker, `${marker}-product`, `${marker}-sku`, categoryId, marker])).rows[0].id;
    warehouseId = (await pool.query("INSERT INTO warehouses (name,code,country_code) VALUES ($1,$2,'CY') RETURNING id", [marker, marker.slice(-40)])).rows[0].id;
    const variantId = (await pool.query("INSERT INTO product_variants (product_id,sku,title,weight,active) VALUES ($1,$2,'Case',1,true) RETURNING id", [productId, `${marker}-variant`])).rows[0].id;
    await pool.query("INSERT INTO inventory (warehouse_id,variant_id,quantity_on_hand) VALUES ($1,$2,5)", [warehouseId, variantId]);
    orderId = (await pool.query("INSERT INTO orders (order_number,user_id,status,payment_status,fulfillment_stage,fulfillment_status,subtotal,grand_total,billing_address_snapshot,shipping_address_snapshot) VALUES ($1,$2,'completed','paid','delivered','fulfilled',20,20,'{}','{}') RETURNING id", [`LZ-${suffix}`, customerId])).rows[0].id;
    itemId = (await pool.query("INSERT INTO order_items (order_id,product_id,variant_id,sku_snapshot,product_name_snapshot,variant_name_snapshot,quantity,unit_price,cost_price_snapshot,tax_rate_snapshot,line_total) VALUES ($1,$2,$3,$4,$5,'Case',20,10,5,19,200) RETURNING id", [orderId, productId, variantId, `${marker}-variant`, marker])).rows[0].id;
    const evidence = Buffer.from("%PDF-1.7\nprivate evidence bytes");
    const evidenceFilename = `${randomUUID()}.pdf`;
    returnOneId = (await createReturn(orderId, { userId: customerId }, { reason: "Damaged", items: [{ orderItemId: itemId, quantity: 1 }], attachments: [{ filename: evidenceFilename, mimeType: "application/pdf", sizeBytes: evidence.length, data: evidence }] })).id;
    returnTwoId = (await createReturn(orderId, { userId: customerId }, { reason: "Wrong item", items: [{ orderItemId: itemId, quantity: 1 }] })).id;
    await updateReturn(returnOneId, "approved", "Approved for receipt", adminId);
    const list = await pool.query("SELECT id FROM return_attachments WHERE return_request_id=$1", [returnOneId]);
    attachmentId = list.rows[0].id;

    // Company orders are owned by their placing buyer, while active owners and
    // admins may work across the company. Other memberships must not reveal them.
    const companyUsers = await Promise.all(["buyer-a", "buyer-b", "viewer", "owner", "company-admin", "suspended", "company-b", "personal"].map(async (name) => {
      const email = `${marker}-${name}@example.com`;
      const row = (await pool.query(
        "INSERT INTO users (email,password_hash,first_name,last_name,status,email_verified_at) VALUES ($1,$2,$3,'Company','active',now()) RETURNING id",
        [email, await hashPassword(password), name],
      )).rows[0];
      companyUserIds.push(row.id);
      return { id: row.id as string, email };
    }));
    const [buyerAUser, buyerBUser, viewerUser, ownerUser, companyAdminUser, suspendedUser, companyBUser, personalUser] = companyUsers;
    companyAId = (await pool.query(
      "INSERT INTO companies (company_name,vat_number,contact_person,email,status) VALUES ($1,$2,'Company',$3,'active') RETURNING id",
      [`${marker}-company-a`, `VAT-A-${suffix.slice(-24)}`, `${marker}-company-a@example.com`],
    )).rows[0].id;
    companyBId = (await pool.query(
      "INSERT INTO companies (company_name,vat_number,contact_person,email,status) VALUES ($1,$2,'Company',$3,'active') RETURNING id",
      [`${marker}-company-b`, `VAT-B-${suffix.slice(-24)}`, `${marker}-company-b@example.com`],
    )).rows[0].id;
    await pool.query(
      `INSERT INTO company_users (company_id,user_id,role,status) VALUES
        ($1,$2,'buyer','active'),($1,$3,'buyer','active'),($1,$4,'viewer','active'),
        ($1,$5,'owner','active'),($1,$6,'admin','active'),($1,$7,'buyer','suspended'),
        ($8,$9,'buyer','active')`,
      [companyAId, buyerAUser.id, buyerBUser.id, viewerUser.id, ownerUser.id, companyAdminUser.id, suspendedUser.id, companyBId, companyBUser.id],
    );
    companyOrderId = (await pool.query(
      "INSERT INTO orders (order_number,user_id,company_id,status,payment_status,fulfillment_stage,fulfillment_status,subtotal,grand_total,billing_address_snapshot,shipping_address_snapshot) VALUES ($1,$2,$3,'completed','paid','delivered','fulfilled',20,20,'{}','{}') RETURNING id",
      [`LZ-company-${suffix}`, buyerAUser.id, companyAId],
    )).rows[0].id;
    companyItemId = (await pool.query(
      "INSERT INTO order_items (order_id,product_id,variant_id,sku_snapshot,product_name_snapshot,variant_name_snapshot,quantity,unit_price,cost_price_snapshot,tax_rate_snapshot,line_total) VALUES ($1,$2,$3,$4,$5,'Case',20,10,5,19,200) RETURNING id",
      [companyOrderId, productId, variantId, `${marker}-variant`, marker],
    )).rows[0].id;
    viewerOwnedOrderId = (await pool.query(
      "INSERT INTO orders (order_number,user_id,company_id,status,payment_status,fulfillment_stage,fulfillment_status,subtotal,grand_total,billing_address_snapshot,shipping_address_snapshot) VALUES ($1,$2,$3,'completed','paid','delivered','fulfilled',20,20,'{}','{}') RETURNING id",
      [`LZ-viewer-${suffix}`, viewerUser.id, companyAId],
    )).rows[0].id;
    viewerOwnedItemId = (await pool.query(
      "INSERT INTO order_items (order_id,product_id,variant_id,sku_snapshot,product_name_snapshot,variant_name_snapshot,quantity,unit_price,cost_price_snapshot,tax_rate_snapshot,line_total) VALUES ($1,$2,$3,$4,$5,'Case',20,10,5,19,200) RETURNING id",
      [viewerOwnedOrderId, productId, variantId, `${marker}-variant`, marker],
    )).rows[0].id;
    const companyClients = [
      [companyBuyerA, buyerAUser.email], [companyBuyerB, buyerBUser.email], [companyViewer, viewerUser.email],
      [companyOwner, ownerUser.email], [companyAdmin, companyAdminUser.email], [companySuspended, suspendedUser.email],
      [companyBMember, companyBUser.email], [personalOutsider, personalUser.email],
    ] as const;
    for (const [client, email] of companyClients) {
      await client.request("/auth/me");
      assert.equal((await client.request("/auth/login", { method: "POST", body: JSON.stringify({ email, password }) })).response.status, 200);
    }
    const companyReturn = () => returnForm(companyItemId, "company-proof.pdf", "application/pdf", Buffer.from("%PDF-1.7\nproof"));
    assert.equal((await companyBuyerA.request(`/account/orders/${companyOrderId}/tracking`)).response.status, 200);
    assert.equal((await companyBuyerA.request(`/account/orders/${companyOrderId}/returns`)).response.status, 200);
    assert.equal((await companyBuyerA.request(`/account/orders/${companyOrderId}/returns`, { method: "POST", body: companyReturn() })).response.status, 201);
    for (const client of [companyOwner, companyAdmin]) {
      assert.equal((await client.request(`/account/orders/${companyOrderId}/tracking`)).response.status, 200);
      assert.equal((await client.request(`/account/orders/${companyOrderId}/returns`)).response.status, 200);
      assert.equal((await client.request(`/account/orders/${companyOrderId}/returns`, { method: "POST", body: companyReturn() })).response.status, 201);
    }
    assert.equal((await companyViewer.request(`/account/orders/${viewerOwnedOrderId}/tracking`)).response.status, 200);
    assert.equal((await companyViewer.request(`/account/orders/${viewerOwnedOrderId}/returns`)).response.status, 200);
    assert.equal(
      (await companyViewer.request(`/account/orders/${viewerOwnedOrderId}/returns`, {
        method: "POST",
        body: returnForm(viewerOwnedItemId, "viewer-proof.pdf", "application/pdf", Buffer.from("%PDF-1.7\nproof")),
      })).response.status,
      404,
      "viewers must remain read-only even for an order they placed",
    );
    const deniedCompanyClients = [companyBuyerB, companyViewer, companySuspended, companyBMember, personalOutsider];
    for (const client of deniedCompanyClients) {
      assert.equal((await client.request(`/account/orders/${companyOrderId}/tracking`)).response.status, 404);
      assert.equal((await client.request(`/account/orders/${companyOrderId}/returns`)).response.status, 404);
      const before = Number((await pool.query("SELECT count(*)::int AS count FROM return_requests WHERE order_id=$1", [companyOrderId])).rows[0].count);
      assert.equal((await client.request(`/account/orders/${companyOrderId}/returns`, { method: "POST", body: companyReturn() })).response.status, 404);
      assert.equal(Number((await pool.query("SELECT count(*)::int AS count FROM return_requests WHERE order_id=$1", [companyOrderId])).rows[0].count), before);
    }
    const unknownOrderId = randomUUID();
    assert.equal((await personalOutsider.request(`/account/orders/${unknownOrderId}/tracking`)).response.status, 404);
    assert.equal((await personalOutsider.request(`/account/orders/${unknownOrderId}/returns`)).response.status, 404);
    assert.equal((await personalOutsider.request(`/account/orders/${unknownOrderId}/returns`, { method: "POST", body: companyReturn() })).response.status, 404);

    assert.equal((await anonymous.request("/admin/returns")).response.status, 403);
    assert.equal((await anonymous.request(`/admin/returns/${returnOneId}/attachments/${attachmentId}`)).response.status, 403);
    assert.equal((await regular.request("/auth/me")).response.status, 200);
    assert.equal((await regular.request("/auth/login", { method: "POST", body: JSON.stringify({ email: regularEmail, password }) })).response.status, 200);
    assert.equal((await regular.request("/admin/returns")).response.status, 403);
    await customerClient.request("/auth/me");
    assert.equal((await customerClient.request("/auth/login", { method: "POST", body: JSON.stringify({ email: customerEmail, password }) })).response.status, 200);
    for (const [name, type, bytes] of [
      ["proof.pdf", "application/pdf", Buffer.from("%PDF-1.7\nproof")],
      ["proof.jpg", "image/jpeg", Buffer.from([0xff, 0xd8, 0xff, 0x00])],
      ["proof.png", "image/png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
      ["proof.webp", "image/webp", Buffer.from("RIFFxxxxWEBP")],
    ] as const) {
      const form = returnForm(itemId, name, type, bytes);
      assert.equal((await customerClient.request(`/account/orders/${orderId}/returns`, { method: "POST", body: form })).response.status, 201);
    }
    assert.equal((await customerClient.request(`/account/orders/${orderId}/returns`, { method: "POST", body: returnForm(itemId, "proof.pdf", "application/pdf", Buffer.from("not a pdf")) })).response.status, 400);
    assert.equal((await customerClient.request(`/account/orders/${orderId}/returns`, { method: "POST", body: returnForm(itemId, "proof.txt", "application/pdf", Buffer.from("%PDF-1.7")) })).response.status, 400);
    const tooMany = new FormData(); tooMany.set("reason", "Damaged"); tooMany.set("items", JSON.stringify([{ orderItemId: itemId, quantity: 1 }]));
    for (let index = 0; index < 4; index += 1) tooMany.append("attachments", new Blob([Buffer.from("%PDF-1.7")], { type: "application/pdf" }), `proof-${index}.pdf`);
    assert.notEqual((await customerClient.request(`/account/orders/${orderId}/returns`, { method: "POST", body: tooMany })).response.status, 201);
    assert.notEqual((await customerClient.request(`/account/orders/${orderId}/returns`, { method: "POST", body: returnForm(itemId, "large.pdf", "application/pdf", Buffer.concat([Buffer.from("%PDF-1.7"), Buffer.alloc(5 * 1024 * 1024)])) })).response.status, 201);
    const aggregate = new FormData(); aggregate.set("reason", "Damaged"); aggregate.set("items", JSON.stringify([{ orderItemId: itemId, quantity: 1 }]));
    aggregate.append("attachments", new Blob([Buffer.concat([Buffer.from("%PDF-1.7"), Buffer.alloc(5 * 1024 * 1024 - 8)])], { type: "application/pdf" }), "one.pdf");
    aggregate.append("attachments", new Blob([Buffer.concat([Buffer.from("%PDF-1.7"), Buffer.alloc(5 * 1024 * 1024 - 8)])], { type: "application/pdf" }), "two.pdf");
    aggregate.append("attachments", new Blob([Buffer.from("%PDF-1.7")], { type: "application/pdf" }), "three.pdf");
    assert.equal((await customerClient.request(`/account/orders/${orderId}/returns`, { method: "POST", body: aggregate })).response.status, 400);
    const uploadedNames = await pool.query("SELECT filename FROM return_attachments WHERE return_request_id IN (SELECT id FROM return_requests WHERE order_id=$1)", [orderId]);
    assert.ok(uploadedNames.rows.some((row) => /^[0-9a-f-]{36}\.(pdf|jpg|png|webp)$/.test(row.filename)));
    assert.equal((await limited.request("/auth/me")).response.status, 200);
    assert.equal((await limited.request("/auth/admin/login", { method: "POST", body: JSON.stringify({ email: limitedEmail, password }) })).response.status, 200);
    assert.equal((await limited.request(`/admin/returns/${returnOneId}/attachments/${attachmentId}`)).response.status, 403);
    assert.equal((await admin.request("/auth/me")).response.status, 200);
    assert.equal((await admin.request("/auth/admin/login", { method: "POST", body: JSON.stringify({ email: adminEmail, password }) })).response.status, 200);
    const adminReturns = await admin.request("/admin/returns");
    assert.equal(adminReturns.response.status, 200);
    assert.equal(adminReturns.body.data.items.find((item: any) => item.id === returnOneId).attachments.length, 1);
    assert.equal((await admin.request(`/admin/returns/${returnTwoId}/attachments/${attachmentId}`)).response.status, 404);
    const download = await admin.request(`/admin/returns/${returnOneId}/attachments/${attachmentId}`);
    assert.equal(download.response.status, 200);
    assert.equal(download.response.headers.get("content-type"), "application/pdf");
    assert.equal(download.response.headers.get("content-disposition"), `attachment; filename="${evidenceFilename}"`);
    assert.equal(download.response.headers.get("cache-control"), "private, no-store");
    assert.equal(Buffer.from(download.body).toString(), "%PDF-1.7\nprivate evidence bytes");
    await pool.query("UPDATE return_attachments SET mime_type='text/html' WHERE id=$1", [attachmentId]);
    const fallbackDownload = await admin.request(`/admin/returns/${returnOneId}/attachments/${attachmentId}`);
    assert.equal(fallbackDownload.response.status, 200);
    assert.equal(fallbackDownload.response.headers.get("content-type"), "application/octet-stream");
    assert.equal((await admin.request(`/admin/returns/${returnTwoId}`, { method: "PATCH", body: JSON.stringify({ status: "in_review" }) }, "none")).response.status, 403);
    assert.equal((await admin.request(`/admin/returns/${returnTwoId}`, { method: "PATCH", body: JSON.stringify({ status: "in_review" }) }, "invalid")).response.status, 403);
    assert.equal((await admin.request(`/admin/returns/${returnTwoId}`, { method: "PATCH", body: JSON.stringify({ status: "in_review" }) })).response.status, 200);
    const firstReceipt = await admin.request(`/admin/returns/${returnOneId}/receive`, { method: "POST", body: JSON.stringify({ warehouseId }) });
    const secondReceipt = await admin.request(`/admin/returns/${returnOneId}/receive`, { method: "POST", body: JSON.stringify({ warehouseId }) });
    assert.equal(firstReceipt.response.status, 200);
    assert.equal(secondReceipt.response.status, 200);
    assert.equal(secondReceipt.body.data.replayed, true);
    assert.equal(Number((await pool.query("SELECT count(*)::int AS count FROM inventory_movements WHERE reference_type='return_request' AND reference_id=$1", [returnOneId])).rows[0].count), 1);
    console.info("Return evidence authorization, CSRF, download scoping, and receipt idempotency checks passed.");
  } catch (error) {
    testFailure = error;
  } finally {
    const cleanupErrors: Error[] = [];
    const cleanup = async (label: string, work: () => Promise<unknown>) => {
      try {
        await work();
      } catch (error) {
        cleanupErrors.push(new Error(`${label}: ${error instanceof Error ? error.message : String(error)}`, { cause: error }));
      }
    };
    const orderIds = [orderId, companyOrderId, viewerOwnedOrderId].filter(Boolean);
    const roleIds = [customerRoleId, limitedRoleId, fullRoleId].filter(Boolean);
    const userIds = [customerId, regularId, limitedId, adminId, ...companyUserIds].filter(Boolean);
    const companyIds = [companyAId, companyBId].filter(Boolean);
    const auditEntityIds = [...orderIds, returnOneId, returnTwoId, attachmentId, ...roleIds].filter(Boolean);

    await cleanup("stop HTTP server", () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
    for (const id of orderIds) {
      await cleanup(`delete return inventory movements for order ${id}`, () => pool.query("DELETE FROM inventory_movements WHERE reference_type='return_request' AND reference_id IN (SELECT id FROM return_requests WHERE order_id=$1)", [id]));
      await cleanup(`delete return requests for order ${id}`, () => pool.query("DELETE FROM return_requests WHERE order_id=$1", [id]));
    }
    if (auditEntityIds.length || userIds.length) {
      await cleanup("delete run-owned audit rows", () => pool.query(
        "DELETE FROM audit_logs WHERE entity_id=ANY($1::uuid[]) OR actor_admin_id=ANY($2::uuid[]) OR actor_user_id=ANY($2::uuid[])",
        [auditEntityIds, userIds],
      ));
    }
    if (orderIds.length) await cleanup("delete run-owned orders", () => pool.query("DELETE FROM orders WHERE id=ANY($1::uuid[])", [orderIds]));
    if (companyIds.length) await cleanup("delete run-owned companies", () => pool.query("DELETE FROM companies WHERE id=ANY($1::uuid[])", [companyIds]));
    if (warehouseId) await cleanup("delete run-owned warehouse", () => pool.query("DELETE FROM warehouses WHERE id=$1", [warehouseId]));
    if (productId) await cleanup("delete run-owned product", () => pool.query("DELETE FROM products WHERE id=$1", [productId]));
    if (categoryId) await cleanup("delete run-owned category", () => pool.query("DELETE FROM categories WHERE id=$1", [categoryId]));
    if (roleIds.length) {
      await cleanup("delete run-owned staff role assignments", () => pool.query("DELETE FROM admin_user_roles WHERE role_id=ANY($1::uuid[])", [roleIds]));
      await cleanup("delete run-owned permission relationships", () => pool.query("DELETE FROM admin_role_permissions WHERE role_id=ANY($1::uuid[])", [roleIds]));
      await cleanup("delete run-owned roles", () => pool.query("DELETE FROM admin_roles WHERE id=ANY($1::uuid[])", [roleIds]));
    }
    if (userIds.length) await cleanup("delete run-owned users", () => pool.query("DELETE FROM users WHERE id=ANY($1::uuid[])", [userIds]));
    await cleanup("close database pool", () => closeDatabase());

    if (testFailure || cleanupErrors.length) {
      throw new AggregateError(
        [...(testFailure ? [testFailure] : []), ...cleanupErrors],
        cleanupErrors.length ? "Return API integration or teardown failed." : "Return API integration failed.",
      );
    }
  }
}

function returnForm(itemId: string, filename: string, type: string, bytes: Buffer): FormData {
  const form = new FormData();
  form.set("reason", "Damaged");
  form.set("items", JSON.stringify([{ orderItemId: itemId, quantity: 1 }]));
  form.append("attachments", new Blob([Uint8Array.from(bytes)], { type }), filename);
  return form;
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});