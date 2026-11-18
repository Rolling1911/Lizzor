import { Router } from "express";
import { z } from "zod";
import { getDatabasePool } from "../db/client.js";
import { AppError } from "../middleware/error-handler.js";
import { requireAdmin, requireAuth, requireCsrf, requirePermission } from "../middleware/auth.js";
import { enqueueAdminTestEmail, listNotifications, markAllNotificationsRead, markNotificationRead, retryNotificationDelivery } from "../notifications/service.js";

const id = z.string().uuid();
const optionalTypes = z.enum(["account.updates"]);
export const notificationsRouter = Router();

notificationsRouter.get("/account/notifications", requireAuth, async (req, res) => {
  const limit = typeof req.query.limit === "string" ? Number(req.query.limit) : 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new AppError(400, "INVALID_PAGINATION", "Limit must be between 1 and 100.");
  res.json({ data: await listNotifications(req.auth!.userId, limit) });
});
notificationsRouter.patch("/account/notifications/:id/read", requireCsrf, requireAuth, async (req, res) => {
  const parsed = id.safeParse(req.params.id);
  if (!parsed.success) throw new AppError(400, "INVALID_ID", "A valid identifier is required.");
  if (!await markNotificationRead(req.auth!.userId, parsed.data)) throw new AppError(404, "NOTIFICATION_NOT_FOUND", "The notification was not found.");
  res.status(204).end();
});
notificationsRouter.post("/account/notifications/read-all", requireCsrf, requireAuth, async (req, res) => {
  await markAllNotificationsRead(req.auth!.userId);
  res.status(204).end();
});
notificationsRouter.get("/account/notification-preferences", requireAuth, async (req, res) => {
  const rows = await getDatabasePool().query("SELECT event_type AS \"eventType\",in_app_enabled AS \"inAppEnabled\",email_enabled AS \"emailEnabled\",updated_at AS \"updatedAt\" FROM notification_preferences WHERE user_id=$1", [req.auth!.userId]);
  const stored = rows.rows.find((row) => row.eventType === "account.updates");
  res.json({ data: [{ eventType: "account.updates", inAppEnabled: stored?.inAppEnabled ?? true, emailEnabled: stored?.emailEnabled ?? true, updatedAt: stored?.updatedAt ?? null }] });
});
notificationsRouter.put("/account/notification-preferences/:eventType", requireCsrf, requireAuth, async (req, res) => {
  const eventType = optionalTypes.safeParse(req.params.eventType);
  const body = z.object({ inAppEnabled: z.boolean(), emailEnabled: z.boolean() }).safeParse(req.body);
  if (!eventType.success || !body.success) throw new AppError(400, "VALIDATION_ERROR", "Only optional notification preferences may be changed.");
  await getDatabasePool().query(`INSERT INTO notification_preferences (user_id,event_type,in_app_enabled,email_enabled,updated_at)
    VALUES ($1,$2,$3,$4,now()) ON CONFLICT (user_id,event_type) DO UPDATE SET in_app_enabled=$3,email_enabled=$4,updated_at=now()`,
  [req.auth!.userId, eventType.data, body.data.inAppEnabled, body.data.emailEnabled]);
  res.status(204).end();
});
notificationsRouter.get("/admin/notification-deliveries", requireAdmin, requirePermission("notifications.view"), async (req, res) => {
  const query = z.object({
    status: z.enum(["pending", "processing", "sent", "failed", "suppressed"]).optional(),
    providerStatus: z.enum(["delivered", "delivery_delayed", "bounced", "complained", "failed"]).optional(),
    eventType: z.string().trim().max(100).optional(),
    search: z.string().trim().max(200).optional(),
    page: z.coerce.number().int().positive().default(1),
    pageSize: z.coerce.number().int().positive().max(100).default(50),
  }).safeParse(req.query);
  if (!query.success) throw new AppError(400, "INVALID_FILTERS", "Notification delivery filters are invalid.");
  const { status, providerStatus, eventType, search, page, pageSize } = query.data;
  const values: unknown[] = [];
  const conditions: string[] = [];
  if (status) { values.push(status); conditions.push(`d.status=$${values.length}`); }
  if (providerStatus) { values.push(providerStatus); conditions.push(`d.provider_status=$${values.length}`); }
  if (eventType) { values.push(eventType); conditions.push(`d.event_type=$${values.length}`); }
  if (search) { values.push(`%${search}%`); conditions.push(`(d.recipient_email ILIKE $${values.length} OR d.provider_message_id ILIKE $${values.length})`); }
  values.push(pageSize, (page - 1) * pageSize);
  const rows = await getDatabasePool().query(`SELECT d.id,d.event_type AS "eventType",d.channel,d.status,d.attempts,d.max_attempts AS "maxAttempts",
    d.recipient_email AS "recipientEmail",d.subject,d.provider_message_id AS "providerMessageId",
    d.provider_status AS "providerStatus",d.provider_event_at AS "providerEventAt",d.suppression_reason AS "suppressionReason",
    d.last_error AS "lastError",d.created_at AS "createdAt",d.sent_at AS "sentAt",n.user_id AS "userId",
    count(*) OVER()::int AS "total"
    FROM notification_deliveries d LEFT JOIN notifications n ON n.id=d.notification_id
    ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
    ORDER BY d.created_at DESC LIMIT $${values.length - 1} OFFSET $${values.length}`, values);
  const unmatchedWebhookEvents = Number((await getDatabasePool().query(
    "SELECT count(*) FROM resend_webhook_events WHERE matched_delivery_id IS NULL AND created_at < now()-interval '15 minutes'",
  )).rows[0].count);
  res.json({ data: { items: rows.rows.map(({ total: _total, ...row }) => row), meta: { page, pageSize, total: Number(rows.rows[0]?.total ?? 0), unmatchedWebhookEvents } } });
});
notificationsRouter.post("/admin/notification-deliveries/test", requireCsrf, requireAdmin, requirePermission("notifications.manage"), async (req, res) => {
  await enqueueAdminTestEmail(req.auth!.userId);
  await getDatabasePool().query("INSERT INTO audit_logs (actor_admin_id,action,entity_type,new_values_json) VALUES ($1,'notification.test_email_queued','notification_delivery',$2)",
    [req.auth!.userId, JSON.stringify({ channel: "email" })]);
  res.status(202).json({ data: { status: "queued" } });
});
notificationsRouter.post("/admin/notification-deliveries/:id/retry", requireCsrf, requireAdmin, requirePermission("notifications.manage"), async (req, res) => {
  const parsed = id.safeParse(req.params.id);
  if (!parsed.success) throw new AppError(400, "INVALID_ID", "A valid identifier is required.");
  if (!await retryNotificationDelivery(parsed.data)) throw new AppError(409, "DELIVERY_NOT_RETRYABLE", "Only failed email deliveries can be retried.");
  await getDatabasePool().query("INSERT INTO audit_logs (actor_admin_id,action,entity_type,entity_id,new_values_json) VALUES ($1,'notification.delivery_retried','notification_delivery',$2,$3)",
    [req.auth!.userId, parsed.data, JSON.stringify({ status: "pending" })]);
  res.status(202).json({ data: { id: parsed.data, status: "pending" } });
});