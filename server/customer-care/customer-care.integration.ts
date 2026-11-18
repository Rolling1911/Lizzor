import assert from "node:assert/strict";
import type { Server } from "node:http";
import { createApp } from "../app.js";
import { closeDatabase, getDatabasePool } from "../db/client.js";
import { hashPassword } from "../auth/password.js";

class Client {
  private cookies = new Map<string, string>();
  constructor(private baseUrl: string) {}
  async request(path: string, init: RequestInit = {}, csrf: "auto" | "none" = "auto") {
    const headers = new Headers(init.headers);
    if (init.body) headers.set("content-type", "application/json");
    if (this.cookies.size) headers.set("cookie", [...this.cookies].map(([key, value]) => `${key}=${value}`).join("; "));
    if (csrf === "auto" && !["GET", "HEAD"].includes(init.method?.toUpperCase() ?? "GET")) {
      const token = this.cookies.get("lizzor_csrf");
      if (token) headers.set("x-csrf-token", decodeURIComponent(token));
    }
    const response = await fetch(`${this.baseUrl}/api/v1${path}`, { ...init, headers });
    const getter = (response.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie;
    const cookies = getter ? getter.call(response.headers) : (response.headers.get("set-cookie")?.split(/,(?=[^;]+?=)/) ?? []);
    for (const cookie of cookies) { const [pair] = cookie.split(";"); const split = pair.indexOf("="); const name = pair.slice(0, split), value = pair.slice(split + 1); if (value) this.cookies.set(name, value); else this.cookies.delete(name); }
    const body = response.status === 204 ? null : await response.json();
    return { response, body };
  }
}

async function verifyDuplicateUpgradePath() {
  const client = await getDatabasePool().connect();
  const guestId = `legacy-duplicate-${Date.now()}`;
  try {
    await client.query("BEGIN");
    await client.query('DROP INDEX IF EXISTS "chat_sessions_open_user_unique"');
    await client.query('DROP INDEX IF EXISTS "chat_sessions_open_guest_unique"');
    const first = (await client.query("INSERT INTO chat_sessions (guest_session_id,status) VALUES ($1,'open') RETURNING id", [guestId])).rows[0].id;
    const second = (await client.query("INSERT INTO chat_sessions (guest_session_id,status) VALUES ($1,'open') RETURNING id", [guestId])).rows[0].id;
    await client.query("INSERT INTO chat_messages (session_id,message) VALUES ($1,'Legacy first'),($2,'Legacy second')", [first, second]);
    await client.query(`CREATE TEMP TABLE chat_session_dedup_test ON COMMIT DROP AS
      WITH ranked AS (
        SELECT id,FIRST_VALUE(id) OVER (PARTITION BY user_id ORDER BY created_at ASC,id ASC) AS keep_id
        FROM chat_sessions WHERE status='open' AND user_id IS NOT NULL
        UNION ALL
        SELECT id,FIRST_VALUE(id) OVER (PARTITION BY guest_session_id ORDER BY created_at ASC,id ASC) AS keep_id
        FROM chat_sessions WHERE status='open' AND guest_session_id IS NOT NULL
      )
      SELECT id AS duplicate_id,keep_id FROM ranked WHERE id<>keep_id`);
    await client.query("UPDATE chat_messages m SET session_id=d.keep_id FROM chat_session_dedup_test d WHERE m.session_id=d.duplicate_id");
    await client.query("UPDATE chat_sessions s SET status='closed',updated_at=now() FROM chat_session_dedup_test d WHERE s.id=d.duplicate_id");
    assert.equal(Number((await client.query("SELECT count(*) AS count FROM chat_sessions WHERE guest_session_id=$1 AND status='open'", [guestId])).rows[0].count), 1);
    assert.equal(Number((await client.query("SELECT count(*) AS count FROM chat_messages WHERE session_id=(SELECT id FROM chat_sessions WHERE guest_session_id=$1 AND status='open')", [guestId])).rows[0].count), 2);
    await client.query("ROLLBACK");
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}

async function run() {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const pool = getDatabasePool();
  const app = await createApp({ serveFrontend: false });
  const server: Server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const manager = new Client(base), viewer = new Client(base), customer = new Client(base), outsider = new Client(base), guest = new Client(base), otherGuest = new Client(base), concurrentGuest = new Client(base);
  let managerId = "", viewerId = "", customerId = "", outsiderId = "", roleId = "", viewerRoleId = "", ticketId = "", createdTicketId = "", chatId = "", concurrentChatId = "";
  try {
    const password = "CustomerCareIntegration1";
    const passwordHash = await hashPassword(password);
    await pool.query(`INSERT INTO admin_permissions (permission_key,description) VALUES ('support.view','View support'),('support.manage','Manage support'),('chat.view','View chat'),('chat.manage','Manage chat') ON CONFLICT (permission_key) DO NOTHING`);
    roleId = (await pool.query("INSERT INTO admin_roles (name) VALUES ($1) RETURNING id", [`Care manager ${suffix}`])).rows[0].id;
    viewerRoleId = (await pool.query("INSERT INTO admin_roles (name) VALUES ($1) RETURNING id", [`Care viewer ${suffix}`])).rows[0].id;
    await pool.query("INSERT INTO admin_role_permissions (role_id,permission_id) SELECT $1,id FROM admin_permissions WHERE permission_key=ANY($2::text[])", [roleId, ["support.view", "support.manage", "chat.view", "chat.manage"]]);
    await pool.query("INSERT INTO admin_role_permissions (role_id,permission_id) SELECT $1,id FROM admin_permissions WHERE permission_key=ANY($2::text[])", [viewerRoleId, ["support.view", "chat.view"]]);
    managerId = (await pool.query("INSERT INTO users (email,password_hash,first_name,last_name,status,email_verified_at) VALUES ($1,$2,'Care','Manager','active',now()) RETURNING id", [`care-manager-${suffix}@example.test`, passwordHash])).rows[0].id;
    viewerId = (await pool.query("INSERT INTO users (email,password_hash,first_name,last_name,status,email_verified_at) VALUES ($1,$2,'Care','Viewer','active',now()) RETURNING id", [`care-viewer-${suffix}@example.test`, passwordHash])).rows[0].id;
    customerId = (await pool.query("INSERT INTO users (email,password_hash,first_name,last_name,status,email_verified_at) VALUES ($1,$2,'Ticket','Customer','active',now()) RETURNING id", [`care-customer-${suffix}@example.test`, passwordHash])).rows[0].id;
    outsiderId = (await pool.query("INSERT INTO users (email,password_hash,first_name,last_name,status,email_verified_at) VALUES ($1,$2,'Other','Customer','active',now()) RETURNING id", [`care-outsider-${suffix}@example.test`, passwordHash])).rows[0].id;
    await pool.query("INSERT INTO admin_user_roles (user_id,role_id) VALUES ($1,$2),($3,$4)", [managerId, roleId, viewerId, viewerRoleId]);
    ticketId = (await pool.query("INSERT INTO support_tickets (ticket_number,user_id,subject) VALUES ($1,$2,'Where is my order?') RETURNING id", [`CARE-${suffix}`, customerId])).rows[0].id;
    await pool.query("INSERT INTO ticket_messages (ticket_id,author_user_id,message) VALUES ($1,$2,'Please help with my delivery.')", [ticketId, customerId]);
    await manager.request("/auth/me"); await viewer.request("/auth/me");
    assert.equal((await manager.request("/auth/admin/login", { method: "POST", body: JSON.stringify({ email: `care-manager-${suffix}@example.test`, password }) })).response.status, 200);
    assert.equal((await viewer.request("/auth/admin/login", { method: "POST", body: JSON.stringify({ email: `care-viewer-${suffix}@example.test`, password }) })).response.status, 200);
    await customer.request("/auth/me"); await outsider.request("/auth/me");
    assert.equal((await customer.request("/auth/login", { method: "POST", body: JSON.stringify({ email: `care-customer-${suffix}@example.test`, password }) })).response.status, 200);
    assert.equal((await outsider.request("/auth/login", { method: "POST", body: JSON.stringify({ email: `care-outsider-${suffix}@example.test`, password }) })).response.status, 200);
    assert.equal((await viewer.request("/admin/support")).response.status, 200);
    assert.equal((await viewer.request(`/admin/support/${ticketId}`, { method: "PATCH", body: JSON.stringify({ priority: "urgent" }) })).response.status, 403);
    assert.equal((await manager.request(`/admin/support/${ticketId}`, { method: "PATCH", body: JSON.stringify({ priority: "urgent" }) }, "none")).response.status, 403);
    assert.equal((await manager.request(`/admin/support/${ticketId}`, { method: "PATCH", body: JSON.stringify({ priority: "urgent", status: "in_progress", assignedAdminId: managerId }) })).response.status, 200);
    assert.equal((await manager.request(`/admin/support/${ticketId}/messages`, { method: "POST", body: JSON.stringify({ message: "Checking the order.", internal: true }) })).response.status, 201);
    const detail = await manager.request(`/admin/support/${ticketId}`);
    assert.equal(detail.response.status, 200); assert.equal(detail.body.data.ticket.priority, "urgent"); assert.equal(detail.body.data.messages.length, 2);
    const customerDetail = await customer.request(`/support/tickets/${ticketId}`);
    assert.equal(customerDetail.response.status, 200); assert.equal(customerDetail.body.data.messages.length, 1, "internal notes must never cross the customer boundary");
    assert.equal((await outsider.request(`/support/tickets/${ticketId}`)).response.status, 404, "tickets must be customer-owned");
    assert.equal((await customer.request(`/support/tickets/${ticketId}/messages`, { method: "POST", body: JSON.stringify({ message: "Thank you, any update?" }) })).response.status, 201);
    const createdTicket = await customer.request("/support/tickets", { method: "POST", body: JSON.stringify({ subject: "Invoice question", message: "Please help with my invoice." }) });
    assert.equal(createdTicket.response.status, 201); createdTicketId = createdTicket.body.data.id;
    const customerAudits = await pool.query("SELECT action FROM audit_logs WHERE actor_user_id=$1 AND entity_id=ANY($2::uuid[])", [customerId, [ticketId, createdTicketId]]);
    assert.ok(customerAudits.rows.some((row) => row.action === "support.ticket_created"));
    assert.ok(customerAudits.rows.some((row) => row.action === "support.customer_replied"));

    await guest.request("/auth/me");
    const sent = await guest.request("/chat/messages", { method: "POST", body: JSON.stringify({ message: "Can someone help?" }) });
    assert.equal(sent.response.status, 201); chatId = sent.body.data.sessionId;
    const inbox = await manager.request("/admin/chat?status=open");
    assert.equal(inbox.response.status, 200);
    const chat = inbox.body.data.items.find((item: any) => item.id === chatId); assert.ok(chat); assert.equal(chat.unread, 1); assert.match(chat.identity, /Guest/);
    assert.equal((await manager.request(`/admin/chat/${chatId}/read`, { method: "POST" }, "none")).response.status, 403);
    const adminChatDetail = await manager.request(`/admin/chat/${chatId}`);
    assert.equal(adminChatDetail.response.status, 200);
    assert.equal("guestSessionId" in adminChatDetail.body.data.session, false, "guest identity tokens must not be exposed");
    assert.equal((await manager.request(`/admin/chat/${chatId}/read`, { method: "POST" })).response.status, 200);
    const viewerInbox = await viewer.request("/admin/chat?status=open");
    assert.equal(viewerInbox.body.data.items.find((item: any) => item.id === chatId).unread, 1, "one agent must not clear another agent's unread state");
    assert.equal((await viewer.request(`/admin/chat/${chatId}/messages`, { method: "POST", body: JSON.stringify({ message: "Not allowed" }) })).response.status, 403);
    assert.equal((await manager.request(`/admin/chat/${chatId}/messages`, { method: "POST", body: JSON.stringify({ message: "How can we help?" }) })).response.status, 201);
    const guestHistory = await guest.request("/chat/session");
    assert.equal(guestHistory.response.status, 200); assert.equal(guestHistory.body.data.messages.length, 2);
    assert.equal((await otherGuest.request("/chat/session")).body.data.session, null, "guest chat history must be isolated by opaque cookie identity");
    assert.equal((await manager.request(`/admin/chat/${chatId}`, { method: "PATCH", body: JSON.stringify({ status: "closed", assignedAdminId: managerId }) })).response.status, 200);
    assert.equal((await manager.request(`/admin/chat/${chatId}/messages`, { method: "POST", body: JSON.stringify({ message: "Closed reply" }) })).response.status, 409);
    assert.equal((await manager.request("/chat/messages", { method: "POST", body: JSON.stringify({ message: "Admin masquerade" }) })).response.status, 403);
    await concurrentGuest.request("/auth/me");
    await concurrentGuest.request("/chat/session");
    const concurrent = await Promise.all(Array.from({ length: 4 }, (_, index) => concurrentGuest.request("/chat/messages", { method: "POST", body: JSON.stringify({ message: `Concurrent ${index}` }) })));
    assert.ok(concurrent.every((entry) => entry.response.status === 201));
    assert.equal(new Set(concurrent.map((entry) => entry.body.data.sessionId)).size, 1, "concurrent first messages must converge on one open session");
    concurrentChatId = concurrent[0].body.data.sessionId;
    await verifyDuplicateUpgradePath();
    const auditCount = Number((await pool.query("SELECT count(*) AS count FROM audit_logs WHERE actor_admin_id=$1 AND entity_id=ANY($2::uuid[])", [managerId, [ticketId, chatId]])).rows[0].count);
    assert.ok(auditCount >= 4);
    console.log("customer care integration passed");
  } finally {
    const ids = [managerId, viewerId, customerId, outsiderId].filter(Boolean), roles = [roleId, viewerRoleId].filter(Boolean);
    const ticketIds = [ticketId, createdTicketId].filter(Boolean);
    if (ticketIds.length) await pool.query("DELETE FROM support_tickets WHERE id=ANY($1::uuid[])", [ticketIds]).catch(() => undefined);
    const chatIds = [chatId, concurrentChatId].filter(Boolean);
    if (chatIds.length) await pool.query("DELETE FROM chat_sessions WHERE id=ANY($1::uuid[])", [chatIds]).catch(() => undefined);
    if (ids.length) { await pool.query("DELETE FROM audit_logs WHERE actor_admin_id=ANY($1::uuid[]) OR actor_user_id=ANY($1::uuid[])", [ids]).catch(() => undefined); await pool.query("DELETE FROM users WHERE id=ANY($1::uuid[])", [ids]).catch(() => undefined); }
    if (roles.length) await pool.query("DELETE FROM admin_roles WHERE id=ANY($1::uuid[])", [roles]).catch(() => undefined);
    await new Promise<void>((resolve) => server.close(() => resolve())); await closeDatabase();
  }
}
run().catch((error) => { console.error(error); process.exitCode = 1; });