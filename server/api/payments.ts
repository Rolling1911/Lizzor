import { Router, type Request } from "express";
import { z } from "zod";
import { getCookie, GUEST_CART_COOKIE } from "../auth/cookies.js";
import { auditSecurityEvent } from "../auth/service.js";
import { requireAdmin, requireAuth, requireCsrf, requirePermission } from "../middleware/auth.js";
import { AppError } from "../middleware/error-handler.js";
import { createPayment, createRefund, expirePaymentReservations, getAdminPayment, getAdminRefund, getCustomerPayment, handleWebhook, listAdminPayments, listAdminRefunds, listPaymentRecovery, queuePaymentReconciliation, queueRefundReconciliation, queueStuckPaymentRecoveries, retryPaymentRecovery, runPaymentRecovery } from "../payments/service.js";
import { releaseExpiredReservations } from "../orders/service.js";
import type { Access } from "../orders/service.js";
import { guestBearerLimiter } from "../middleware/security.js";
import { env } from "../config/env.js";

const uuid = z.string().uuid();
const paymentInput = z.object({ idempotencyKey: z.string().trim().min(8).max(160) });
const refundInput = z.object({ amount: z.number().finite().positive(), idempotencyKey: z.string().trim().min(8).max(160), reason: z.string().trim().max(500).optional() });
const adminRefundQuery = z.object({
  search: z.string().trim().max(120).optional(),
  status: z.enum(["pending", "processing", "completed", "failed", "cancelled"]).optional(),
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new AppError(400, "VALIDATION_ERROR", "The request could not be validated.", result.error.flatten());
  return result.data;
}

function id(value: string | string[]): string {
  const result = uuid.safeParse(value);
  if (!result.success) throw new AppError(400, "INVALID_ID", "A valid identifier is required.");
  return result.data;
}

function guestAccess(request: Request): Access {
  const guestSessionId = getCookie(request, GUEST_CART_COOKIE);
  const guestAccessToken = request.get("x-order-access-token");
  if (!guestSessionId || !guestAccessToken) throw new AppError(404, "ORDER_NOT_FOUND", "The order was not found.");
  return { guestSessionId, guestAccessToken };
}

export const paymentsRouter = Router();

paymentsRouter.get("/payments/config", (_request, response) => {
  response.json({
    data: {
      provider: env.PAYMENT_PROVIDER,
      publishableKey: env.STRIPE_PUBLISHABLE_KEY || null,
      returnOrigin: env.APP_ORIGIN || null,
    },
  });
});

paymentsRouter.post("/payments/webhook", async (request, response) => {
  const signature = request.get("stripe-signature") ?? request.get("x-payment-signature");
  if (!signature || !Buffer.isBuffer(request.body)) throw new AppError(400, "INVALID_PAYMENT_SIGNATURE", "The payment webhook signature is missing.");
  response.json({ data: await handleWebhook(request.body, signature) });
});

paymentsRouter.get("/account/orders/:id/payments", requireAuth, async (request, response) => {
  response.json({ data: await getCustomerPayment(id(request.params.id), { userId: request.auth!.userId }) });
});

paymentsRouter.post("/account/orders/:id/payments", requireCsrf, requireAuth, async (request, response) => {
  const input = parse(paymentInput, request.body);
  response.status(201).json({ data: await createPayment(id(request.params.id), { userId: request.auth!.userId }, input.idempotencyKey) });
});

paymentsRouter.get("/guest/orders/:id/payments", guestBearerLimiter, async (request, response) => {
  response.json({ data: await getCustomerPayment(id(request.params.id), guestAccess(request)) });
});

paymentsRouter.post("/guest/orders/:id/payments", guestBearerLimiter, requireCsrf, async (request, response) => {
  const input = parse(paymentInput, request.body);
  response.status(201).json({ data: await createPayment(id(request.params.id), guestAccess(request), input.idempotencyKey) });
});

paymentsRouter.get("/admin/payments", requireAdmin, requirePermission("payments.view"), async (request, response) => {
  response.json({ data: await listAdminPayments({
    search: typeof request.query.search === "string" ? request.query.search : undefined,
    status: typeof request.query.status === "string" ? request.query.status : undefined,
    page: Number(request.query.page ?? 1),
    pageSize: Number(request.query.pageSize ?? 25),
  }) });
});

paymentsRouter.get("/admin/payments/recovery", requireAdmin, requirePermission("payments.recovery.view"), async (request, response) => {
  response.json({ data: await listPaymentRecovery({
    status: typeof request.query.status === "string" ? request.query.status : undefined,
    operation: typeof request.query.operation === "string" ? request.query.operation : undefined,
    page: Number(request.query.page ?? 1),
    pageSize: Number(request.query.pageSize ?? 25),
  }) });
});

paymentsRouter.post("/admin/payments/recovery/run", requireCsrf, requireAdmin, requirePermission("payments.recovery.manage"), requirePermission("payments.reconcile"), async (request, response) => {
  const [payments, orders, queued] = await Promise.all([
    expirePaymentReservations(),
    releaseExpiredReservations(),
    queueStuckPaymentRecoveries(),
  ]);
  const recovery = await runPaymentRecovery();
  await auditSecurityEvent({ actorUserId: request.auth!.userId, action: "admin.payment_recovery_run", entityType: "payment_recovery", request });
  response.json({ data: { payments, orders, queued, recovery } });
});

paymentsRouter.post("/admin/payments/recovery/:id/retry", requireCsrf, requireAdmin, requirePermission("payments.recovery.manage"), requirePermission("payments.reconcile"), async (request, response) => {
  const recoveryId = id(request.params.id);
  const result = await retryPaymentRecovery(recoveryId);
  await auditSecurityEvent({ actorUserId: request.auth!.userId, action: "admin.payment_recovery_retried", entityType: "payment_recovery", entityId: recoveryId, request });
  response.status(202).json({ data: result });
});

paymentsRouter.post("/admin/payments/:id/reconcile", requireCsrf, requireAdmin, requirePermission("payments.recovery.manage"), requirePermission("payments.reconcile"), async (request, response) => {
  const paymentId = id(request.params.id);
  const result = await queuePaymentReconciliation(paymentId);
  await auditSecurityEvent({ actorUserId: request.auth!.userId, action: "admin.payment_reconciliation_queued", entityType: "payment", entityId: paymentId, request });
  response.status(202).json({ data: result });
});

paymentsRouter.post("/admin/refunds/:id/reconcile", requireCsrf, requireAdmin, requirePermission("payments.recovery.manage"), requirePermission("payments.reconcile"), requirePermission("refunds.manage"), async (request, response) => {
  const refundId = id(request.params.id);
  const result = await queueRefundReconciliation(refundId);
  await auditSecurityEvent({ actorUserId: request.auth!.userId, action: "admin.refund_reconciliation_queued", entityType: "refund", entityId: refundId, request });
  response.status(202).json({ data: result });
});

paymentsRouter.get("/admin/payments/:id", requireAdmin, requirePermission("payments.view"), async (request, response) => {
  const paymentId = id(request.params.id);
  const result = await getAdminPayment(paymentId);
  await auditSecurityEvent({ actorUserId: request.auth!.userId, action: "admin.payment_viewed", entityType: "payment", entityId: paymentId, request });
  response.json({ data: result });
});

paymentsRouter.get("/admin/refunds", requireAdmin, requirePermission("refunds.view"), async (request, response) => {
  const filters = parse(adminRefundQuery, request.query);
  response.json({ data: await listAdminRefunds(filters) });
});

paymentsRouter.get("/admin/refunds/:id", requireAdmin, requirePermission("refunds.view"), async (request, response) => {
  response.json({ data: await getAdminRefund(id(request.params.id)) });
});

paymentsRouter.post("/admin/payments/:id/refunds", requireCsrf, requireAdmin, requirePermission("refunds.manage"), async (request, response) => {
  const paymentId = id(request.params.id);
  const input = parse(refundInput, request.body);
  const result = await createRefund(paymentId, input.amount, input.idempotencyKey, input.reason);
  await auditSecurityEvent({ actorUserId: request.auth!.userId, action: "admin.refund_created", entityType: "payment", entityId: paymentId, request });
  response.status(201).json({ data: result });
});