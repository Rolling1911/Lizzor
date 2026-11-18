import { Resend, type WebhookEventPayload } from "resend";
import { getDatabasePool } from "../db/client.js";

const supportedEvents = new Set([
  "email.delivered",
  "email.delivery_delayed",
  "email.bounced",
  "email.complained",
  "email.failed",
]);

type SupportedEvent = Extract<WebhookEventPayload, { type:
  "email.delivered" | "email.delivery_delayed" | "email.bounced" | "email.complained" | "email.failed"
}>;

function classification(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/\s+/g, "_");
  return /^[a-z][a-z0-9_-]{0,49}$/.test(normalized) ? normalized : "other";
}

function normalizedDetails(event: SupportedEvent): Record<string, string> | null {
  if (event.type === "email.bounced") {
    return {
      bounceType: classification(event.data.bounce.type),
      bounceSubType: classification(event.data.bounce.subType),
    };
  }
  if (event.type === "email.failed") return { classification: "provider_failed" };
  return null;
}

function providerStatus(type: SupportedEvent["type"]): string {
  return type.slice("email.".length);
}

const statusPrecedence: Record<string, number> = {
  delivery_delayed: 1,
  delivered: 2,
  failed: 3,
  bounced: 4,
  complained: 5,
};

function eventWins(currentStatus: string | null, currentAt: Date | null, nextStatus: string, nextAt: Date): boolean {
  if (!currentAt) return true;
  const timeDifference = nextAt.getTime() - currentAt.getTime();
  return timeDifference > 0 || (timeDifference === 0 && (statusPrecedence[nextStatus] ?? 0) > (statusPrecedence[currentStatus ?? ""] ?? 0));
}

async function applyEvent(
  client: { query: (text: string, values?: unknown[]) => Promise<any> },
  delivery: { id: string; recipientEmail?: string | null; providerStatus?: string | null; providerEventAt?: Date | string | null },
  eventId: string,
  status: string,
  occurredAt: Date,
  providerMessageId: string,
) {
  const currentAt = delivery.providerEventAt ? new Date(delivery.providerEventAt) : null;
  if (!eventWins(delivery.providerStatus ?? null, currentAt, status, occurredAt)) return false;
  await client.query(
    `UPDATE notification_deliveries SET provider_status=$2::varchar,provider_event_at=$3,
      suppression_reason=CASE WHEN $2::varchar IN ('bounced','complained') THEN $2::varchar WHEN $2::varchar='delivered' THEN NULL ELSE suppression_reason END,
      suppressed_at=CASE WHEN $2::varchar IN ('bounced','complained') THEN $3 WHEN $2::varchar='delivered' THEN NULL ELSE suppressed_at END,
      updated_at=now() WHERE id=$1`,
    [delivery.id, status, occurredAt],
  );
  delivery.providerStatus = status;
  delivery.providerEventAt = occurredAt;
  if (!delivery.recipientEmail) return true;
  const email = delivery.recipientEmail.trim().toLowerCase();
  if (["bounced", "complained"].includes(status)) {
    await client.query(
      `INSERT INTO email_recipient_suppressions (email,reason,provider_message_id,source_event_id,occurred_at)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (email) DO UPDATE SET reason=EXCLUDED.reason,provider_message_id=EXCLUDED.provider_message_id,
         source_event_id=EXCLUDED.source_event_id,occurred_at=EXCLUDED.occurred_at,updated_at=now()
       WHERE email_recipient_suppressions.occurred_at < EXCLUDED.occurred_at
          OR (email_recipient_suppressions.occurred_at = EXCLUDED.occurred_at
              AND CASE EXCLUDED.reason WHEN 'complained' THEN 2 ELSE 1 END >
                  CASE email_recipient_suppressions.reason WHEN 'complained' THEN 2 ELSE 1 END)`,
      [email, status, providerMessageId, eventId, occurredAt],
    );
    await client.query(
      `UPDATE notification_deliveries SET status='suppressed',suppression_reason=$2,suppressed_at=$3,
         locked_at=NULL,lock_token=NULL,updated_at=now()
       WHERE lower(recipient_email)=$1 AND event_type='account.updates' AND status IN ('pending','failed')`,
      [email, status, occurredAt],
    );
  } else if (status === "delivered") {
    const removed = await client.query(
      `DELETE FROM email_recipient_suppressions WHERE email=$1 AND provider_message_id=$2 AND occurred_at <= $3 RETURNING reason,occurred_at`,
      [email, providerMessageId, occurredAt],
    );
    if (removed.rowCount) {
      await client.query(
        `UPDATE notification_deliveries SET status='pending',suppression_reason=NULL,suppressed_at=NULL,next_attempt_at=now(),updated_at=now()
         WHERE lower(recipient_email)=$1 AND event_type='account.updates' AND status='suppressed' AND suppressed_at <= $2`,
        [email, occurredAt],
      );
    }
  }
  return true;
}

export function verifyResendWebhook(payload: Buffer, headers: { id: string; timestamp: string; signature: string }, webhookSecret: string): WebhookEventPayload {
  return new Resend().webhooks.verify({ payload: payload.toString("utf8"), headers, webhookSecret });
}

export async function processResendWebhook(webhookId: string, event: WebhookEventPayload) {
  if (!supportedEvents.has(event.type)) return { accepted: true, supported: false, duplicate: false };
  const supported = event as SupportedEvent;
  const providerMessageId = supported.data.email_id;
  const occurredAt = new Date(supported.created_at);
  if (!providerMessageId || Number.isNaN(occurredAt.getTime())) throw new Error("Invalid Resend webhook payload.");
  const client = await getDatabasePool().connect();
  try {
    await client.query("BEGIN");
    const delivery = (await client.query(
      `SELECT id,recipient_email AS "recipientEmail",provider_status AS "providerStatus",provider_event_at AS "providerEventAt"
       FROM notification_deliveries
       WHERE provider_message_id=$1 ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
      [providerMessageId],
    )).rows[0];
    const inserted = (await client.query(
      `INSERT INTO resend_webhook_events
       (webhook_id,event_type,provider_message_id,occurred_at,matched_delivery_id,details_json)
       VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (webhook_id) DO NOTHING RETURNING id`,
      [webhookId, supported.type, providerMessageId, occurredAt, delivery?.id ?? null, normalizedDetails(supported)],
    )).rows[0];
    if (!inserted) {
      if (delivery) {
        const prior = (await client.query(
          `SELECT id,event_type AS "eventType",occurred_at AS "occurredAt" FROM resend_webhook_events WHERE webhook_id=$1 FOR UPDATE`,
          [webhookId],
        )).rows[0];
        if (prior) {
          await applyEvent(client, delivery, prior.id, providerStatus(prior.eventType), new Date(prior.occurredAt), providerMessageId);
          await client.query("UPDATE resend_webhook_events SET matched_delivery_id=$2 WHERE id=$1 AND matched_delivery_id IS NULL", [prior.id, delivery.id]);
        }
      }
      await client.query("COMMIT");
      return { accepted: true, supported: true, duplicate: true, matched: Boolean(delivery) };
    }
    const status = providerStatus(supported.type);
    if (delivery) {
      await applyEvent(client, delivery, inserted.id, status, occurredAt, providerMessageId);
    }
    await client.query("COMMIT");
    // Reconcile again after the unmatched event is visible. This pairs with the
    // worker's post-provider-ID reconciliation so whichever transaction commits
    // second closes the provider-ID/webhook insertion race.
    if (!delivery) await reconcileResendWebhookEvents(providerMessageId);
    return { accepted: true, supported: true, duplicate: false, matched: Boolean(delivery) };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function reconcileResendWebhookEvents(providerMessageId: string): Promise<void> {
  const client = await getDatabasePool().connect();
  try {
    await client.query("BEGIN");
    const delivery = (await client.query(
      `SELECT id,recipient_email AS "recipientEmail",provider_status AS "providerStatus",provider_event_at AS "providerEventAt"
       FROM notification_deliveries WHERE provider_message_id=$1 ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
      [providerMessageId],
    )).rows[0];
    if (!delivery) {
      await client.query("COMMIT");
      return;
    }
    const events = (await client.query(
      `SELECT id,event_type AS "eventType",occurred_at AS "occurredAt" FROM resend_webhook_events
       WHERE provider_message_id=$1 AND matched_delivery_id IS NULL
       ORDER BY occurred_at,CASE event_type
         WHEN 'email.delivery_delayed' THEN 1 WHEN 'email.delivered' THEN 2 WHEN 'email.failed' THEN 3
         WHEN 'email.bounced' THEN 4 WHEN 'email.complained' THEN 5 ELSE 0 END,webhook_id FOR UPDATE`,
      [providerMessageId],
    )).rows;
    for (const event of events) {
      await applyEvent(client, delivery, event.id, providerStatus(event.eventType), new Date(event.occurredAt), providerMessageId);
      await client.query("UPDATE resend_webhook_events SET matched_delivery_id=$2 WHERE id=$1", [event.id, delivery.id]);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function reconcilePendingResendWebhookEvents(limit = 100): Promise<{ reconciledProviderIds: number; agedUnmatched: number }> {
  const pool = getDatabasePool();
  const providerIds = (await pool.query(
    `SELECT DISTINCT e.provider_message_id AS "providerMessageId"
     FROM resend_webhook_events e
     WHERE e.matched_delivery_id IS NULL
       AND EXISTS (SELECT 1 FROM notification_deliveries d WHERE d.provider_message_id=e.provider_message_id)
     ORDER BY e.provider_message_id LIMIT $1`,
    [Math.min(500, Math.max(1, limit))],
  )).rows;
  for (const row of providerIds) await reconcileResendWebhookEvents(row.providerMessageId);
  const agedUnmatched = Number((await pool.query(
    `SELECT count(*) FROM resend_webhook_events
     WHERE matched_delivery_id IS NULL AND created_at < now()-interval '15 minutes'`,
  )).rows[0].count);
  return { reconciledProviderIds: providerIds.length, agedUnmatched };
}