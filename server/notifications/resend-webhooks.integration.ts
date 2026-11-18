import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import type { Server } from "node:http";
import { createApp } from "../app.js";
import { closeDatabase, getDatabasePool } from "../db/client.js";
import { reconcilePendingResendWebhookEvents } from "./resend-webhooks.js";

const secret = process.env.RESEND_WEBHOOK_SECRET!;
const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
const recipient = `resend-webhook-${suffix}@example.test`;
const ids = {
  delivered: `resend-delivered-${suffix}`,
  delayed: `resend-delayed-${suffix}`,
  bounced: `resend-bounced-${suffix}`,
  complained: `resend-complained-${suffix}`,
  failed: `resend-failed-${suffix}`,
  unknown: `resend-unknown-${suffix}`,
};

function signature(webhookId: string, timestamp: string, payload: string) {
  const key = Buffer.from(secret.slice("whsec_".length), "base64");
  return `v1,${createHmac("sha256", key).update(`${webhookId}.${timestamp}.${payload}`).digest("base64")}`;
}

function payload(type: string, providerMessageId: string, createdAt: string) {
  const data: Record<string, unknown> = {
    created_at: createdAt,
    email_id: providerMessageId,
    message_id: `message-${providerMessageId}`,
    from: "Lizzor <noreply@send.lizzor.com>",
    to: [recipient],
    subject: "Webhook test",
  };
  if (type === "email.bounced") data.bounce = { type: "Permanent", subType: "General", message: `Mailbox ${recipient} rejected secret_token_abcdefghijklmnopqrstuvwxyz0123456789` };
  if (type === "email.failed") data.failed = { reason: `Provider rejected ${recipient} with secret_token_abcdefghijklmnopqrstuvwxyz0123456789` };
  return JSON.stringify({ type, created_at: createdAt, data });
}

async function post(baseUrl: string, type: string, providerMessageId: string, options: { webhookId?: string; createdAt?: string; valid?: boolean } = {}) {
  const webhookId = options.webhookId ?? `msg_${type}-${providerMessageId}-${Math.random().toString(16).slice(2)}`;
  const timestamp = String(Math.floor(Date.now() / 1000));
  const body = payload(type, providerMessageId, options.createdAt ?? new Date().toISOString());
  return fetch(`${baseUrl}/api/v1/webhooks/resend`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "svix-id": webhookId,
      "svix-timestamp": timestamp,
      "svix-signature": options.valid === false ? "v1,invalid" : signature(webhookId, timestamp, body),
    },
    body,
  });
}

async function run() {
  const pool = getDatabasePool();
  const app = await createApp({ serveFrontend: false });
  const server: Server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    for (const [event, providerMessageId] of Object.entries(ids).filter(([key]) => key !== "unknown")) {
      await pool.query(`INSERT INTO notification_deliveries
        (event_type,channel,recipient_email,subject,message,idempotency_key,status,provider_message_id,sent_at)
        VALUES ($1,'email',$2,'Webhook test','Test',$3,'sent',$4,now())`,
      [event === "delivered" ? "order.created" : "account.updates", recipient, `resend-webhook:${providerMessageId}`, providerMessageId]);
    }
    await pool.query(`INSERT INTO notification_deliveries
      (event_type,channel,recipient_email,subject,message,idempotency_key,status)
      VALUES ('account.updates','email',$1,'Optional pending','Test',$2,'pending'),
             ('security.password_reset','email',$1,'Essential pending','Test',$3,'pending')`,
    [recipient, `resend-webhook:optional:${suffix}`, `resend-webhook:essential:${suffix}`]);

    assert.equal((await post(baseUrl, "email.delivered", ids.delivered, { valid: false })).status, 400);
    assert.equal(Number((await pool.query("SELECT count(*) FROM resend_webhook_events WHERE provider_message_id=$1", [ids.delivered])).rows[0].count), 0);

    const deliveredId = `msg_delivered_${suffix}`;
    assert.equal((await post(baseUrl, "email.delivered", ids.delivered, { webhookId: deliveredId })).status, 200);
    assert.equal((await pool.query("SELECT provider_status FROM notification_deliveries WHERE provider_message_id=$1", [ids.delivered])).rows[0].provider_status, "delivered");
    assert.equal((await post(baseUrl, "email.delivered", ids.delivered, { webhookId: deliveredId })).status, 200);
    assert.equal(Number((await pool.query("SELECT count(*) FROM resend_webhook_events WHERE webhook_id=$1", [deliveredId])).rows[0].count), 1);
    await post(baseUrl, "email.bounced", ids.delivered, { createdAt: new Date(Date.now() - 60_000).toISOString() });
    assert.equal((await pool.query("SELECT provider_status FROM notification_deliveries WHERE provider_message_id=$1", [ids.delivered])).rows[0].provider_status, "delivered");
    assert.equal(Number((await pool.query("SELECT count(*) FROM email_recipient_suppressions WHERE email=$1", [recipient])).rows[0].count), 0, "a stale bounce must not suppress a recipient");

    assert.equal((await post(baseUrl, "email.delivery_delayed", ids.delayed)).status, 200);
    assert.equal((await pool.query("SELECT provider_status FROM notification_deliveries WHERE provider_message_id=$1", [ids.delayed])).rows[0].provider_status, "delivery_delayed");

    const newest = new Date().toISOString();
    const older = new Date(Date.now() - 60_000).toISOString();
    await post(baseUrl, "email.delivered", ids.delayed, { createdAt: newest });
    await post(baseUrl, "email.delivery_delayed", ids.delayed, { createdAt: older });
    assert.equal((await pool.query("SELECT provider_status FROM notification_deliveries WHERE provider_message_id=$1", [ids.delayed])).rows[0].provider_status, "delivered");

    assert.equal((await post(baseUrl, "email.bounced", ids.bounced)).status, 200);
    assert.equal((await pool.query("SELECT provider_status FROM notification_deliveries WHERE provider_message_id=$1", [ids.bounced])).rows[0].provider_status, "bounced");
    assert.equal((await pool.query("SELECT reason FROM email_recipient_suppressions WHERE email=$1", [recipient])).rows[0].reason, "bounced");
    assert.equal((await pool.query("SELECT status FROM notification_deliveries WHERE idempotency_key=$1", [`resend-webhook:optional:${suffix}`])).rows[0].status, "suppressed");
    assert.equal((await pool.query("SELECT status FROM notification_deliveries WHERE idempotency_key=$1", [`resend-webhook:essential:${suffix}`])).rows[0].status, "pending");

    assert.equal((await post(baseUrl, "email.complained", ids.complained, { createdAt: new Date(Date.now() + 1000).toISOString() })).status, 200);
    assert.equal((await pool.query("SELECT provider_status FROM notification_deliveries WHERE provider_message_id=$1", [ids.complained])).rows[0].provider_status, "complained");
    assert.equal((await pool.query("SELECT reason FROM email_recipient_suppressions WHERE email=$1", [recipient])).rows[0].reason, "complained");

    assert.equal((await post(baseUrl, "email.failed", ids.failed)).status, 200);
    assert.equal((await pool.query("SELECT provider_status FROM notification_deliveries WHERE provider_message_id=$1", [ids.failed])).rows[0].provider_status, "failed");

    const unknownResponse = await post(baseUrl, "email.delivered", ids.unknown);
    assert.equal(unknownResponse.status, 200);
    assert.equal((await unknownResponse.json()).data.matched, false);
    assert.equal(Number((await pool.query("SELECT count(*) FROM resend_webhook_events WHERE provider_message_id=$1 AND matched_delivery_id IS NULL", [ids.unknown])).rows[0].count), 1);
    await pool.query(`INSERT INTO notification_deliveries
      (event_type,channel,recipient_email,subject,message,idempotency_key,status,provider_message_id,sent_at)
      VALUES ('order.created','email',$1,'Late correlation','Test',$2,'sent',$3,now())`,
    [recipient, `resend-webhook:late:${suffix}`, ids.unknown]);
    await reconcilePendingResendWebhookEvents();
    assert.equal((await pool.query("SELECT provider_status FROM notification_deliveries WHERE provider_message_id=$1", [ids.unknown])).rows[0].provider_status, "delivered");
    assert.equal(Number((await pool.query("SELECT count(*) FROM resend_webhook_events WHERE provider_message_id=$1 AND matched_delivery_id IS NOT NULL", [ids.unknown])).rows[0].count), 1);

    const stored = JSON.stringify((await pool.query("SELECT event_type,provider_message_id,details_json FROM resend_webhook_events WHERE provider_message_id LIKE $1", [`%${suffix}%`])).rows);
    assert.equal(stored.includes(secret), false);
    assert.equal(stored.includes("Webhook test"), false, "raw subjects and provider payloads must not be retained");
    assert.equal(stored.includes(recipient), false, "provider diagnostic prose and recipient addresses must not be retained");
    assert.equal(stored.includes("secret_token_"), false, "provider diagnostic tokens must not be retained");
    console.info("Signed Resend webhook, ordering, suppression, and replay checks passed.");
  } finally {
    await pool.query("DELETE FROM notification_deliveries WHERE recipient_email=$1", [recipient]);
    await pool.query("DELETE FROM email_recipient_suppressions WHERE email=$1", [recipient]);
    await pool.query("DELETE FROM resend_webhook_events WHERE provider_message_id LIKE $1", [`%${suffix}%`]);
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await closeDatabase();
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});