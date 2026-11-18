import { Router } from "express";
import { z } from "zod";
import { getDatabasePool } from "../db/client.js";
import { auditSecurityEvent } from "../auth/service.js";
import { redactAuditValue } from "../audit/service.js";
import { requireAdmin, requireCsrf, requirePermission } from "../middleware/auth.js";
import { AppError } from "../middleware/error-handler.js";

const uuid = z.string().uuid();
export const queueKeys = [
  "new_orders",
  "payment_attention",
  "fulfillment_ready",
  "shipment_exceptions",
  "pending_returns",
  "pending_refunds",
  "inventory_alerts",
  "reservation_exceptions",
  "account_issues",
  "notification_failures",
] as const;
type QueueKey = typeof queueKeys[number];

const entityTypes = ["order", "payment", "refund", "return_request", "inventory", "user", "company", "shipment", "notification_delivery"] as const;
type EntityType = typeof entityTypes[number];

const pageSchema = z.coerce.number().int().min(1).max(10_000).default(1);
const pageSizeSchema = z.coerce.number().int().min(1).max(50).default(20);
const queueSchema = z.enum(queueKeys).default("new_orders");
const searchSchema = z.string().trim().max(120).optional();

type QueueRow = {
  id: string;
  kind: EntityType;
  title: string;
  subtitle: string | null;
  status: string;
  severity: "critical" | "warning" | "info";
  createdAt: string;
  updatedAt: string;
  amount: string | null;
  currency: string | null;
  href: string;
};

function queryParam(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function queueSql(queue: QueueKey) {
  switch (queue) {
    case "new_orders":
      return {
        count: `SELECT count(*)::text AS count FROM orders o
          LEFT JOIN users u ON u.id=o.user_id
          WHERE o.status='pending' AND ($1::text IS NULL OR o.order_number ILIKE $1 OR COALESCE(o.guest_email,u.email) ILIKE $1)`,
        rows: `SELECT o.id, 'order' AS kind, o.order_number AS title,
          COALESCE(o.guest_email,u.email) AS subtitle, o.status::text AS status,
          CASE WHEN o.reservation_expires_at < now() THEN 'critical' ELSE 'info' END AS severity,
          o.created_at AS "createdAt", o.updated_at AS "updatedAt", o.grand_total AS amount,
          o.currency, '/admin/orders/' || o.id AS href
          FROM orders o LEFT JOIN users u ON u.id=o.user_id
          WHERE o.status='pending' AND ($1::text IS NULL OR o.order_number ILIKE $1 OR COALESCE(o.guest_email,u.email) ILIKE $1)
          ORDER BY o.created_at DESC, o.id DESC LIMIT $2 OFFSET $3`,
      };
    case "payment_attention":
      return {
        count: `SELECT count(*)::text AS count FROM payments p
          JOIN orders o ON o.id=p.order_id
          WHERE (p.status IN ('pending','requires_action','processing','authorized','failed')
            OR EXISTS (SELECT 1 FROM payment_recovery_jobs j WHERE j.payment_id=p.id AND j.status IN ('pending','processing','failed')))
            AND ($1::text IS NULL OR o.order_number ILIKE $1 OR p.provider_payment_id ILIKE $1)`,
        rows: `SELECT p.id, 'payment' AS kind, o.order_number AS title,
          COALESCE(NULLIF(p.failure_reason,''), p.status::text) AS subtitle, p.status::text AS status,
          CASE WHEN p.status='failed' OR p.failure_reason IS NOT NULL THEN 'critical' ELSE 'warning' END AS severity,
          p.created_at AS "createdAt", p.updated_at AS "updatedAt", p.amount, p.currency,
          '/admin/payments/' || p.id AS href
          FROM payments p JOIN orders o ON o.id=p.order_id
          WHERE (p.status IN ('pending','requires_action','processing','authorized','failed')
            OR EXISTS (SELECT 1 FROM payment_recovery_jobs j WHERE j.payment_id=p.id AND j.status IN ('pending','processing','failed')))
            AND ($1::text IS NULL OR o.order_number ILIKE $1 OR p.provider_payment_id ILIKE $1)
          ORDER BY CASE WHEN p.status='failed' THEN 0 ELSE 1 END, p.updated_at ASC, p.id LIMIT $2 OFFSET $3`,
      };
    case "fulfillment_ready":
      return {
        count: `SELECT count(*)::text AS count FROM orders o
          LEFT JOIN users u ON u.id=o.user_id
          WHERE o.status <> 'cancelled' AND o.payment_status='paid' AND o.fulfillment_stage='unfulfilled'
            AND ($1::text IS NULL OR o.order_number ILIKE $1 OR COALESCE(o.guest_email,u.email) ILIKE $1)`,
        rows: `SELECT o.id, 'order' AS kind, o.order_number AS title,
          COALESCE(o.guest_email,u.email) AS subtitle, o.fulfillment_stage AS status, 'info' AS severity,
          o.created_at AS "createdAt", o.updated_at AS "updatedAt", o.grand_total AS amount,
          o.currency, '/admin/orders/' || o.id AS href
          FROM orders o LEFT JOIN users u ON u.id=o.user_id
          WHERE o.status <> 'cancelled' AND o.payment_status='paid' AND o.fulfillment_stage='unfulfilled'
            AND ($1::text IS NULL OR o.order_number ILIKE $1 OR COALESCE(o.guest_email,u.email) ILIKE $1)
          ORDER BY o.created_at ASC, o.id LIMIT $2 OFFSET $3`,
      };
    case "shipment_exceptions":
      return {
        count: `SELECT count(*)::text AS count FROM shipments s
          JOIN orders o ON o.id=s.order_id
          WHERE (s.status IN ('returned','cancelled')
            OR (s.status IN ('shipped','in_transit') AND (s.tracking_number IS NULL OR s.updated_at < now() - interval '7 days')))
            AND ($1::text IS NULL OR o.order_number ILIKE $1 OR s.courier ILIKE $1 OR s.tracking_number ILIKE $1)`,
        rows: `SELECT s.id, 'shipment' AS kind, o.order_number AS title,
          COALESCE(s.courier || CASE WHEN s.tracking_number IS NOT NULL THEN ' · ' || s.tracking_number ELSE '' END, s.status::text) AS subtitle,
          s.status::text AS status, CASE WHEN s.status IN ('returned','cancelled') THEN 'critical' ELSE 'warning' END AS severity,
          s.created_at AS "createdAt", s.updated_at AS "updatedAt", NULL::numeric AS amount, o.currency,
          '/admin/orders/' || o.id AS href
          FROM shipments s JOIN orders o ON o.id=s.order_id
          WHERE (s.status IN ('returned','cancelled')
            OR (s.status IN ('shipped','in_transit') AND (s.tracking_number IS NULL OR s.updated_at < now() - interval '7 days')))
            AND ($1::text IS NULL OR o.order_number ILIKE $1 OR s.courier ILIKE $1 OR s.tracking_number ILIKE $1)
          ORDER BY s.updated_at ASC, s.id LIMIT $2 OFFSET $3`,
      };
    case "pending_returns":
      return {
        count: `SELECT count(*)::text AS count FROM return_requests r
          JOIN orders o ON o.id=r.order_id
          WHERE r.status IN ('requested','in_review')
            AND ($1::text IS NULL OR o.order_number ILIKE $1 OR r.reason ILIKE $1)`,
        rows: `SELECT r.id, 'return_request' AS kind, o.order_number AS title,
          r.reason AS subtitle, r.status::text AS status, CASE WHEN r.status='requested' THEN 'critical' ELSE 'warning' END AS severity,
          r.created_at AS "createdAt", r.updated_at AS "updatedAt", NULL::numeric AS amount, o.currency,
          '/admin/returns' AS href
          FROM return_requests r JOIN orders o ON o.id=r.order_id
          WHERE r.status IN ('requested','in_review')
            AND ($1::text IS NULL OR o.order_number ILIKE $1 OR r.reason ILIKE $1)
          ORDER BY CASE WHEN r.status='requested' THEN 0 ELSE 1 END, r.created_at ASC, r.id LIMIT $2 OFFSET $3`,
      };
    case "pending_refunds":
      return {
        count: `SELECT count(*)::text AS count FROM refunds r
          JOIN orders o ON o.id=r.order_id
          WHERE r.status IN ('pending','processing','failed')
            AND ($1::text IS NULL OR o.order_number ILIKE $1 OR r.provider_reference ILIKE $1)`,
        rows: `SELECT r.id, 'refund' AS kind, o.order_number AS title,
          COALESCE(NULLIF(r.failure_reason,''), r.status::text) AS subtitle, r.status::text AS status,
          CASE WHEN r.status='failed' THEN 'critical' ELSE 'warning' END AS severity,
          r.created_at AS "createdAt", r.updated_at AS "updatedAt", r.amount, r.currency,
          CASE WHEN r.payment_id IS NOT NULL THEN '/admin/payments/' || r.payment_id ELSE '/admin/orders/' || o.id END AS href
          FROM refunds r JOIN orders o ON o.id=r.order_id
          WHERE r.status IN ('pending','processing','failed')
            AND ($1::text IS NULL OR o.order_number ILIKE $1 OR r.provider_reference ILIKE $1)
          ORDER BY CASE WHEN r.status='failed' THEN 0 ELSE 1 END, r.updated_at ASC, r.id LIMIT $2 OFFSET $3`,
      };
    case "inventory_alerts":
      return {
        count: `SELECT count(*)::text AS count FROM inventory i
          LEFT JOIN products p ON p.id=i.product_id
          LEFT JOIN product_variants pv ON pv.id=i.variant_id
          JOIN warehouses w ON w.id=i.warehouse_id
          WHERE i.quantity_on_hand-i.quantity_reserved <= i.low_stock_threshold
            AND ($1::text IS NULL OR COALESCE(pv.sku,p.parent_sku) ILIKE $1 OR COALESCE(p.name,pv.title) ILIKE $1 OR w.code ILIKE $1)`,
        rows: `SELECT i.id, 'inventory' AS kind, COALESCE(pv.sku,p.parent_sku) AS title,
          COALESCE(p.name,pv.title) || ' · ' || w.code AS subtitle,
          CASE WHEN i.quantity_on_hand-i.quantity_reserved <= 0 THEN 'out_of_stock' ELSE 'low_stock' END AS status,
          CASE WHEN i.quantity_on_hand-i.quantity_reserved <= 0 THEN 'critical' ELSE 'warning' END AS severity,
          i.updated_at AS "createdAt", i.updated_at AS "updatedAt", NULL::numeric AS amount, NULL::varchar AS currency,
          '/admin/inventory?productId=' || COALESCE(i.product_id,pv.product_id) AS href
          FROM inventory i LEFT JOIN products p ON p.id=i.product_id LEFT JOIN product_variants pv ON pv.id=i.variant_id
          JOIN warehouses w ON w.id=i.warehouse_id
          WHERE i.quantity_on_hand-i.quantity_reserved <= i.low_stock_threshold
            AND ($1::text IS NULL OR COALESCE(pv.sku,p.parent_sku) ILIKE $1 OR COALESCE(p.name,pv.title) ILIKE $1 OR w.code ILIKE $1)
          ORDER BY CASE WHEN i.quantity_on_hand-i.quantity_reserved <= 0 THEN 0 ELSE 1 END, i.updated_at ASC, i.id LIMIT $2 OFFSET $3`,
      };
    case "reservation_exceptions":
      return {
        count: `SELECT count(*)::text AS count FROM inventory_reservations ir
          JOIN orders o ON o.id=ir.order_id
          WHERE ir.status='active' AND (o.reservation_expires_at <= now() OR o.status='cancelled')
            AND ($1::text IS NULL OR o.order_number ILIKE $1)`,
        rows: `SELECT o.id, 'order' AS kind, o.order_number AS title,
          CASE WHEN o.status='cancelled' THEN 'cancelled order reservation' ELSE 'reservation expired' END AS subtitle,
          ir.status::text AS status, 'critical' AS severity, ir.created_at AS "createdAt", o.reservation_expires_at AS "updatedAt",
          NULL::numeric AS amount, o.currency, '/admin/orders/' || o.id AS href
          FROM inventory_reservations ir JOIN orders o ON o.id=ir.order_id
          WHERE ir.status='active' AND (o.reservation_expires_at <= now() OR o.status='cancelled')
            AND ($1::text IS NULL OR o.order_number ILIKE $1)
          ORDER BY o.reservation_expires_at ASC NULLS FIRST, ir.id LIMIT $2 OFFSET $3`,
      };
    case "account_issues":
      return {
        count: `SELECT count(*)::text AS count FROM (
          SELECT u.id FROM users u WHERE u.status='pending'
            AND ($1::text IS NULL OR u.email ILIKE $1 OR u.first_name ILIKE $1 OR u.last_name ILIKE $1)
          UNION ALL
          SELECT c.id FROM companies c WHERE c.status='pending'
            AND ($1::text IS NULL OR c.company_name ILIKE $1 OR c.email ILIKE $1)
        ) issues`,
        rows: `SELECT u.id, 'user' AS kind, COALESCE(NULLIF(trim(u.first_name || ' ' || u.last_name),''), u.email) AS title,
          u.email AS subtitle, u.status::text AS status, 'warning' AS severity, u.created_at AS "createdAt", u.updated_at AS "updatedAt",
          NULL::numeric AS amount, NULL::varchar AS currency, '/admin/customers/' || u.id AS href
          FROM users u WHERE u.status='pending' AND ($1::text IS NULL OR u.email ILIKE $1 OR u.first_name ILIKE $1 OR u.last_name ILIKE $1)
          UNION ALL
          SELECT c.id, 'company' AS kind, c.company_name AS title, c.email AS subtitle, c.status::text AS status, 'warning' AS severity,
          c.created_at AS "createdAt", c.updated_at AS "updatedAt", NULL::numeric AS amount, NULL::varchar AS currency, '/admin/companies/' || c.id AS href
          FROM companies c WHERE c.status='pending' AND ($1::text IS NULL OR c.company_name ILIKE $1 OR c.email ILIKE $1)
          ORDER BY "createdAt" ASC, id LIMIT $2 OFFSET $3`,
      };
    case "notification_failures":
      return {
        count: `SELECT count(*)::text AS count FROM notification_deliveries d
          WHERE d.status='failed' AND d.attempts >= d.max_attempts
            AND ($1::text IS NULL OR d.event_type ILIKE $1 OR d.channel ILIKE $1 OR d.last_error ILIKE $1)`,
        rows: `SELECT d.id, 'notification_delivery' AS kind, d.event_type AS title,
          COALESCE(NULLIF(d.last_error,''), d.channel) AS subtitle, d.status::text AS status, 'critical' AS severity,
          d.created_at AS "createdAt", d.updated_at AS "updatedAt", NULL::numeric AS amount, NULL::varchar AS currency,
          '/admin/notifications' AS href
          FROM notification_deliveries d
          WHERE d.status='failed' AND d.attempts >= d.max_attempts
            AND ($1::text IS NULL OR d.event_type ILIKE $1 OR d.channel ILIKE $1 OR d.last_error ILIKE $1)
          ORDER BY d.updated_at ASC, d.id LIMIT $2 OFFSET $3`,
      };
  }
}

function normalizeQueueRow(row: QueueRow): QueueRow {
  return {
    ...row,
    amount: row.amount === null ? null : String(row.amount),
    severity: row.severity === "critical" || row.severity === "warning" ? row.severity : "info",
  };
}

async function queueResult(queue: QueueKey, search: string | undefined, page: number, pageSize: number) {
  const pool = getDatabasePool();
  const term = search ? `%${search}%` : null;
  const sql = queueSql(queue);
  const [countResult, rowsResult] = await Promise.all([
    pool.query<{ count: string }>(sql.count, [term]),
    pool.query<QueueRow>(sql.rows, [term, pageSize, (page - 1) * pageSize]),
  ]);
  const total = Number(countResult.rows[0]?.count ?? 0);
  return {
    items: rowsResult.rows.map(normalizeQueueRow),
    meta: { page, pageSize, total, hasNext: page * pageSize < total },
  };
}

export const operationsRouter = Router();

operationsRouter.get("/admin/operations", requireAdmin, requirePermission("operations.view"), async (request, response) => {
  const page = pageSchema.parse(request.query.page);
  const pageSize = pageSizeSchema.parse(request.query.pageSize);
  const queue = queueSchema.parse(request.query.queue);
  const search = searchSchema.parse(request.query.search);
  const pool = getDatabasePool();
  const counts = await Promise.all(queueKeys.map(async (key) => {
    const result = await pool.query<{ count: string }>(queueSql(key).count, [null]);
    return [key, Number(result.rows[0]?.count ?? 0)] as const;
  }));
  response.json({
    data: {
      refreshedAt: new Date().toISOString(),
      queues: Object.fromEntries(counts),
      queue,
      result: await queueResult(queue, search, page, pageSize),
    },
  });
});

operationsRouter.get("/admin/operations/export", requireAdmin, requirePermission("operations.view"), async (request, response) => {
  const queue = queueSchema.parse(request.query.queue);
  const search = searchSchema.parse(request.query.search);
  const result = await queueResult(queue, search, 1, 5_000);
  const cell = (value: unknown) => {
    const raw = value === null || value === undefined ? "" : String(value);
    const text = /^[=+\-@]/.test(raw) ? `'${raw}` : raw;
    return /[",\n]/.test(text) ? `"${text.replaceAll("\"", "\"\"")}"` : text;
  };
  const headers = ["id", "type", "title", "status", "severity", "created_at", "updated_at", "amount", "currency", "admin_link"];
  const lines = [
    headers.join(","),
    ...result.items.map((item) => [item.id, item.kind, item.title, item.status, item.severity, item.createdAt, item.updatedAt, item.amount, item.currency, item.href].map(cell).join(",")),
  ];
  await auditSecurityEvent({ actorUserId: request.auth!.userId, action: "admin.operations_exported", entityType: "operations", request });
  response.setHeader("content-type", "text/csv; charset=utf-8");
  response.setHeader("content-disposition", `attachment; filename="lizzor-${queue}.csv"`);
  response.send(`${lines.join("\n")}\n`);
});

operationsRouter.get("/admin/operations/timeline/:entityType/:entityId", requireAdmin, requirePermission("operations.view"), async (request, response) => {
  const entityType = z.enum(entityTypes).parse(request.params.entityType);
  const entityId = uuid.parse(request.params.entityId);
  const pool = getDatabasePool();
  const [audits, notes] = await Promise.all([
    pool.query(`SELECT a.id, 'audit' AS source, a.action, a.new_values_json AS "details", a.created_at AS "createdAt",
      COALESCE(NULLIF(trim(u.first_name || ' ' || u.last_name),''), u.email) AS actor
      FROM audit_logs a LEFT JOIN users u ON u.id=COALESCE(a.actor_admin_id,a.actor_user_id)
      WHERE a.entity_type=$1 AND a.entity_id=$2 ORDER BY a.created_at DESC LIMIT 100`, [entityType, entityId]),
    pool.query(`SELECT n.id, 'note' AS source, 'internal_note' AS action, json_build_object('body',n.body) AS details,
      n.created_at AS "createdAt", COALESCE(NULLIF(trim(u.first_name || ' ' || u.last_name),''), u.email) AS actor
      FROM admin_operation_notes n JOIN users u ON u.id=n.created_by
      WHERE n.entity_type=$1 AND n.entity_id=$2 ORDER BY n.created_at DESC LIMIT 100`, [entityType, entityId]),
  ]);
  const items = [...audits.rows, ...notes.rows]
    .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime())
    .slice(0, 100)
    .map((item) => item.source === "audit" ? { ...item, details: redactAuditValue(item.details) } : item);
  await auditSecurityEvent({ actorUserId: request.auth!.userId, action: "admin.operations_timeline_viewed", entityType, entityId, request });
  response.json({ data: { entityType, entityId, items } });
});

operationsRouter.post("/admin/operations/notes", requireCsrf, requireAdmin, requirePermission("operations.manage"), async (request, response) => {
  const parsed = z.object({ entityType: z.enum(entityTypes), entityId: uuid, body: z.string().trim().min(1).max(5_000) }).safeParse(request.body);
  if (!parsed.success) throw new AppError(400, "VALIDATION_ERROR", "A note needs a supported record and a non-empty message.", parsed.error.flatten());
  const { entityType, entityId, body } = parsed.data;
  const client = await getDatabasePool().connect();
  try {
    await client.query("BEGIN");
    const existing = await client.query(`SELECT 1 FROM ${entityType === "order" ? "orders" : entityType === "payment" ? "payments" : entityType === "refund" ? "refunds" : entityType === "return_request" ? "return_requests" : entityType === "inventory" ? "inventory" : entityType === "user" ? "users" : entityType === "company" ? "companies" : entityType === "shipment" ? "shipments" : "notification_deliveries"} WHERE id=$1`, [entityId]);
    if (!existing.rowCount) throw new AppError(404, "OPERATIONS_ENTITY_NOT_FOUND", "The operational record was not found.");
    const inserted = await client.query(`INSERT INTO admin_operation_notes (entity_type,entity_id,body,created_by) VALUES ($1,$2,$3,$4) RETURNING id,entity_type AS "entityType",entity_id AS "entityId",body,created_by AS "createdBy",created_at AS "createdAt"`, [entityType, entityId, body, request.auth!.userId]);
    await client.query(`INSERT INTO audit_logs (actor_admin_id,action,entity_type,entity_id,new_values_json) VALUES ($1,'admin.operation_note_added',$2,$3,$4)`, [request.auth!.userId, entityType, entityId, JSON.stringify({ noteId: inserted.rows[0].id })]);
    await client.query("COMMIT");
    response.status(201).json({ data: inserted.rows[0] });
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
});