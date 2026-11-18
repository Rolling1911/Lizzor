import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { emailService, type EmailService } from "../auth/email.js";
import { env } from "../config/env.js";
import { getDatabasePool } from "../db/client.js";
import { logger } from "../lib/logger.js";
import { renderNotificationEmail } from "./templates.js";
import { createOpaqueToken, hashOpaqueToken } from "../auth/tokens.js";
import { reconcilePendingResendWebhookEvents, reconcileResendWebhookEvents } from "./resend-webhooks.js";

export type NotificationEventType =
  | "order.created" | "payment.succeeded" | "payment.failed" | "refund.completed" | "refund.updated"
  | "order.cancelled" | "shipment.created" | "fulfillment.shipped" | "fulfillment.delivered" | "return.requested" | "return.updated"
  | "company.invitation" | "security.email_verification" | "security.password_reset"
  | "security.password_changed" | "security.admin_login" | "account.created" | "account.guest_order_claimed" | "account.updates"
  | "support.ticket_created" | "admin.order_created" | "admin.payment_failed" | "admin.support_ticket_created" | "system.test_email";

type Definition = { title: string; essential: boolean };
const definitions: Record<NotificationEventType, Definition> = {
  "order.created": { title: "Order received", essential: true },
  "payment.succeeded": { title: "Payment received", essential: true },
  "payment.failed": { title: "Payment failed", essential: true },
  "refund.completed": { title: "Refund completed", essential: true },
  "refund.updated": { title: "Refund status updated", essential: true },
  "order.cancelled": { title: "Order cancelled", essential: true },
  "shipment.created": { title: "Shipment prepared", essential: true },
  "fulfillment.shipped": { title: "Your order has shipped", essential: true },
  "fulfillment.delivered": { title: "Your order was delivered", essential: true },
  "return.requested": { title: "Return request received", essential: true },
  "return.updated": { title: "Return request updated", essential: true },
  "company.invitation": { title: "Company invitation", essential: true },
  "security.email_verification": { title: "Verify your email", essential: true },
  "security.password_reset": { title: "Reset your password", essential: true },
  "security.password_changed": { title: "Password changed", essential: true },
  "security.admin_login": { title: "Administrator sign-in", essential: true },
  "account.created": { title: "Welcome to Lizzor", essential: true },
  "account.guest_order_claimed": { title: "Order added to your account", essential: true },
  "account.updates": { title: "Account update", essential: false },
  "support.ticket_created": { title: "Support request received", essential: true },
  "admin.order_created": { title: "New order received", essential: true },
  "admin.payment_failed": { title: "Customer payment failed", essential: true },
  "admin.support_ticket_created": { title: "New support request", essential: true },
  "system.test_email": { title: "Lizzor transactional email test", essential: true },
};
const guestOrderEmailEvents = new Set<NotificationEventType>([
  "order.created", "payment.succeeded", "payment.failed", "refund.completed", "refund.updated",
  "order.cancelled", "shipment.created", "fulfillment.shipped", "fulfillment.delivered",
  "return.requested", "return.updated",
]);

export interface NotificationEvent {
  type: NotificationEventType;
  idempotencyKey: string;
  userId?: string;
  companyId?: string;
  email?: string;
  message: string;
  metadata?: Record<string, unknown>;
  /** Sensitive one-time value encrypted at rest and only expanded by the worker. */
  secureToken?: string;
}

const safeMetadata = (input: Record<string, unknown> = {}) => Object.fromEntries(
  Object.entries(input)
    .filter(([key, value]) => /^(orderId|orderNumber|paymentId|refundId|shipmentId|returnId|ticketId|ticketNumber|trackingUrl|trackingNumber|companyId|invitationId)$/i.test(key)
      && (typeof value === "string" || typeof value === "number" || typeof value === "boolean"))
    .map(([key, value]) => [key, typeof value === "string" ? value.slice(0, 500) : value]),
);
const key = (value: string) => createHash("sha256").update(value).digest("hex");
const secretKey = () => {
  if (!env.SESSION_SECRET && env.NODE_ENV === "production") throw new Error("SESSION_SECRET is required to encrypt notification secrets.");
  return createHash("sha256").update(env.SESSION_SECRET ?? "development-only-notification-key").digest();
};
function encryptSecret(value: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", secretKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return `${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${encrypted.toString("base64url")}`;
}
function decryptSecret(value: string): string {
  const [iv, tag, encrypted] = value.split(".");
  if (!iv || !tag || !encrypted) throw new Error("Invalid encrypted notification secret.");
  const decipher = createDecipheriv("aes-256-gcm", secretKey(), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(encrypted, "base64url")), decipher.final()]).toString("utf8");
}
function actionUrl(path: string): string {
  const origin = env.APP_ORIGIN ?? (env.NODE_ENV === "production" ? undefined : "http://localhost:5000");
  if (!origin) throw new Error("APP_ORIGIN is required for notification action links.");
  return new URL(path, origin).toString();
}

function notificationActionPath(eventType: NotificationEventType, metadata: Record<string, unknown> | null | undefined, secret?: string): string | undefined {
  if (secret) {
    const orderId = typeof metadata?.orderId === "string" ? encodeURIComponent(metadata.orderId) : undefined;
    if (orderId && metadata?.recipientKind === "email" && guestOrderEmailEvents.has(eventType)) {
      return `/guest-order/${orderId}#token=${encodeURIComponent(secret)}`;
    }
    const tokenPath = eventType === "company.invitation"
      ? "/account/invitations/accept"
      : eventType === "security.email_verification"
        ? "/verify-email"
        : eventType === "security.password_reset"
          ? "/reset-password"
          : undefined;
    return tokenPath ? `${tokenPath}?token=${encodeURIComponent(secret)}` : undefined;
  }
  const orderId = typeof metadata?.orderId === "string" ? encodeURIComponent(metadata.orderId) : undefined;
  const customerOrderPath = orderId && metadata?.recipientKind === "account" ? `/account/orders/${orderId}` : undefined;
  switch (eventType) {
    case "order.created":
    case "payment.succeeded":
    case "payment.failed":
    case "refund.completed":
    case "refund.updated":
    case "order.cancelled":
    case "account.guest_order_claimed":
      return customerOrderPath;
    case "shipment.created":
    case "fulfillment.shipped":
    case "fulfillment.delivered":
    case "return.requested":
    case "return.updated":
      return customerOrderPath;
    case "account.created":
    case "security.password_changed":
    case "account.updates":
      return "/account";
    case "support.ticket_created":
      return "/support";
    case "admin.order_created":
    case "admin.payment_failed":
      return orderId ? `/admin/orders/${orderId}` : "/admin";
    case "admin.support_ticket_created":
      return "/admin/support";
    case "security.admin_login":
      return "/admin";
    case "system.test_email":
      return "/admin/operations";
    default:
      return undefined;
  }
}

/** Persist a transactional event. It intentionally makes no provider call. */
export async function emitNotification(event: NotificationEvent, database: { query: (text: string, values?: unknown[]) => Promise<any> } = getDatabasePool()): Promise<void> {
  const definition = definitions[event.type];
  if (!definition) throw new Error(`Unknown notification event: ${event.type}`);
  if (!event.userId && !event.companyId && !event.email) throw new Error("Notification requires a recipient.");
  const pool = database;
  const accountEmail = event.userId
    ? (await pool.query(
      "SELECT email FROM users WHERE id=$1 AND (status='active' OR ($2='security.password_reset' AND status='pending'))",
      [event.userId, event.type],
    )).rows[0]?.email as string | undefined
    : undefined;
  if (event.userId && !accountEmail) throw new Error("Notification account recipient is unavailable.");
  if (event.userId && event.email && event.email.trim().toLowerCase() !== accountEmail!.trim().toLowerCase()) {
    throw new Error("Notification account recipient does not match the supplied email.");
  }
  const metadata: Record<string, unknown> = { ...safeMetadata(event.metadata), recipientKind: event.userId ? "account" : "email" };
  const eventKey = key(event.idempotencyKey);
  const preference = event.userId && !definition.essential ? (await pool.query(
    `SELECT in_app_enabled AS "inAppEnabled",email_enabled AS "emailEnabled"
       FROM notification_preferences WHERE user_id=$1 AND event_type=$2`,
    [event.userId, event.type],
  )).rows[0] : undefined;
  let notificationId: string | null = null;
  if ((event.userId || event.companyId) && (definition.essential || preference?.inAppEnabled !== false)) {
    const row = (await pool.query(
      `INSERT INTO notifications (user_id,company_id,type,event_key,title,message,data_json)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT DO NOTHING RETURNING id`,
      [event.userId ?? null, event.companyId ?? null, event.type, eventKey, definition.title, event.message.slice(0, 4000), metadata],
    )).rows[0];
    notificationId = row?.id ?? (await pool.query(
      `SELECT id FROM notifications WHERE event_key=$1 AND user_id IS NOT DISTINCT FROM $2::uuid AND company_id IS NOT DISTINCT FROM $3::uuid`,
      [eventKey, event.userId ?? null, event.companyId ?? null],
    )).rows[0]?.id ?? null;
    await pool.query(
      `INSERT INTO notification_deliveries (notification_id,event_type,channel,idempotency_key,status,sent_at)
       VALUES ($1,$2,'in_app',$3,'sent',now()) ON CONFLICT (idempotency_key) DO NOTHING`,
      [notificationId, event.type, `${eventKey}:inapp:${event.userId ?? event.companyId}`],
    );
  }
  const recipientEmail = accountEmail ?? event.email;
  if (recipientEmail) {
    const recipientSuppressed = !definition.essential && Boolean((await pool.query(
      "SELECT 1 FROM email_recipient_suppressions WHERE email=lower($1) LIMIT 1",
      [recipientEmail],
    )).rowCount);
    if ((definition.essential || preference?.emailEnabled !== false) && !recipientSuppressed) {
      const orderId = typeof metadata.orderId === "string" ? metadata.orderId : undefined;
      const guestOrderToken = !event.userId && orderId && guestOrderEmailEvents.has(event.type) ? createOpaqueToken() : undefined;
      const deliverySecret = event.secureToken ?? guestOrderToken;
      await pool.query(
        `WITH inserted_delivery AS (
           INSERT INTO notification_deliveries (notification_id,event_type,channel,recipient_email,subject,message,metadata_json,encrypted_secret,idempotency_key)
           VALUES ($1,$2,'email',$3,$4,$5,$6,$7,$8)
           ON CONFLICT (idempotency_key) DO NOTHING RETURNING id
         )
         INSERT INTO guest_order_email_access_tokens (delivery_id,order_id,token_hash,expires_at)
         SELECT id,$9,$10,now()+interval '180 days' FROM inserted_delivery
         WHERE $9::uuid IS NOT NULL AND $10::varchar IS NOT NULL`,
        [notificationId, event.type, recipientEmail, definition.title, event.message.slice(0, 4000), metadata,
          deliverySecret ? encryptSecret(deliverySecret) : null, `${eventKey}:email:${recipientEmail}`,
          guestOrderToken ? orderId : null, guestOrderToken ? hashOpaqueToken(guestOrderToken) : null],
      );
    }
  }
}

export async function emitAdminNotification(
  permissionKey: string,
  event: Omit<NotificationEvent, "userId" | "companyId" | "email">,
  database: { query: (text: string, values?: unknown[]) => Promise<any> } = getDatabasePool(),
): Promise<void> {
  const admins = (await database.query(
    `SELECT DISTINCT u.id,u.email FROM users u
       JOIN admin_user_roles aur ON aur.user_id=u.id
       JOIN admin_roles ar ON ar.id=aur.role_id AND ar.active=true
       JOIN admin_role_permissions arp ON arp.role_id=ar.id
       JOIN admin_permissions ap ON ap.id=arp.permission_id
      WHERE u.status='active' AND ap.permission_key=$1`,
    [permissionKey],
  )).rows;
  for (const admin of admins) {
    await emitNotification({ ...event, idempotencyKey: `${event.idempotencyKey}:admin:${admin.id}`, userId: admin.id, email: admin.email }, database);
  }
}

export async function runNotificationDeliveryWorker(limit = 50, provider: EmailService = emailService) {
  const pool = getDatabasePool();
  const count = Math.min(500, Math.max(1, limit));
  const reconciliation = await reconcilePendingResendWebhookEvents(count);
  if (reconciliation.agedUnmatched) {
    logger.warn("resend webhook events remain unmatched", { count: reconciliation.agedUnmatched });
  }
  await pool.query(`UPDATE notification_deliveries SET status='pending',locked_at=NULL,lock_token=NULL,
    last_error='Delivery lease expired',next_attempt_at=now(),updated_at=now()
    WHERE status='processing' AND locked_at < now() - interval '15 minutes'`);
  const claimed = (await pool.query(
    `WITH candidates AS (SELECT id FROM notification_deliveries WHERE channel='email' AND status IN ('pending','failed')
       AND attempts < max_attempts AND next_attempt_at <= now() ORDER BY next_attempt_at,created_at FOR UPDATE SKIP LOCKED LIMIT $1)
     UPDATE notification_deliveries d SET status='processing',attempts=attempts+1,locked_at=now(),lock_token=gen_random_uuid(),updated_at=now()
     FROM candidates WHERE d.id=candidates.id
      RETURNING d.id,d.lock_token AS "lockToken",d.attempts,d.max_attempts,d.recipient_email AS "email",d.subject,d.message,d.metadata_json AS metadata,d.encrypted_secret AS "encryptedSecret",d.event_type AS "eventType"`,
    [count],
  )).rows;
  for (const delivery of claimed) {
    try {
      if (delivery.eventType === "company.invitation") {
        const invitationClient = await pool.connect();
        try {
          await invitationClient.query("BEGIN");
          const secret = delivery.encryptedSecret ? decryptSecret(delivery.encryptedSecret) : undefined;
          const invitationId = typeof delivery.metadata?.invitationId === "string" ? delivery.metadata.invitationId : null;
          const invitation = invitationId && secret ? (await invitationClient.query(
            "SELECT token_hash FROM company_invitations WHERE id=$1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at>now() FOR UPDATE",
            [invitationId],
          )).rows[0] : undefined;
          if (!invitation || invitation.token_hash !== hashOpaqueToken(secret!)) {
            await invitationClient.query("UPDATE notification_deliveries SET status='cancelled',encrypted_secret=NULL,locked_at=NULL,lock_token=NULL,updated_at=now() WHERE id=$1 AND lock_token=$2", [delivery.id, delivery.lockToken]);
            await invitationClient.query("COMMIT");
            continue;
          }
          const path = notificationActionPath(delivery.eventType, delivery.metadata, secret);
          const url = path ? actionUrl(path) : undefined;
          const rendered = renderNotificationEmail({ eventType: delivery.eventType, subject: delivery.subject, message: delivery.message, actionUrl: url, metadata: delivery.metadata });
          const sent = await provider.send({ to: delivery.email, ...rendered, idempotencyKey: delivery.id });
          await invitationClient.query(`UPDATE notification_deliveries SET status='sent',provider_message_id=$3,sent_at=now(),encrypted_secret=NULL,locked_at=NULL,lock_token=NULL,updated_at=now() WHERE id=$1 AND lock_token=$2`,
            [delivery.id, delivery.lockToken, sent.providerMessageId ?? null]);
          await invitationClient.query("INSERT INTO notification_delivery_attempts (delivery_id,attempt_number,status) VALUES ($1,$2,'sent') ON CONFLICT DO NOTHING", [delivery.id, delivery.attempts]);
          await invitationClient.query("COMMIT");
          if (sent.providerMessageId) await reconcileResendWebhookEvents(sent.providerMessageId);
          continue;
        } catch (error) {
          await invitationClient.query("ROLLBACK");
          throw error;
        } finally {
          invitationClient.release();
        }
      }
      const secret = delivery.encryptedSecret ? decryptSecret(delivery.encryptedSecret) : undefined;
      const path = notificationActionPath(delivery.eventType, delivery.metadata, secret);
      const url = path ? actionUrl(path) : undefined;
      const rendered = renderNotificationEmail({ eventType: delivery.eventType, subject: delivery.subject, message: delivery.message, actionUrl: url, metadata: delivery.metadata });
      const sent = await provider.send({ to: delivery.email, ...rendered, idempotencyKey: delivery.id });
      await pool.query(`UPDATE notification_deliveries SET status='sent',provider_message_id=$3,sent_at=now(),encrypted_secret=NULL,locked_at=NULL,lock_token=NULL,updated_at=now() WHERE id=$1 AND lock_token=$2`,
        [delivery.id, delivery.lockToken, sent.providerMessageId ?? null]);
      if (sent.providerMessageId) await reconcileResendWebhookEvents(sent.providerMessageId);
      await pool.query("INSERT INTO notification_delivery_attempts (delivery_id,attempt_number,status) VALUES ($1,$2,'sent') ON CONFLICT DO NOTHING", [delivery.id, delivery.attempts]);
    } catch (error) {
      const message = (error instanceof Error ? error.message : "Email provider error")
        .replace(/([?&]token=)[^&\s]+/gi, "$1[REDACTED]")
        .replace(/\b[A-Za-z0-9_-]{32,}\b/g, "[REDACTED]")
        .slice(0, 2000);
      const failureClient = await pool.connect();
      try {
        await failureClient.query("BEGIN");
        const failed = (await failureClient.query(`UPDATE notification_deliveries SET status=CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'pending' END,
          last_error=$3,next_attempt_at=now() + (LEAST(60, power(2, attempts)) || ' minutes')::interval,locked_at=NULL,lock_token=NULL,updated_at=now()
          WHERE id=$1 AND lock_token=$2 RETURNING status`,
          [delivery.id, delivery.lockToken, message])).rows[0];
        if (failed?.status === "failed" && guestOrderEmailEvents.has(delivery.eventType) && delivery.metadata?.recipientKind === "email") {
          await failureClient.query("DELETE FROM guest_order_email_access_tokens WHERE delivery_id=$1", [delivery.id]);
          await failureClient.query("UPDATE notification_deliveries SET encrypted_secret=NULL WHERE id=$1", [delivery.id]);
        }
        await failureClient.query("INSERT INTO notification_delivery_attempts (delivery_id,attempt_number,status,error) VALUES ($1,$2,'failed',$3) ON CONFLICT DO NOTHING", [delivery.id, delivery.attempts, message]);
        await failureClient.query("COMMIT");
      } catch (failureUpdateError) {
        await failureClient.query("ROLLBACK");
        throw failureUpdateError;
      } finally {
        failureClient.release();
      }
      logger.warn("notification delivery failed", { deliveryId: delivery.id, attempts: delivery.attempts, error: message });
    }
  }
  return { claimed: claimed.length };
}

export async function listNotifications(userId: string, limit = 50) {
  const result = await getDatabasePool().query(`SELECT id,type,title,message,data_json AS "data",read_at AS "readAt",created_at AS "createdAt",
    count(*) FILTER (WHERE read_at IS NULL) OVER ()::int AS "unreadCount"
    FROM notifications WHERE user_id=$1 ORDER BY created_at DESC LIMIT $2`, [userId, Math.min(100, Math.max(1, limit))]);
  return { items: result.rows.map(({ unreadCount: _count, ...row }) => row), unreadCount: Number(result.rows[0]?.unreadCount ?? 0) };
}
export async function markNotificationRead(userId: string, notificationId: string) {
  return Boolean((await getDatabasePool().query("UPDATE notifications SET read_at=COALESCE(read_at,now()) WHERE id=$1 AND user_id=$2", [notificationId, userId])).rowCount);
}
export async function markAllNotificationsRead(userId: string) {
  await getDatabasePool().query("UPDATE notifications SET read_at=COALESCE(read_at,now()) WHERE user_id=$1", [userId]);
}

export async function retryNotificationDelivery(deliveryId: string): Promise<boolean> {
  const client = await getDatabasePool().connect();
  try {
    await client.query("BEGIN");
    const delivery = (await client.query(`SELECT id,notification_id AS "notificationId",event_type AS "eventType",
      recipient_email AS "recipientEmail",subject,message,metadata_json AS metadata,attempts
      FROM notification_deliveries WHERE id=$1 AND channel='email' AND status='failed' FOR UPDATE`, [deliveryId])).rows[0];
    if (!delivery) {
      await client.query("ROLLBACK");
      return false;
    }
    if (delivery.eventType === "account.updates" && delivery.recipientEmail
      && (await client.query("SELECT 1 FROM email_recipient_suppressions WHERE email=lower($1)", [delivery.recipientEmail])).rowCount) {
      await client.query("ROLLBACK");
      return false;
    }
    if (guestOrderEmailEvents.has(delivery.eventType) && delivery.metadata?.recipientKind === "email") {
      const orderId = typeof delivery.metadata.orderId === "string" ? delivery.metadata.orderId : undefined;
      if (!orderId || !(await client.query("SELECT id FROM orders WHERE id=$1 AND guest_email IS NOT NULL AND user_id IS NULL", [orderId])).rowCount) {
        await client.query("ROLLBACK");
        return false;
      }
      const token = createOpaqueToken();
      const reissueKey = `${delivery.id}:reissue:${Number(delivery.attempts) + 1}`;
      const reissued = (await client.query(`INSERT INTO notification_deliveries
        (notification_id,event_type,channel,recipient_email,subject,message,metadata_json,encrypted_secret,idempotency_key)
        VALUES ($1,$2,'email',$3,$4,$5,$6,$7,$8)
        ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`,
      [delivery.notificationId, delivery.eventType, delivery.recipientEmail, delivery.subject, delivery.message,
        delivery.metadata, encryptSecret(token), reissueKey])).rows[0];
      if (!reissued) {
        await client.query("ROLLBACK");
        return true;
      }
      await client.query(`INSERT INTO guest_order_email_access_tokens (delivery_id,order_id,token_hash,expires_at)
        VALUES ($1,$2,$3,now()+interval '180 days')`,
      [reissued.id, orderId, hashOpaqueToken(token)]);
      await client.query("COMMIT");
      return true;
    }
    await client.query(`UPDATE notification_deliveries
      SET status='pending',max_attempts=GREATEST(max_attempts,attempts+1),next_attempt_at=now(),last_error=NULL,
          locked_at=NULL,lock_token=NULL,updated_at=now()
      WHERE id=$1`, [delivery.id]);
    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function enqueueAdminTestEmail(adminUserId: string): Promise<void> {
  const pool = getDatabasePool();
  const admin = (await pool.query("SELECT email FROM users WHERE id=$1", [adminUserId])).rows[0];
  if (!admin?.email) throw new Error("Administrator email address is unavailable.");
  const minute = new Date().toISOString().slice(0, 16);
  await emitNotification({
    type: "system.test_email",
    idempotencyKey: `transactional-email-test:${adminUserId}:${minute}`,
    email: admin.email,
    message: "Your Lizzor transactional email integration is configured and the durable delivery worker is operating correctly.",
    metadata: { path: "/admin/operations" },
  });
}