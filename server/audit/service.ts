import { getDatabasePool } from "../db/client.js";

const sensitiveKey = /password|secret|token|credential|authorization|cookie|cvv|cvc|card|api[_-]?key|private[_-]?key|payload|phone|email|address|postal|vat|registration|tax[_-]?id|iban|swift|bank|account[_-]?(?:number|name)|ip[_-]?address/i;

export function redactAuditValue(value: unknown, key?: string): unknown {
  if (key && sensitiveKey.test(key)) return "[REDACTED]";
  if (Array.isArray(value)) return value.map((item) => redactAuditValue(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([entryKey, entryValue]) => [entryKey, redactAuditValue(entryValue, entryKey)]));
  }
  return value;
}

export type AuditFilters = {
  search?: string;
  action?: string;
  entityType?: string;
  from?: string;
  to?: string;
  page?: number;
  pageSize?: number;
};

function auditQuery(filters: AuditFilters) {
  const values: unknown[] = [];
  const clauses = ["1=1"];
  if (filters.search?.trim()) {
    values.push(`%${filters.search.trim()}%`);
    const parameter = `$${values.length}`;
    clauses.push(`(
      a.action ILIKE ${parameter}
      OR a.entity_type ILIKE ${parameter}
      OR COALESCE(a.entity_id::text, '') ILIKE ${parameter}
      OR COALESCE(NULLIF(trim(u.first_name || ' ' || u.last_name), ''), u.email, '') ILIKE ${parameter}
    )`);
  }
  if (filters.action?.trim()) {
    values.push(`%${filters.action.trim()}%`);
    clauses.push(`a.action ILIKE $${values.length}`);
  }
  if (filters.entityType?.trim()) {
    values.push(filters.entityType.trim());
    clauses.push(`a.entity_type = $${values.length}`);
  }
  if (filters.from) {
    values.push(filters.from);
    clauses.push(`a.created_at >= $${values.length}::timestamptz`);
  }
  if (filters.to) {
    values.push(filters.to);
    clauses.push(`a.created_at < $${values.length}::timestamptz`);
  }
  return { values, where: `WHERE ${clauses.join(" AND ")}` };
}

function serializeAudit(row: any) {
  return {
    id: row.id,
    actor: row.actor ?? null,
    actorUserId: row.actorUserId ?? null,
    action: row.action,
    entityType: row.entityType,
    entityId: row.entityId ?? null,
    oldValues: redactAuditValue(row.oldValues),
    newValues: redactAuditValue(row.newValues),
    createdAt: row.createdAt,
  };
}

const auditSelect = `
  SELECT a.id,
         COALESCE(NULLIF(trim(u.first_name || ' ' || u.last_name), ''), u.email) AS actor,
         COALESCE(a.actor_admin_id, a.actor_user_id) AS "actorUserId",
         a.action, a.entity_type AS "entityType", a.entity_id AS "entityId",
         a.old_values_json AS "oldValues", a.new_values_json AS "newValues",
         a.ip_address AS "ipAddress", a.created_at AS "createdAt"
    FROM audit_logs a
    LEFT JOIN users u ON u.id = COALESCE(a.actor_admin_id, a.actor_user_id)
`;

export async function listAdminAuditLogs(filters: AuditFilters = {}) {
  const page = Math.max(1, Math.floor(filters.page ?? 1));
  const pageSize = Math.min(100, Math.max(1, Math.floor(filters.pageSize ?? 25)));
  const { values, where } = auditQuery(filters);
  const pool = getDatabasePool();
  const count = await pool.query(`SELECT count(*)::text AS count FROM audit_logs a LEFT JOIN users u ON u.id = COALESCE(a.actor_admin_id, a.actor_user_id) ${where}`, values);
  const rowsValues = [...values, pageSize, (page - 1) * pageSize];
  const rows = await pool.query(`${auditSelect} ${where} ORDER BY a.created_at DESC, a.id DESC LIMIT $${rowsValues.length - 1} OFFSET $${rowsValues.length}`, rowsValues);
  const total = Number(count.rows[0]?.count ?? 0);
  return {
    items: rows.rows.map(serializeAudit),
    meta: { page, pageSize, total, hasNext: (page - 1) * pageSize + rows.rows.length < total },
  };
}

export async function getAdminAuditLog(id: string) {
  const result = await getDatabasePool().query(`${auditSelect} WHERE a.id = $1`, [id]);
  const row = result.rows[0];
  if (!row) return null;
  return serializeAudit(row);
}