import { Router } from "express";
import { z } from "zod";
import { randomBytes } from "node:crypto";
import { getCookie } from "../auth/cookies.js";
import { getDatabasePool } from "../db/client.js";
import { requireAdmin, requireAuth, requireCsrf, requirePermission } from "../middleware/auth.js";
import { AppError } from "../middleware/error-handler.js";
import { emitAdminNotification, emitNotification } from "../notifications/service.js";

const uuid = z.string().uuid();
const ticketStatuses = ["open", "in_progress", "waiting_customer", "resolved", "closed"] as const;
const priority = z.enum(["low", "normal", "high", "urgent"]);
const id = (value: string | string[]) => {
  const parsed = uuid.safeParse(value);
  if (!parsed.success) throw new AppError(400, "INVALID_ID", "A valid identifier is required.");
  return parsed.data;
};
const guestCookie = "lizzor_chat_guest";

async function assignedAdminExists(client: any, assignedAdminId: string | null) {
  if (!assignedAdminId) return true;
  const result = await client.query(
    `SELECT 1 FROM users u WHERE u.id=$1 AND u.status='active'
      AND EXISTS (SELECT 1 FROM admin_user_roles ur JOIN admin_roles r ON r.id=ur.role_id AND r.active=true WHERE ur.user_id=u.id)`,
    [assignedAdminId],
  );
  return Boolean(result.rowCount);
}

export const customerCareRouter = Router();

function customerUserId(request: any) {
  if (!request.auth || request.auth.type !== "customer") throw new AppError(403, "CUSTOMER_REQUIRED", "A customer account is required.");
  return request.auth.userId as string;
}

customerCareRouter.get("/support/tickets", requireAuth, async (request, response) => {
  const userId = customerUserId(request);
  const rows = await getDatabasePool().query(
    `SELECT t.id,t.ticket_number AS "ticketNumber",t.subject,t.status,t.created_at AS "createdAt",t.updated_at AS "updatedAt",
      c.company_name AS "companyName",o.order_number AS "orderNumber",
      (SELECT m.message FROM ticket_messages m WHERE m.ticket_id=t.id AND m.is_internal=false ORDER BY m.created_at DESC LIMIT 1) AS "lastMessage"
     FROM support_tickets t LEFT JOIN companies c ON c.id=t.company_id LEFT JOIN orders o ON o.id=t.related_order_id
     WHERE t.user_id=$1 OR t.company_id IN (SELECT company_id FROM company_users WHERE user_id=$1 AND status='active')
     ORDER BY t.updated_at DESC`,
    [userId],
  );
  response.json({ data: { items: rows.rows } });
});

customerCareRouter.post("/support/tickets", requireCsrf, requireAuth, async (request, response) => {
  const userId = customerUserId(request);
  const parsed = z.object({ subject: z.string().trim().min(3).max(250), message: z.string().trim().min(1).max(10000), companyId: uuid.nullable().optional(), orderId: uuid.nullable().optional() }).safeParse(request.body);
  if (!parsed.success) throw new AppError(400, "VALIDATION_ERROR", "A subject and message are required.", parsed.error.flatten());
  const client = await getDatabasePool().connect();
  try {
    await client.query("BEGIN");
    if (parsed.data.companyId && !(await client.query("SELECT 1 FROM company_users WHERE company_id=$1 AND user_id=$2 AND status='active'", [parsed.data.companyId, userId])).rowCount) throw new AppError(404, "COMPANY_NOT_FOUND", "The company was not found.");
    let orderCompanyId: string | null = null;
    if (parsed.data.orderId) {
      const order = (await client.query("SELECT company_id AS \"companyId\" FROM orders WHERE id=$1 AND (user_id=$2 OR company_id IN (SELECT company_id FROM company_users WHERE user_id=$2 AND status='active'))", [parsed.data.orderId, userId])).rows[0];
      if (!order) throw new AppError(404, "ORDER_NOT_FOUND", "The order was not found.");
      orderCompanyId = order.companyId;
      if (parsed.data.companyId && orderCompanyId !== parsed.data.companyId) throw new AppError(400, "ORDER_COMPANY_MISMATCH", "The selected order does not belong to the selected company.");
    }
    const companyId = parsed.data.companyId ?? orderCompanyId;
    const ticketNumber = `TKT-${Date.now().toString(36).toUpperCase()}-${randomBytes(3).toString("hex").toUpperCase()}`;
    const ticket = (await client.query(`INSERT INTO support_tickets (ticket_number,user_id,company_id,related_order_id,subject) VALUES ($1,$2,$3,$4,$5) RETURNING id,ticket_number AS "ticketNumber",subject,status,created_at AS "createdAt"`, [ticketNumber, userId, companyId, parsed.data.orderId ?? null, parsed.data.subject])).rows[0];
    await client.query("INSERT INTO ticket_messages (ticket_id,author_user_id,message) VALUES ($1,$2,$3)", [ticket.id, userId, parsed.data.message]);
    await client.query("INSERT INTO audit_logs (actor_user_id,action,entity_type,entity_id,new_values_json) VALUES ($1,'support.ticket_created','support_ticket',$2,$3)", [userId, ticket.id, JSON.stringify({ companyId, orderId: parsed.data.orderId ?? null })]);
    await emitNotification({ type: "support.ticket_created", idempotencyKey: `support.ticket_created:${ticket.id}`, userId,
      message: `Support request ${ticket.ticketNumber} has been received. Our team will respond as soon as possible.`,
      metadata: { ticketId: ticket.id, ticketNumber: ticket.ticketNumber, path: "/support" } }, client);
    await emitAdminNotification("support.view", {
      type: "admin.support_ticket_created", idempotencyKey: `admin.support_ticket_created:${ticket.id}`,
      message: `Support request ${ticket.ticketNumber} has been created and is ready for review.`,
      metadata: { ticketId: ticket.id, ticketNumber: ticket.ticketNumber, path: "/admin/support" },
    }, client);
    await client.query("COMMIT");
    response.status(201).json({ data: ticket });
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
});

customerCareRouter.get("/support/tickets/:id", requireAuth, async (request, response) => {
  const userId = customerUserId(request), ticketId = id(request.params.id);
  const pool = getDatabasePool();
  const ticket = (await pool.query(`SELECT t.id,t.ticket_number AS "ticketNumber",t.subject,t.status,t.created_at AS "createdAt",t.updated_at AS "updatedAt",c.company_name AS "companyName",o.order_number AS "orderNumber" FROM support_tickets t LEFT JOIN companies c ON c.id=t.company_id LEFT JOIN orders o ON o.id=t.related_order_id WHERE t.id=$1 AND (t.user_id=$2 OR t.company_id IN (SELECT company_id FROM company_users WHERE user_id=$2 AND status='active'))`, [ticketId, userId])).rows[0];
  if (!ticket) throw new AppError(404, "TICKET_NOT_FOUND", "The support ticket was not found.");
  const messages = await pool.query(`SELECT m.id,m.message,m.created_at AS "createdAt",EXISTS (SELECT 1 FROM admin_user_roles ur WHERE ur.user_id=m.author_user_id) AS "isSupport" FROM ticket_messages m WHERE m.ticket_id=$1 AND m.is_internal=false ORDER BY m.created_at ASC,m.id ASC`, [ticketId]);
  response.json({ data: { ticket, messages: messages.rows } });
});

customerCareRouter.post("/support/tickets/:id/messages", requireCsrf, requireAuth, async (request, response) => {
  const userId = customerUserId(request), ticketId = id(request.params.id);
  const parsed = z.object({ message: z.string().trim().min(1).max(10000) }).safeParse(request.body);
  if (!parsed.success) throw new AppError(400, "VALIDATION_ERROR", "A non-empty support message is required.");
  const client = await getDatabasePool().connect();
  try {
    await client.query("BEGIN");
    const ticket = (await client.query(`SELECT id,status FROM support_tickets WHERE id=$1 AND (user_id=$2 OR company_id IN (SELECT company_id FROM company_users WHERE user_id=$2 AND status='active')) FOR UPDATE`, [ticketId, userId])).rows[0];
    if (!ticket) throw new AppError(404, "TICKET_NOT_FOUND", "The support ticket was not found.");
    if (ticket.status === "closed") throw new AppError(409, "TICKET_CLOSED", "Closed tickets cannot receive new replies.");
    const message = (await client.query(`INSERT INTO ticket_messages (ticket_id,author_user_id,message) VALUES ($1,$2,$3) RETURNING id,message,created_at AS "createdAt"`, [ticketId, userId, parsed.data.message])).rows[0];
    const nextStatus = ["resolved", "waiting_customer"].includes(ticket.status) ? "open" : ticket.status;
    await client.query("UPDATE support_tickets SET status=$2,updated_at=now() WHERE id=$1", [ticketId, nextStatus]);
    await client.query("INSERT INTO audit_logs (actor_user_id,action,entity_type,entity_id,old_values_json,new_values_json) VALUES ($1,'support.customer_replied','support_ticket',$2,$3,$4)", [userId, ticketId, JSON.stringify({ status: ticket.status }), JSON.stringify({ status: nextStatus })]);
    await client.query("COMMIT");
    response.status(201).json({ data: message });
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
});

customerCareRouter.get("/admin/support", requireAdmin, requirePermission("support.view"), async (request, response) => {
  const parsed = z.object({
    search: z.string().trim().max(120).optional(),
    status: z.enum(ticketStatuses).optional(),
    priority: priority.optional(),
    assignedAdminId: uuid.optional(),
    page: z.coerce.number().int().min(1).max(100000).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(25),
  }).safeParse(request.query);
  if (!parsed.success) throw new AppError(400, "VALIDATION_ERROR", "The support filters could not be validated.", parsed.error.flatten());
  const { search, status, priority: ticketPriority, assignedAdminId, page, pageSize } = parsed.data;
  const values: unknown[] = [];
  const conditions = ["1=1"];
  if (search) { values.push(`%${search}%`); conditions.push(`(t.ticket_number ILIKE $${values.length} OR t.subject ILIKE $${values.length} OR u.email ILIKE $${values.length} OR c.company_name ILIKE $${values.length})`); }
  if (status) { values.push(status); conditions.push(`t.status=$${values.length}`); }
  if (ticketPriority) { values.push(ticketPriority); conditions.push(`t.priority=$${values.length}`); }
  if (assignedAdminId) { values.push(assignedAdminId); conditions.push(`t.assigned_admin_id=$${values.length}`); }
  const where = conditions.join(" AND ");
  const pool = getDatabasePool();
  const count = await pool.query(`SELECT count(*)::int AS count FROM support_tickets t LEFT JOIN users u ON u.id=t.user_id LEFT JOIN companies c ON c.id=t.company_id WHERE ${where}`, values);
  const queryValues = [...values, pageSize, (page - 1) * pageSize];
  const rows = await pool.query(
    `SELECT t.id,t.ticket_number AS "ticketNumber",t.subject,t.status,t.priority,
            t.assigned_admin_id AS "assignedAdminId",t.created_at AS "createdAt",t.updated_at AS "updatedAt",
            u.id AS "userId",COALESCE(NULLIF(trim(u.first_name||' '||u.last_name),''),u.email) AS "customerName",u.email,
            c.id AS "companyId",c.company_name AS "companyName",
            (SELECT tm.message FROM ticket_messages tm WHERE tm.ticket_id=t.id AND tm.is_internal=false ORDER BY tm.created_at DESC LIMIT 1) AS "lastMessage",
            (SELECT tm.created_at FROM ticket_messages tm WHERE tm.ticket_id=t.id ORDER BY tm.created_at DESC LIMIT 1) AS "lastMessageAt"
       FROM support_tickets t LEFT JOIN users u ON u.id=t.user_id LEFT JOIN companies c ON c.id=t.company_id
      WHERE ${where} ORDER BY CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,t.updated_at DESC
      LIMIT $${queryValues.length - 1} OFFSET $${queryValues.length}`,
    queryValues,
  );
  response.json({ data: { items: rows.rows, meta: { page, pageSize, total: count.rows[0].count, hasNext: (page - 1) * pageSize + rows.rows.length < count.rows[0].count } } });
});

customerCareRouter.get("/admin/support/:id", requireAdmin, requirePermission("support.view"), async (request, response) => {
  const ticketId = id(request.params.id);
  const pool = getDatabasePool();
  const ticket = (await pool.query(
    `SELECT t.id,t.ticket_number AS "ticketNumber",t.subject,t.status,t.priority,t.assigned_admin_id AS "assignedAdminId",t.created_at AS "createdAt",t.updated_at AS "updatedAt",
      CASE WHEN u.id IS NULL THEN NULL ELSE json_build_object('id',u.id,'name',COALESCE(NULLIF(trim(u.first_name||' '||u.last_name),''),u.email),'email',u.email) END AS customer,
      CASE WHEN c.id IS NULL THEN NULL ELSE json_build_object('id',c.id,'name',c.company_name,'vatNumber',c.vat_number) END AS company,
      (SELECT json_agg(json_build_object('id',o.id,'orderNumber',o.order_number,'status',o.status,'createdAt',o.created_at) ORDER BY o.created_at DESC)
         FROM orders o WHERE o.id=t.related_order_id OR (t.related_order_id IS NULL AND ((t.user_id IS NOT NULL AND o.user_id=t.user_id) OR (t.company_id IS NOT NULL AND o.company_id=t.company_id)))) AS orders
      FROM support_tickets t LEFT JOIN users u ON u.id=t.user_id LEFT JOIN companies c ON c.id=t.company_id WHERE t.id=$1`,
    [ticketId],
  )).rows[0];
  if (!ticket) throw new AppError(404, "TICKET_NOT_FOUND", "The support ticket was not found.");
  const [messages, attachments] = await Promise.all([
    pool.query(`SELECT m.id,m.message,m.is_internal AS "isInternal",m.created_at AS "createdAt",u.id AS "authorId",COALESCE(NULLIF(trim(u.first_name||' '||u.last_name),''),u.email,'Customer') AS author FROM ticket_messages m LEFT JOIN users u ON u.id=m.author_user_id WHERE m.ticket_id=$1 ORDER BY m.created_at ASC,m.id ASC`, [ticketId]),
    pool.query(`SELECT id,message_id AS "messageId",file_name AS "fileName",url,mime_type AS "mimeType",created_at AS "createdAt" FROM ticket_attachments WHERE ticket_id=$1 ORDER BY created_at ASC`, [ticketId]),
  ]);
  response.json({ data: { ticket, messages: messages.rows, attachments: attachments.rows } });
});

customerCareRouter.patch("/admin/support/:id", requireCsrf, requireAdmin, requirePermission("support.manage"), async (request, response) => {
  const parsed = z.object({ status: z.enum(ticketStatuses).optional(), priority: priority.optional(), assignedAdminId: uuid.nullable().optional() }).safeParse(request.body);
  if (!parsed.success || !Object.keys(parsed.data).length) throw new AppError(400, "VALIDATION_ERROR", "A valid ticket update is required.");
  const ticketId = id(request.params.id);
  const client = await getDatabasePool().connect();
  try {
    await client.query("BEGIN");
    const old = (await client.query("SELECT id,status,priority,assigned_admin_id AS \"assignedAdminId\" FROM support_tickets WHERE id=$1 FOR UPDATE", [ticketId])).rows[0];
    if (!old) throw new AppError(404, "TICKET_NOT_FOUND", "The support ticket was not found.");
    if (parsed.data.assignedAdminId !== undefined && !(await assignedAdminExists(client, parsed.data.assignedAdminId))) throw new AppError(400, "INVALID_ASSIGNEE", "The assignee is not an active administrator.");
    const next = { status: parsed.data.status ?? old.status, priority: parsed.data.priority ?? old.priority, assignedAdminId: parsed.data.assignedAdminId === undefined ? old.assignedAdminId : parsed.data.assignedAdminId };
    await client.query("UPDATE support_tickets SET status=$1,priority=$2,assigned_admin_id=$3,updated_at=now() WHERE id=$4", [next.status, next.priority, next.assignedAdminId, ticketId]);
    await client.query("INSERT INTO audit_logs (actor_admin_id,action,entity_type,entity_id,old_values_json,new_values_json) VALUES ($1,'admin.support_ticket_updated','support_ticket',$2,$3,$4)", [request.auth!.userId, ticketId, JSON.stringify(old), JSON.stringify(next)]);
    await client.query("COMMIT");
    response.json({ data: { id: ticketId, ...next } });
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
});

customerCareRouter.post("/admin/support/:id/messages", requireCsrf, requireAdmin, requirePermission("support.manage"), async (request, response) => {
  const parsed = z.object({ message: z.string().trim().min(1).max(10000), internal: z.boolean().default(false), attachments: z.array(z.unknown()).max(10).optional() }).safeParse(request.body);
  if (!parsed.success) throw new AppError(400, "VALIDATION_ERROR", "A non-empty support message is required.", parsed.error.flatten());
  if (parsed.data.attachments?.length) throw new AppError(503, "ATTACHMENTS_UNAVAILABLE", "Attachment storage is not configured yet; send text without attachments.");
  const ticketId = id(request.params.id);
  const client = await getDatabasePool().connect();
  try {
    await client.query("BEGIN");
    const ticket = (await client.query("SELECT status FROM support_tickets WHERE id=$1 FOR UPDATE", [ticketId])).rows[0];
    if (!ticket) throw new AppError(404, "TICKET_NOT_FOUND", "The support ticket was not found.");
    if (ticket.status === "closed" && !parsed.data.internal) throw new AppError(409, "TICKET_CLOSED", "Closed tickets must be reopened before replying.");
    const message = (await client.query(`INSERT INTO ticket_messages (ticket_id,author_user_id,message,is_internal) VALUES ($1,$2,$3,$4) RETURNING id,message,is_internal AS "isInternal",created_at AS "createdAt"`, [ticketId, request.auth!.userId, parsed.data.message, parsed.data.internal])).rows[0];
    await client.query("UPDATE support_tickets SET updated_at=now() WHERE id=$1", [ticketId]);
    await client.query("INSERT INTO audit_logs (actor_admin_id,action,entity_type,entity_id,new_values_json) VALUES ($1,'admin.support_message_added','support_ticket',$2,$3)", [request.auth!.userId, ticketId, JSON.stringify({ messageId: message.id, internal: parsed.data.internal })]);
    await client.query("COMMIT");
    response.status(201).json({ data: message });
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
});

async function getChatIdentity(request: any, response: any) {
  if (request.auth?.type === "customer") return { userId: request.auth.userId, guestSessionId: null };
  if (request.auth?.type === "admin") throw new AppError(403, "CUSTOMER_CHAT_REQUIRED", "Administrator sessions cannot create customer chat messages.");
  let guestSessionId = getCookie(request, guestCookie);
  if (!guestSessionId) { guestSessionId = randomBytes(24).toString("base64url"); response.cookie(guestCookie, guestSessionId, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", maxAge: 180 * 24 * 60 * 60 * 1000 }); }
  return { userId: null, guestSessionId };
}

customerCareRouter.post("/chat/messages", requireCsrf, async (request, response) => {
  const parsed = z.object({ message: z.string().trim().min(1).max(5000) }).safeParse(request.body);
  if (!parsed.success) throw new AppError(400, "VALIDATION_ERROR", "A non-empty chat message is required.");
  const identity = await getChatIdentity(request, response);
  const client = await getDatabasePool().connect();
  try {
    await client.query("BEGIN");
    const session = identity.userId
      ? (await client.query(`INSERT INTO chat_sessions (user_id,guest_session_id) VALUES ($1,NULL)
          ON CONFLICT (user_id) WHERE status='open' AND user_id IS NOT NULL DO UPDATE SET updated_at=chat_sessions.updated_at RETURNING id,status`, [identity.userId])).rows[0]
      : (await client.query(`INSERT INTO chat_sessions (user_id,guest_session_id) VALUES (NULL,$1)
          ON CONFLICT (guest_session_id) WHERE status='open' AND guest_session_id IS NOT NULL DO UPDATE SET updated_at=chat_sessions.updated_at RETURNING id,status`, [identity.guestSessionId])).rows[0];
    const message = (await client.query(`INSERT INTO chat_messages (session_id,author_user_id,message) VALUES ($1,$2,$3) RETURNING id,message,created_at AS "createdAt"`, [session.id, identity.userId, parsed.data.message])).rows[0];
    await client.query("UPDATE chat_sessions SET updated_at=now() WHERE id=$1", [session.id]);
    await client.query("COMMIT");
    response.status(201).json({ data: { sessionId: session.id, message } });
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
});

customerCareRouter.get("/chat/session", async (request, response) => {
  if (request.auth?.type === "admin") throw new AppError(403, "CUSTOMER_CHAT_REQUIRED", "Administrator sessions cannot read customer chat.");
  const identity = await getChatIdentity(request, response);
  const userId = identity.userId;
  const guestSessionId = identity.guestSessionId;
  const pool = getDatabasePool();
  const session = (await pool.query(`SELECT id,status,created_at AS "createdAt",updated_at AS "updatedAt" FROM chat_sessions WHERE ${userId ? "user_id=$1" : "guest_session_id=$1"} ORDER BY created_at DESC LIMIT 1`, [userId ?? guestSessionId])).rows[0];
  if (!session) { response.json({ data: { session: null, messages: [] } }); return; }
  const messages = await pool.query(`SELECT m.id,m.message,m.created_at AS "createdAt",EXISTS (SELECT 1 FROM admin_user_roles ur WHERE ur.user_id=m.author_user_id) AS "isAdmin" FROM chat_messages m WHERE m.session_id=$1 ORDER BY m.created_at ASC,m.id ASC`, [session.id]);
  response.json({ data: { session, messages: messages.rows } });
});

customerCareRouter.get("/admin/chat", requireAdmin, requirePermission("chat.view"), async (request, response) => {
  const parsed = z.object({ status: z.enum(["open", "closed"]).default("open"), search: z.string().trim().max(120).optional(), page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(25) }).safeParse(request.query);
  if (!parsed.success) throw new AppError(400, "VALIDATION_ERROR", "The chat filters could not be validated.");
  const { status, search, page, pageSize } = parsed.data;
  const values: unknown[] = [status, request.auth!.userId];
  const conditions = ["s.status=$1"];
  if (search) { values.push(`%${search}%`); conditions.push(`(u.email ILIKE $${values.length} OR u.first_name ILIKE $${values.length} OR u.last_name ILIKE $${values.length} OR s.guest_session_id ILIKE $${values.length})`); }
  const where = conditions.join(" AND ");
  const pool = getDatabasePool();
  const countValues: unknown[] = [status];
  const countWhere = search ? "s.status=$1 AND (u.email ILIKE $2 OR u.first_name ILIKE $2 OR u.last_name ILIKE $2 OR s.guest_session_id ILIKE $2)" : "s.status=$1";
  if (search) countValues.push(`%${search}%`);
  const count = await pool.query(`SELECT count(*)::int AS count FROM chat_sessions s LEFT JOIN users u ON u.id=s.user_id WHERE ${countWhere}`, countValues);
  const queryValues = [...values, pageSize, (page - 1) * pageSize];
  const rows = await pool.query(`SELECT s.id,s.status,s.assigned_admin_id AS "assignedAdminId",s.created_at AS "createdAt",s.updated_at AS "updatedAt",r.last_read_at AS "lastReadAt",COALESCE(NULLIF(trim(u.first_name||' '||u.last_name),''),u.email,'Guest visitor') AS identity, u.email,(SELECT cm.message FROM chat_messages cm WHERE cm.session_id=s.id ORDER BY cm.created_at DESC LIMIT 1) AS "lastMessage",(SELECT cm.created_at FROM chat_messages cm WHERE cm.session_id=s.id ORDER BY cm.created_at DESC LIMIT 1) AS "lastMessageAt",(SELECT count(*)::int FROM chat_messages cm WHERE cm.session_id=s.id AND (r.last_read_at IS NULL OR cm.created_at>r.last_read_at) AND (cm.author_user_id IS NULL OR NOT EXISTS (SELECT 1 FROM admin_user_roles aur WHERE aur.user_id=cm.author_user_id))) AS unread FROM chat_sessions s LEFT JOIN users u ON u.id=s.user_id LEFT JOIN chat_session_reads r ON r.session_id=s.id AND r.admin_user_id=$2 WHERE ${where} ORDER BY s.updated_at DESC LIMIT $${queryValues.length - 1} OFFSET $${queryValues.length}`, queryValues);
  response.json({ data: { items: rows.rows, meta: { page, pageSize, total: count.rows[0].count, hasNext: (page - 1) * pageSize + rows.rows.length < count.rows[0].count } } });
});

customerCareRouter.get("/admin/chat/:id", requireAdmin, requirePermission("chat.view"), async (request, response) => {
  const sessionId = id(request.params.id);
  const pool = getDatabasePool();
  const session = (await pool.query(`SELECT s.id,s.status,s.assigned_admin_id AS "assignedAdminId",s.created_at AS "createdAt",s.updated_at AS "updatedAt",COALESCE(NULLIF(trim(u.first_name||' '||u.last_name),''),u.email,'Guest visitor') AS identity,u.email,s.user_id AS "userId" FROM chat_sessions s LEFT JOIN users u ON u.id=s.user_id WHERE s.id=$1`, [sessionId])).rows[0];
  if (!session) throw new AppError(404, "CHAT_NOT_FOUND", "The chat session was not found.");
  const messages = await pool.query(`SELECT m.id,m.message,m.created_at AS "createdAt",m.author_user_id AS "authorId",COALESCE(NULLIF(trim(u.first_name||' '||u.last_name),''),u.email,'Guest visitor') AS author,EXISTS (SELECT 1 FROM admin_user_roles ur WHERE ur.user_id=m.author_user_id) AS "isAdmin" FROM chat_messages m LEFT JOIN users u ON u.id=m.author_user_id WHERE m.session_id=$1 ORDER BY m.created_at ASC,m.id ASC`, [sessionId]);
  response.json({ data: { session, messages: messages.rows } });
});

customerCareRouter.post("/admin/chat/:id/read", requireCsrf, requireAdmin, requirePermission("chat.view"), async (request, response) => {
  const sessionId = id(request.params.id);
  const result = await getDatabasePool().query(`INSERT INTO chat_session_reads (session_id,admin_user_id,last_read_at)
    SELECT id,$2,now() FROM chat_sessions WHERE id=$1
    ON CONFLICT (session_id,admin_user_id) DO UPDATE SET last_read_at=EXCLUDED.last_read_at
    RETURNING session_id AS id,last_read_at AS "lastReadAt"`, [sessionId, request.auth!.userId]);
  if (!result.rows[0]) throw new AppError(404, "CHAT_NOT_FOUND", "The chat session was not found.");
  response.json({ data: result.rows[0] });
});

customerCareRouter.patch("/admin/chat/:id", requireCsrf, requireAdmin, requirePermission("chat.manage"), async (request, response) => {
  const parsed = z.object({ status: z.enum(["open", "closed"]).optional(), assignedAdminId: uuid.nullable().optional() }).safeParse(request.body);
  if (!parsed.success || !Object.keys(parsed.data).length) throw new AppError(400, "VALIDATION_ERROR", "A valid chat update is required.");
  const sessionId = id(request.params.id);
  const client = await getDatabasePool().connect();
  try {
    await client.query("BEGIN");
    const old = (await client.query("SELECT id,status,assigned_admin_id AS \"assignedAdminId\" FROM chat_sessions WHERE id=$1 FOR UPDATE", [sessionId])).rows[0];
    if (!old) throw new AppError(404, "CHAT_NOT_FOUND", "The chat session was not found.");
    if (parsed.data.assignedAdminId !== undefined && !(await assignedAdminExists(client, parsed.data.assignedAdminId))) throw new AppError(400, "INVALID_ASSIGNEE", "The assignee is not an active administrator.");
    const next = { status: parsed.data.status ?? old.status, assignedAdminId: parsed.data.assignedAdminId === undefined ? old.assignedAdminId : parsed.data.assignedAdminId };
    await client.query("UPDATE chat_sessions SET status=$1,assigned_admin_id=$2,updated_at=now() WHERE id=$3", [next.status, next.assignedAdminId, sessionId]);
    await client.query("INSERT INTO audit_logs (actor_admin_id,action,entity_type,entity_id,old_values_json,new_values_json) VALUES ($1,'admin.chat_updated','chat_session',$2,$3,$4)", [request.auth!.userId, sessionId, JSON.stringify(old), JSON.stringify(next)]);
    await client.query("COMMIT");
    response.json({ data: { id: sessionId, ...next } });
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
});

customerCareRouter.post("/admin/chat/:id/messages", requireCsrf, requireAdmin, requirePermission("chat.manage"), async (request, response) => {
  const parsed = z.object({ message: z.string().trim().min(1).max(5000) }).safeParse(request.body);
  if (!parsed.success) throw new AppError(400, "VALIDATION_ERROR", "A non-empty chat message is required.");
  const sessionId = id(request.params.id);
  const client = await getDatabasePool().connect();
  try {
    await client.query("BEGIN");
    const session = (await client.query("SELECT id,status FROM chat_sessions WHERE id=$1 FOR UPDATE", [sessionId])).rows[0];
    if (!session) throw new AppError(404, "CHAT_NOT_FOUND", "The chat session was not found.");
    if (session.status === "closed") throw new AppError(409, "CHAT_CLOSED", "Closed chats must be reopened before replying.");
    const message = (await client.query(`INSERT INTO chat_messages (session_id,author_user_id,message) VALUES ($1,$2,$3) RETURNING id,message,created_at AS "createdAt"`, [sessionId, request.auth!.userId, parsed.data.message])).rows[0];
    await client.query("UPDATE chat_sessions SET updated_at=now() WHERE id=$1", [sessionId]);
    await client.query("INSERT INTO audit_logs (actor_admin_id,action,entity_type,entity_id,new_values_json) VALUES ($1,'admin.chat_message_added','chat_session',$2,$3)", [request.auth!.userId, sessionId, JSON.stringify({ messageId: message.id })]);
    await client.query("COMMIT");
    response.status(201).json({ data: message });
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
});