import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { closeDatabase, getDatabasePool } from "../db/client.js";
import type { EmailMessage, EmailService } from "../auth/email.js";
import {
  emitNotification,
  emitAdminNotification,
  enqueueAdminTestEmail,
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  retryNotificationDelivery,
  runNotificationDeliveryWorker,
} from "./service.js";
import { renderNotificationEmail } from "./templates.js";
import { getGuestEmailOrder } from "../orders/service.js";

const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
const mark = `notifications-${suffix}`;
const userIds: string[] = [];

class CapturingProvider implements EmailService {
  readonly messages: EmailMessage[] = [];
  constructor(private readonly failure?: Error) {}
  async send(message: EmailMessage) {
    if (this.failure) throw this.failure;
    this.messages.push(message);
    return { providerMessageId: `captured-${this.messages.length}` };
  }
}

async function createUser(name: string) {
  const row = (await getDatabasePool().query(
    "INSERT INTO users (email,first_name,last_name,status,email_verified_at) VALUES ($1,$2,'Test','active',now()) RETURNING id,email",
    [`${mark}-${name}@example.test`, name],
  )).rows[0];
  userIds.push(row.id);
  return row as { id: string; email: string };
}

async function run() {
  const pool = getDatabasePool();
  let ordersRoleId = "";
  let secondGuestOrderId = "";
  try {
    const owner = await createUser("owner");
    const outsider = await createUser("outsider");
    const ordersPermissionId = (await pool.query(
      "INSERT INTO admin_permissions (permission_key,description) VALUES ('orders.view','View orders') ON CONFLICT (permission_key) DO UPDATE SET permission_key=EXCLUDED.permission_key RETURNING id",
    )).rows[0].id;
    ordersRoleId = (await pool.query("INSERT INTO admin_roles (name) VALUES ($1) RETURNING id", [`${mark}-orders-admin`])).rows[0].id;
    await pool.query("INSERT INTO admin_role_permissions (role_id,permission_id) VALUES ($1,$2)", [ordersRoleId, ordersPermissionId]);
    await pool.query("INSERT INTO admin_user_roles (user_id,role_id) VALUES ($1,$2)", [owner.id, ordersRoleId]);
    await assert.rejects(
      () => emitNotification({ type: "order.created", idempotencyKey: `${mark}:recipient-mismatch`, userId: owner.id, email: outsider.email, message: "Must not route." }),
      /does not match/i,
    );
    assert.equal(Number((await pool.query("SELECT count(*) FROM notification_deliveries WHERE idempotency_key LIKE $1", [`${mark}:recipient-mismatch%`])).rows[0].count), 0);
    await pool.query(`INSERT INTO orders
      (id,order_number,guest_email,subtotal,discount_total,shipping_total,tax_total,grand_total,billing_address_snapshot,shipping_address_snapshot)
      VALUES ($1,$2,$3,10,0,0,1.60,10,$4,$4)`,
    [outsider.id, `N-${suffix.slice(-28)}`, outsider.email, { firstName: "Guest", lastName: "Buyer", addressLine1: "1 Test Street", city: "Nicosia", postalCode: "1000", countryCode: "CY" }]);
    secondGuestOrderId = randomUUID();
    await pool.query(`INSERT INTO orders
      (id,order_number,guest_email,subtotal,discount_total,shipping_total,tax_total,grand_total,billing_address_snapshot,shipping_address_snapshot)
      VALUES ($1,$2,$3,10,0,0,1.60,10,$4,$4)`,
    [secondGuestOrderId, `N2-${suffix.slice(-27)}`, `${mark}-second-guest@example.test`, { firstName: "Second", lastName: "Guest", addressLine1: "2 Test Street", city: "Nicosia", postalCode: "1000", countryCode: "CY" }]);
    await emitNotification({
      type: "order.created",
      idempotencyKey: `${mark}:guest-order`,
      email: outsider.email,
      message: "Guest order received.",
      metadata: { orderId: outsider.id, orderNumber: "LZ-GUEST-ISOLATED" },
    });
    await emitAdminNotification("orders.view", {
      type: "admin.order_created",
      idempotencyKey: `${mark}:admin-order`,
      message: "New guest order.",
      metadata: { orderId: outsider.id, orderNumber: "LZ-GUEST-ISOLATED" },
    });
    const isolatedDeliveries = (await pool.query(
      `SELECT event_type AS "eventType",recipient_email AS email FROM notification_deliveries
       WHERE metadata_json->>'orderId'=$1 AND event_type IN ('order.created','admin.order_created') AND channel='email' ORDER BY event_type`,
      [outsider.id],
    )).rows;
    const customerDeliveries = isolatedDeliveries.filter((delivery) => delivery.eventType === "order.created");
    const adminDeliveries = isolatedDeliveries.filter((delivery) => delivery.eventType === "admin.order_created");
    assert.deepEqual(customerDeliveries, [{ eventType: "order.created", email: outsider.email }]);
    assert.ok(adminDeliveries.some((delivery) => delivery.email === owner.email), "configured order admin must receive the admin alert");
    assert.equal(adminDeliveries.some((delivery) => delivery.email === outsider.email), false, "guest customer must not receive an admin alert");
    assert.equal(customerDeliveries.some((delivery) => delivery.email !== outsider.email), false, "admins must not receive the customer confirmation");
    const lifecycleTypes = [
      "payment.succeeded", "payment.failed", "refund.completed", "refund.updated", "order.cancelled",
      "shipment.created", "fulfillment.shipped", "fulfillment.delivered", "return.requested", "return.updated",
    ] as const;
    for (const type of lifecycleTypes) {
      await emitNotification({
        type,
        idempotencyKey: `${mark}:guest-lifecycle:${type}`,
        email: outsider.email,
        message: `Guest lifecycle ${type}.`,
        metadata: { orderId: outsider.id, orderNumber: "LZ-GUEST-ISOLATED" },
      });
      await emitNotification({
        type,
        idempotencyKey: `${mark}:account-lifecycle:${type}`,
        userId: owner.id,
        message: `Account lifecycle ${type}.`,
        metadata: { orderId: owner.id, orderNumber: "LZ-ACCOUNT-ISOLATED" },
      });
    }
    const lifecycleDeliveries = (await pool.query(
      `SELECT event_type AS "eventType",recipient_email AS email,metadata_json->>'orderId' AS "orderId"
         FROM notification_deliveries
        WHERE idempotency_key IN (
          SELECT idempotency_key FROM notification_deliveries
          WHERE message LIKE 'Guest lifecycle %' OR message LIKE 'Account lifecycle %'
        ) AND channel='email'`,
    )).rows;
    assert.equal(lifecycleDeliveries.length, lifecycleTypes.length * 2);
    for (const type of lifecycleTypes) {
      assert.deepEqual(
        lifecycleDeliveries.filter((delivery) => delivery.eventType === type && delivery.orderId === outsider.id),
        [{ eventType: type, email: outsider.email, orderId: outsider.id }],
        `${type} must route only to its guest order email`,
      );
      assert.deepEqual(
        lifecycleDeliveries.filter((delivery) => delivery.eventType === type && delivery.orderId === owner.id),
        [{ eventType: type, email: owner.email, orderId: owner.id }],
        `${type} must route only to its authenticated account email`,
      );
    }

    const event = {
      type: "order.created" as const,
      idempotencyKey: `${mark}:order`,
      userId: owner.id,
      message: "Order LZ-TEST has been received.",
      metadata: { orderId: owner.id, orderNumber: "LZ-TEST", ignoredSecret: "must-not-persist" },
    };
    await Promise.all([emitNotification(event), emitNotification(event)]);
    assert.equal(Number((await pool.query("SELECT count(*) FROM notifications WHERE user_id=$1 AND type='order.created'", [owner.id])).rows[0].count), 1);
    assert.equal(Number((await pool.query("SELECT count(*) FROM notification_deliveries d JOIN notifications n ON n.id=d.notification_id WHERE n.user_id=$1 AND d.event_type='order.created'", [owner.id])).rows[0].count), 2);

    const transaction = await pool.connect();
    try {
      await transaction.query("BEGIN");
      await transaction.query("UPDATE users SET last_name='Must rollback' WHERE id=$1", [owner.id]);
      await assert.rejects(() => emitNotification({ ...event, userId: "not-a-uuid", idempotencyKey: `${mark}:forced-failure` }, transaction));
      await transaction.query("ROLLBACK");
    } finally {
      transaction.release();
    }
    assert.equal((await pool.query("SELECT last_name FROM users WHERE id=$1", [owner.id])).rows[0].last_name, "Test");

    const ownerFeed = await listNotifications(owner.id);
    const ownerOrderNotification = ownerFeed.items.find((item) => item.type === "order.created");
    assert.ok(ownerOrderNotification);
    assert.ok(ownerFeed.unreadCount >= 1);
    assert.equal((await listNotifications(outsider.id)).items.length, 0);
    assert.equal(await markNotificationRead(outsider.id, ownerOrderNotification.id), false);
    assert.equal(await markNotificationRead(owner.id, ownerOrderNotification.id), true);
    await markAllNotificationsRead(owner.id);
    assert.equal((await listNotifications(owner.id)).unreadCount, 0);

    await pool.query("INSERT INTO notification_preferences (user_id,event_type,in_app_enabled,email_enabled) VALUES ($1,'account.updates',false,false)", [owner.id]);
    await emitNotification({ type: "account.updates", idempotencyKey: `${mark}:optional`, userId: owner.id, message: "Optional account update." });
    assert.equal(Number((await pool.query("SELECT count(*) FROM notifications WHERE user_id=$1 AND type='account.updates'", [owner.id])).rows[0].count), 0);

    const rawToken = `sensitive-${suffix}-token-value-that-is-long-enough`;
    await emitNotification({
      type: "security.password_reset",
      idempotencyKey: `${mark}:secret`,
      userId: owner.id,
      message: "Use the secure link in this email to reset your password.",
      secureToken: rawToken,
    });
    const stored = (await pool.query("SELECT id,message,encrypted_secret AS \"encryptedSecret\" FROM notification_deliveries WHERE event_type='security.password_reset' AND recipient_email=$1", [owner.email])).rows[0];
    assert.ok(stored.encryptedSecret);
    assert.equal(stored.message.includes(rawToken), false);
    assert.equal(stored.encryptedSecret.includes(rawToken), false);
    const success = new CapturingProvider();
    await runNotificationDeliveryWorker(500, success);
    const reset = success.messages.find((message) => message.subject === "Reset your password" && message.to === owner.email);
    assert.ok(reset?.text.includes(encodeURIComponent(rawToken)));
    assert.ok(reset?.html?.includes("Wholesale. Anytime. Everywhere."));
    const orderConfirmation = success.messages.find((message) => message.subject === "Order received" && message.to === owner.email);
    assert.ok(orderConfirmation?.html?.includes("LZ-TEST"));
    assert.ok(orderConfirmation?.text.includes(`/account/orders/${owner.id}`));
    const guestOrderConfirmation = success.messages.find((message) => message.subject === "Order received" && message.to === outsider.email);
    assert.ok(guestOrderConfirmation);
    const guestOrderConfirmationToken = guestOrderConfirmation.text.match(/#token=([A-Za-z0-9_-]{43})/)?.[1];
    assert.ok(guestOrderConfirmationToken);
    assert.equal((await getGuestEmailOrder(outsider.id, guestOrderConfirmationToken)).id, outsider.id);
    await assert.rejects(
      () => getGuestEmailOrder(secondGuestOrderId, guestOrderConfirmationToken),
      /not found/i,
      "an emailed Guest A token must never open Guest B's order",
    );
    await emitNotification({
      type: "fulfillment.shipped",
      idempotencyKey: `${mark}:guest-shipped`,
      email: outsider.email,
      message: "Your guest order has shipped.",
      metadata: { orderId: outsider.id, orderNumber: "LZ-GUEST" },
    });
    const guestTokenRow = (await pool.query(`SELECT t.token_hash AS "tokenHash",d.encrypted_secret AS "encryptedSecret"
      FROM guest_order_email_access_tokens t JOIN notification_deliveries d ON d.id=t.delivery_id
      WHERE t.order_id=$1 AND d.event_type='fulfillment.shipped' AND d.message=$2`, [outsider.id, "Your guest order has shipped."])).rows[0];
    assert.ok(guestTokenRow?.tokenHash);
    assert.ok(guestTokenRow?.encryptedSecret);
    const guestProvider = new CapturingProvider();
    await runNotificationDeliveryWorker(500, guestProvider);
    const guestShipment = guestProvider.messages.find((message) => message.subject === "Your order has shipped" && message.to === outsider.email);
    assert.ok(guestShipment);
    assert.equal(guestShipment.text.includes("/account/orders/"), false);
    assert.match(guestShipment.text, new RegExp(`/guest-order/${outsider.id}#token=[A-Za-z0-9_-]{43}`));
    const guestEmailToken = guestShipment.text.match(/#token=([A-Za-z0-9_-]{43})/)?.[1];
    assert.ok(guestEmailToken);
    assert.equal((await getGuestEmailOrder(outsider.id, guestEmailToken)).id, outsider.id, "the exact emailed capability must open its guest order");
    const deliveredGuestRow = (await pool.query(`SELECT encrypted_secret AS "encryptedSecret" FROM notification_deliveries
      WHERE event_type='fulfillment.shipped' AND recipient_email=$1`, [outsider.email])).rows[0];
    assert.equal(deliveredGuestRow.encryptedSecret, null);
    await emitNotification({
      type: "order.cancelled",
      idempotencyKey: `${mark}:guest-terminal-failure`,
      email: outsider.email,
      message: "Your guest order was cancelled.",
      metadata: { orderId: outsider.id, orderNumber: "LZ-GUEST" },
    });
    await pool.query("UPDATE notification_deliveries SET max_attempts=1 WHERE event_type='order.cancelled' AND recipient_email=$1 AND message=$2", [outsider.email, "Your guest order was cancelled."]);
    await runNotificationDeliveryWorker(500, new CapturingProvider(new Error("terminal provider failure")));
    const terminalGuest = (await pool.query(`SELECT id,status,encrypted_secret AS "encryptedSecret" FROM notification_deliveries
      WHERE event_type='order.cancelled' AND recipient_email=$1 AND message=$2`, [outsider.email, "Your guest order was cancelled."])).rows[0];
    assert.equal(terminalGuest.status, "failed");
    assert.equal(terminalGuest.encryptedSecret, null);
    assert.equal(Number((await pool.query("SELECT count(*) FROM guest_order_email_access_tokens WHERE delivery_id=$1", [terminalGuest.id])).rows[0].count), 0);
    assert.equal(await retryNotificationDelivery(terminalGuest.id), true);
    const reissuedGuest = (await pool.query(`SELECT id,encrypted_secret AS "encryptedSecret",idempotency_key AS "idempotencyKey",
      (SELECT count(*)::int FROM guest_order_email_access_tokens WHERE delivery_id=d.id) AS tokens
      FROM notification_deliveries d WHERE idempotency_key LIKE $1`, [`${terminalGuest.id}:reissue:%`])).rows[0];
    assert.ok(reissuedGuest.encryptedSecret);
    assert.notEqual(reissuedGuest.id, terminalGuest.id);
    assert.notEqual(reissuedGuest.idempotencyKey, terminalGuest.id);
    assert.equal(reissuedGuest.tokens, 1);
    const reissueProvider = new CapturingProvider();
    await runNotificationDeliveryWorker(500, reissueProvider);
    assert.match(reissueProvider.messages.find((message) => message.to === outsider.email && message.subject === "Order cancelled")?.text ?? "", /#token=[A-Za-z0-9_-]{43}/);
    const providerHistory = (await pool.query("SELECT provider_message_id AS \"providerMessageId\" FROM notification_deliveries WHERE id=$1", [stored.id])).rows[0];
    assert.ok(providerHistory.providerMessageId?.startsWith("captured-"));
    const trackingTemplate = renderNotificationEmail({
      eventType: "fulfillment.shipped",
      subject: "Your order has shipped",
      message: "Order LZ-TEST has shipped.",
      actionUrl: "https://lizzor.com/account/orders/test/tracking",
      metadata: { orderNumber: "LZ-TEST", trackingNumber: "TRACK-123" },
    });
    assert.ok(trackingTemplate.html.includes("TRACK-123"));
    assert.ok(trackingTemplate.text.includes("Tracking: TRACK-123"));

    await enqueueAdminTestEmail(owner.id);
    assert.equal(Number((await pool.query("SELECT count(*) FROM notification_deliveries WHERE event_type='system.test_email' AND recipient_email=$1", [owner.email])).rows[0].count), 1);
    const testEmailProvider = new CapturingProvider();
    await runNotificationDeliveryWorker(500, testEmailProvider);
    assert.ok(testEmailProvider.messages.find((message) => message.subject === "Lizzor transactional email test")?.text.includes("/admin/operations"));

    await emitNotification({ type: "payment.failed", idempotencyKey: `${mark}:retry`, userId: outsider.id, message: "Payment failed." });
    await pool.query("UPDATE notification_deliveries SET max_attempts=1 WHERE event_type='payment.failed' AND recipient_email=$1 AND message=$2", [outsider.email, "Payment failed."]);
    await runNotificationDeliveryWorker(500, new CapturingProvider(new Error(`provider failed ?token=${rawToken}`)));
    const failed = (await pool.query("SELECT id,status,last_error AS \"lastError\" FROM notification_deliveries WHERE event_type='payment.failed' AND recipient_email=$1 AND message=$2", [outsider.email, "Payment failed."])).rows[0];
    assert.equal(failed.status, "failed");
    assert.equal(failed.lastError.includes(rawToken), false);
    assert.equal(await retryNotificationDelivery(failed.id), true);
    const retryProvider = new CapturingProvider();
    await runNotificationDeliveryWorker(500, retryProvider);
    assert.equal(retryProvider.messages.filter((message) => message.to === outsider.email).length, 1);
    assert.equal(Number((await pool.query("SELECT count(*) FROM notification_delivery_attempts WHERE delivery_id=$1", [failed.id])).rows[0].count), 2);

    console.info("Transactional notification integration checks passed.");
  } finally {
    await pool.query("DELETE FROM notification_deliveries WHERE metadata_json->>'orderId'=$1", [userIds[1] ?? "00000000-0000-0000-0000-000000000000"]);
    if (secondGuestOrderId) {
      await pool.query("DELETE FROM notification_deliveries WHERE metadata_json->>'orderId'=$1", [secondGuestOrderId]);
      await pool.query("DELETE FROM orders WHERE id=$1", [secondGuestOrderId]);
    }
    await pool.query("DELETE FROM notification_deliveries WHERE recipient_email LIKE $1", [`${mark}-%`]);
    await pool.query("DELETE FROM orders WHERE id=$1", [userIds[1]]);
    if (ordersRoleId) {
      await pool.query("DELETE FROM admin_user_roles WHERE role_id=$1", [ordersRoleId]);
      await pool.query("DELETE FROM admin_role_permissions WHERE role_id=$1", [ordersRoleId]);
      await pool.query("DELETE FROM admin_roles WHERE id=$1", [ordersRoleId]);
    }
    if (userIds.length) await pool.query("DELETE FROM users WHERE id=ANY($1::uuid[])", [userIds]);
    await closeDatabase();
  }
}

run().catch((error: unknown) => { console.error(error); process.exitCode = 1; });