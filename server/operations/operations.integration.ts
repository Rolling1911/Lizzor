import assert from "node:assert/strict";
import type { Server } from "node:http";
import { createApp } from "../app.js";
import { closeDatabase, getDatabasePool } from "../db/client.js";
import { hashPassword } from "../auth/password.js";

const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
const marker = `operations-${suffix}`;
const password = "OperationsTestPassword1";

class Client {
  private cookies = new Map<string, string>();
  constructor(private readonly baseUrl: string) {}
  async request(path: string, init: RequestInit = {}, csrf: "auto" | "none" = "auto") {
    const headers = new Headers(init.headers);
    if (init.body) headers.set("content-type", "application/json");
    if (this.cookies.size) headers.set("cookie", [...this.cookies].map(([key, value]) => `${key}=${value}`).join("; "));
    if (csrf === "auto" && !["GET", "HEAD"].includes(init.method?.toUpperCase() ?? "GET")) {
      const token = this.cookies.get("lizzor_csrf");
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
    const body = contentType.includes("application/json") ? await response.json() : await response.text();
    return { response, body };
  }
}

async function run() {
  const pool = getDatabasePool();
  const app = await createApp({ serveFrontend: false });
  const server: Server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const anonymous = new Client(`http://127.0.0.1:${address.port}`);
  const viewer = new Client(`http://127.0.0.1:${address.port}`);
  const manager = new Client(`http://127.0.0.1:${address.port}`);
  let viewerId = "";
  let managerId = "";
  let viewerRoleId = "";
  let managerRoleId = "";
  let orderId = "";
  let returnId = "";
  let reservationId = "";
  let formulaUserId = "";
  let refundId = "";
  let paymentId = "";
  try {
    const passwordHash = await hashPassword(password);
    viewerId = (await pool.query("INSERT INTO users (email,password_hash,first_name,last_name,status,email_verified_at) VALUES ($1,$2,'Operations','Viewer','active',now()) RETURNING id", [`${marker}-viewer@example.com`, passwordHash])).rows[0].id;
    managerId = (await pool.query("INSERT INTO users (email,password_hash,first_name,last_name,status,email_verified_at) VALUES ($1,$2,'Operations','Manager','active',now()) RETURNING id", [`${marker}-manager@example.com`, passwordHash])).rows[0].id;
    const viewPermissionId = (await pool.query("INSERT INTO admin_permissions (permission_key) VALUES ('operations.view') ON CONFLICT (permission_key) DO UPDATE SET permission_key=EXCLUDED.permission_key RETURNING id")).rows[0].id;
    const managePermissionId = (await pool.query("INSERT INTO admin_permissions (permission_key) VALUES ('operations.manage') ON CONFLICT (permission_key) DO UPDATE SET permission_key=EXCLUDED.permission_key RETURNING id")).rows[0].id;
    const operationalPermissionIds = (await pool.query("INSERT INTO admin_permissions (permission_key) VALUES ('refunds.view'),('refunds.manage'),('activity.view'),('payments.recovery.manage'),('payments.reconcile') ON CONFLICT (permission_key) DO UPDATE SET permission_key=EXCLUDED.permission_key RETURNING id")).rows.map((row) => row.id);
    viewerRoleId = (await pool.query("INSERT INTO admin_roles (name) VALUES ($1) RETURNING id", [`${marker}-viewer`])).rows[0].id;
    managerRoleId = (await pool.query("INSERT INTO admin_roles (name) VALUES ($1) RETURNING id", [`${marker}-manager`])).rows[0].id;
    await pool.query("INSERT INTO admin_role_permissions (role_id,permission_id) VALUES ($1,$2),($3,$2),($3,$4)", [viewerRoleId, viewPermissionId, managerRoleId, managePermissionId]);
    for (const permissionId of operationalPermissionIds) await pool.query("INSERT INTO admin_role_permissions (role_id,permission_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [managerRoleId, permissionId]);
    await pool.query("INSERT INTO admin_user_roles (user_id,role_id) VALUES ($1,$2),($3,$4)", [viewerId, viewerRoleId, managerId, managerRoleId]);
    formulaUserId = (await pool.query("INSERT INTO users (email,first_name,last_name,status) VALUES ($1,'=1+1','Formula','pending') RETURNING id", [`${marker}-formula@example.com`])).rows[0].id;
    orderId = (await pool.query("INSERT INTO orders (order_number,user_id,status,payment_status,fulfillment_stage,fulfillment_status,subtotal,grand_total,billing_address_snapshot,shipping_address_snapshot,reservation_expires_at) VALUES ($1,$2,'pending','pending','unfulfilled','unfulfilled',25,25,'{}','{}',now()-interval '1 hour') RETURNING id", [`LZ-${suffix}`, managerId])).rows[0].id;
    paymentId = (await pool.query("INSERT INTO payments (order_id,provider,provider_payment_id,status,amount,currency,failure_reason) VALUES ($1,'fake',$2,'failed',25,'EUR','Test decline') RETURNING id", [orderId, marker])).rows[0].id;
    refundId = (await pool.query("INSERT INTO refunds (order_id,payment_id,amount,currency,status,reason) VALUES ($1,$2,5,'EUR','pending','Damaged on arrival') RETURNING id", [orderId, paymentId])).rows[0].id;
    returnId = (await pool.query("INSERT INTO return_requests (order_id,user_id,reason,status) VALUES ($1,$2,'Test return','requested') RETURNING id", [orderId, managerId])).rows[0].id;
    await pool.query("INSERT INTO audit_logs (actor_admin_id,action,entity_type,entity_id) VALUES ($1,'admin.return_reviewed','return_request',$2)", [managerId, returnId]);
    await pool.query("INSERT INTO audit_logs (actor_admin_id,action,entity_type,entity_id,new_values_json) VALUES ($1,'admin.refund_reviewed','refund',$2,$3)", [managerId, refundId, JSON.stringify({ status: "reviewed", email: "private@example.com", addressLine1: "Private street", vatNumber: "private-vat", nested: { accessToken: "must-not-leak", phone: "+357000000", note: "safe" } })]);
    const inventoryId = (await pool.query("SELECT id FROM inventory ORDER BY updated_at DESC LIMIT 1")).rows[0]?.id;
    assert.ok(inventoryId, "integration database needs an inventory row");
    reservationId = (await pool.query("INSERT INTO inventory_reservations (order_id,inventory_id,quantity,status) VALUES ($1,$2,1,'active') RETURNING id", [orderId, inventoryId])).rows[0].id;

    assert.equal((await anonymous.request("/admin/operations")).response.status, 403);
    await viewer.request("/auth/me");
    await manager.request("/auth/me");
    assert.equal((await viewer.request("/auth/admin/login", { method: "POST", body: JSON.stringify({ email: `${marker}-viewer@example.com`, password }) })).response.status, 200);
    assert.equal((await manager.request("/auth/admin/login", { method: "POST", body: JSON.stringify({ email: `${marker}-manager@example.com`, password }) })).response.status, 200);

    const queues = ["new_orders", "payment_attention", "fulfillment_ready", "shipment_exceptions", "pending_returns", "pending_refunds", "inventory_alerts", "reservation_exceptions", "account_issues", "notification_failures"];
    for (const queue of queues) {
      const result = await manager.request(`/admin/operations?queue=${queue}&page=1&pageSize=5`);
      assert.equal(result.response.status, 200, `${queue} should execute`);
      assert.equal(typeof result.body.data.queues[queue], "number");
      assert.ok(Array.isArray(result.body.data.result.items));
    }
    const filtered = await manager.request(`/admin/operations?queue=new_orders&search=${encodeURIComponent(`LZ-${suffix}`)}`);
    assert.equal(filtered.body.data.result.meta.total, 1);
    assert.equal(filtered.body.data.result.items[0].id, orderId);
    const reservations = await manager.request(`/admin/operations?queue=reservation_exceptions&search=${encodeURIComponent(`LZ-${suffix}`)}`);
    assert.equal(reservations.body.data.result.items[0].id, orderId);
    assert.equal((await manager.request("/admin/operations/notes", { method: "POST", body: JSON.stringify({ entityType: "order", entityId: reservations.body.data.result.items[0].id, body: "Reservation reviewed." }) })).response.status, 201);
    const returns = await manager.request(`/admin/operations?queue=pending_returns&search=${encodeURIComponent(`LZ-${suffix}`)}`);
    assert.equal(returns.body.data.result.items[0].kind, "return_request");
    const returnTimeline = await manager.request(`/admin/operations/timeline/return_request/${returnId}`);
    assert.ok(returnTimeline.body.data.items.some((item: any) => item.action === "admin.return_reviewed"));
    assert.equal((await manager.request("/admin/operations/notes", { method: "POST", body: JSON.stringify({ entityType: "return_request", entityId: returnId, body: "Return reviewed." }) })).response.status, 201);
    const refunds = await manager.request(`/admin/operations?queue=pending_refunds&search=${encodeURIComponent(`LZ-${suffix}`)}`);
    assert.equal(refunds.body.data.result.items.find((item: any) => item.id === refundId)?.href, `/admin/payments/${paymentId}`);
    assert.equal((await viewer.request("/admin/refunds")).response.status, 403);
    const refundWorkspace = await manager.request(`/admin/refunds?search=${encodeURIComponent(`LZ-${suffix}`)}&status=pending&page=1&pageSize=5`);
    assert.equal(refundWorkspace.response.status, 200);
    assert.equal(refundWorkspace.body.data.items[0].id, refundId);
    assert.equal(refundWorkspace.body.data.items[0].reason, "Damaged on arrival");
    assert.equal(refundWorkspace.body.data.items[0].paymentId, paymentId);
    const refundDetail = await manager.request(`/admin/refunds/${refundId}`);
    assert.equal(refundDetail.body.data.order.id, orderId);
    assert.equal(refundDetail.body.data.payment.id, paymentId);
    assert.equal((await manager.request("/admin/refunds?page=0")).response.status, 400);
    assert.equal((await manager.request("/admin/refunds?status=not-a-status")).response.status, 400);
    assert.equal((await manager.request(`/admin/payments/${paymentId}/refunds`, { method: "POST", body: JSON.stringify({ amount: 1, idempotencyKey: `${marker}-refund` }) }, "none")).response.status, 403);
    assert.equal((await manager.request(`/admin/refunds/${refundId}/reconcile`, { method: "POST", body: "{}" }, "none")).response.status, 403);
    assert.equal((await viewer.request("/admin/activity")).response.status, 403);
    const activity = await manager.request(`/admin/activity?search=${encodeURIComponent("admin.refund_reviewed")}&entityType=refund&page=1&pageSize=5`);
    assert.equal(activity.response.status, 200);
    const activityRow = activity.body.data.items.find((item: any) => item.entityId === refundId);
    assert.equal(activityRow.newValues.nested.accessToken, "[REDACTED]");
    assert.equal(activityRow.newValues.email, "[REDACTED]");
    assert.equal(activityRow.newValues.addressLine1, "[REDACTED]");
    assert.equal(activityRow.newValues.vatNumber, "[REDACTED]");
    assert.equal(activityRow.newValues.nested.phone, "[REDACTED]");
    assert.equal(activityRow.newValues.nested.note, "safe");
    const activityDetail = await manager.request(`/admin/activity/${activityRow.id}`);
    assert.equal(activityDetail.body.data.newValues.nested.accessToken, "[REDACTED]");
    const refundTimeline = await manager.request(`/admin/operations/timeline/refund/${refundId}`);
    const timelineAudit = refundTimeline.body.data.items.find((item: any) => item.action === "admin.refund_reviewed");
    assert.equal(timelineAudit.details.email, "[REDACTED]");
    assert.equal(timelineAudit.details.nested.accessToken, "[REDACTED]");
    assert.equal(timelineAudit.details.nested.note, "safe");
    assert.equal((await manager.request("/admin/activity?page=0")).response.status, 400);
    const inventory = await manager.request("/admin/operations?queue=inventory_alerts&pageSize=50");
    for (const item of inventory.body.data.result.items) assert.match(item.href, /^\/admin\/inventory\?productId=[0-9a-f-]{36}$/);

    assert.equal((await viewer.request("/admin/operations/notes", { method: "POST", body: JSON.stringify({ entityType: "order", entityId: orderId, body: "Viewer cannot add this." }) })).response.status, 403);
    assert.equal((await manager.request("/admin/operations/notes", { method: "POST", body: JSON.stringify({ entityType: "order", entityId: orderId, body: "Missing CSRF." }) }, "none")).response.status, 403);
    const note = await manager.request("/admin/operations/notes", { method: "POST", body: JSON.stringify({ entityType: "order", entityId: orderId, body: "Verify payment before release." }) });
    assert.equal(note.response.status, 201);

    const timeline = await manager.request(`/admin/operations/timeline/order/${orderId}`);
    assert.equal(timeline.response.status, 200);
    assert.ok(timeline.body.data.items.some((item: any) => item.source === "note" && item.details.body === "Verify payment before release."));
    const exported = await manager.request(`/admin/operations/export?queue=new_orders&search=${encodeURIComponent(`LZ-${suffix}`)}`);
    assert.equal(exported.response.status, 200);
    assert.match(exported.response.headers.get("content-type") ?? "", /text\/csv/);
    assert.match(exported.body, /id,type,title,status,severity,created_at,updated_at,amount,currency,admin_link/);
    assert.doesNotMatch(exported.body, /email|password|token/i);
    const accountExport = await manager.request(`/admin/operations/export?queue=account_issues&search=${encodeURIComponent(marker)}`);
    assert.match(accountExport.body, /,'=1\+1 Formula,/);
    assert.doesNotMatch(accountExport.body, /,=1\+1 Formula,/);
    const audited = await pool.query("SELECT action FROM audit_logs WHERE (actor_admin_id=$1 OR actor_user_id=$1) AND action IN ('admin.operation_note_added','admin.operations_exported')", [managerId]);
    assert.equal(new Set(audited.rows.map((row) => row.action)).size, 2);
    console.log("operations integration passed");
  } finally {
    if (managerId) await pool.query("DELETE FROM admin_operation_notes WHERE created_by=$1", [managerId]).catch(() => undefined);
    if (reservationId) await pool.query("DELETE FROM inventory_reservations WHERE id=$1", [reservationId]).catch(() => undefined);
    if (returnId) await pool.query("DELETE FROM return_requests WHERE id=$1", [returnId]).catch(() => undefined);
    if (refundId) await pool.query("DELETE FROM refunds WHERE id=$1", [refundId]).catch(() => undefined);
    if (orderId) await pool.query("DELETE FROM payments WHERE order_id=$1", [orderId]).catch(() => undefined);
    if (orderId) await pool.query("DELETE FROM orders WHERE id=$1", [orderId]).catch(() => undefined);
    if (viewerId || managerId) await pool.query("DELETE FROM audit_logs WHERE actor_admin_id=ANY($1::uuid[]) OR actor_user_id=ANY($1::uuid[])", [[viewerId, managerId].filter(Boolean)]).catch(() => undefined);
    if (viewerId || managerId) await pool.query("DELETE FROM admin_user_roles WHERE user_id=ANY($1::uuid[])", [[viewerId, managerId].filter(Boolean)]).catch(() => undefined);
    if (viewerRoleId || managerRoleId) await pool.query("DELETE FROM admin_role_permissions WHERE role_id=ANY($1::uuid[])", [[viewerRoleId, managerRoleId].filter(Boolean)]).catch(() => undefined);
    if (viewerRoleId || managerRoleId) await pool.query("DELETE FROM admin_roles WHERE id=ANY($1::uuid[])", [[viewerRoleId, managerRoleId].filter(Boolean)]).catch(() => undefined);
    if (viewerId || managerId || formulaUserId) await pool.query("DELETE FROM users WHERE id=ANY($1::uuid[])", [[viewerId, managerId, formulaUserId].filter(Boolean)]).catch(() => undefined);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await closeDatabase();
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});