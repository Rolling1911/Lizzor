import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "../config/env.js";
import { AppError } from "../middleware/error-handler.js";

export type ProviderPaymentStatus = "pending" | "requires_action" | "processing" | "succeeded" | "failed" | "cancelled";

export interface ProviderPayment {
  id: string;
  status: ProviderPaymentStatus;
  amountCents?: number;
  currency?: string;
  orderId?: string;
  clientSecret?: string;
  paymentMethodType?: string;
  failureReason?: string;
}

export interface ProviderRefund {
  id: string;
  status: "pending" | "succeeded" | "failed";
  failureReason?: string;
  amountCents?: number;
  currency?: string;
  paymentId?: string;
  localRefundId?: string;
}

export interface PaymentProvider {
  readonly name: string;
  readonly configured: boolean;
  createPayment(input: { amountCents: number; currency: string; orderId: string; idempotencyKey: string }): Promise<ProviderPayment>;
  retrievePayment(paymentId: string): Promise<ProviderPayment>;
  cancelPayment(paymentId: string): Promise<ProviderPayment>;
  createRefund(input: { paymentId: string; amountCents: number; currency: string; idempotencyKey: string; localRefundId: string }): Promise<ProviderRefund>;
  verifyWebhook(rawBody: Buffer, signature: string): Record<string, any>;
  getPayment(paymentId: string): Promise<ProviderPayment>;
  findRefund(input: { paymentId: string; localRefundId: string }): Promise<ProviderRefund | undefined>;
}

function providerStatus(value: unknown): ProviderPaymentStatus {
  if (value === "requires_action") return "requires_action";
  if (value === "processing") return "processing";
  if (value === "succeeded") return "succeeded";
  if (value === "canceled" || value === "cancelled") return "cancelled";
  if (value === "requires_payment_method") return "pending";
  return "pending";
}

async function stripeRequest(path: string, body: URLSearchParams, idempotencyKey: string): Promise<any> {
  const response = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      "content-type": "application/x-www-form-urlencoded",
      "stripe-version": env.STRIPE_API_VERSION,
      "idempotency-key": idempotencyKey,
    },
    body,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new AppError(502, "PAYMENT_PROVIDER_ERROR", typeof payload?.error?.message === "string" ? payload.error.message : "The payment provider rejected the request.");
  }
  return payload;
}

async function stripeGet(path: string): Promise<any> {
  const response = await fetch(`https://api.stripe.com/v1/${path}`, { headers: { authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, "stripe-version": env.STRIPE_API_VERSION } });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new AppError(502, "PAYMENT_PROVIDER_ERROR", typeof payload?.error?.message === "string" ? payload.error.message : "The payment provider rejected the request.");
  return payload;
}

class StripeProvider implements PaymentProvider {
  readonly name = "stripe";
  readonly configured = Boolean(env.STRIPE_SECRET_KEY);

  async createPayment(input: { amountCents: number; currency: string; orderId: string; idempotencyKey: string }): Promise<ProviderPayment> {
    if (!this.configured) throw new AppError(503, "PAYMENT_PROVIDER_NOT_CONFIGURED", "Online payments are not configured yet.");
    const body = new URLSearchParams({
      amount: String(input.amountCents),
      currency: input.currency.toLowerCase(),
      "metadata[order_id]": input.orderId,
      "automatic_payment_methods[enabled]": "true",
      description: `Lizzor order ${input.orderId}`,
    });
    const result = await stripeRequest("payment_intents", body, input.idempotencyKey);
    return {
      id: String(result.id),
      status: providerStatus(result.status),
      amountCents: Number(result.amount),
      currency: typeof result.currency === "string" ? result.currency.toUpperCase() : undefined,
      orderId: typeof result.metadata?.order_id === "string" ? result.metadata.order_id : undefined,
      clientSecret: typeof result.client_secret === "string" ? result.client_secret : undefined,
      paymentMethodType: Array.isArray(result.payment_method_types) ? String(result.payment_method_types[0] ?? "") : undefined,
      failureReason: typeof result.last_payment_error?.message === "string" ? result.last_payment_error.message : undefined,
    };
  }

  async cancelPayment(paymentId: string): Promise<ProviderPayment> {
    if (!this.configured) throw new AppError(503, "PAYMENT_PROVIDER_NOT_CONFIGURED", "Online payments are not configured yet.");
    const current = await stripeGet(`payment_intents/${encodeURIComponent(paymentId)}`);
    const currentStatus = providerStatus(current.status);
    if (currentStatus === "succeeded" || currentStatus === "cancelled" || currentStatus === "processing") return { id: String(current.id), status: currentStatus, amountCents: Number(current.amount), currency: typeof current.currency === "string" ? current.currency.toUpperCase() : undefined, orderId: typeof current.metadata?.order_id === "string" ? current.metadata.order_id : undefined };
    const result = await stripeRequest(`payment_intents/${encodeURIComponent(paymentId)}/cancel`, new URLSearchParams(), `cancel-${paymentId}`);
    return { id: String(result.id), status: providerStatus(result.status), amountCents: Number(result.amount), currency: typeof result.currency === "string" ? result.currency.toUpperCase() : undefined, orderId: typeof result.metadata?.order_id === "string" ? result.metadata.order_id : undefined };
  }

  async retrievePayment(paymentId: string): Promise<ProviderPayment> {
    if (!this.configured) throw new AppError(503, "PAYMENT_PROVIDER_NOT_CONFIGURED", "Online payments are not configured yet.");
    const result = await stripeGet(`payment_intents/${encodeURIComponent(paymentId)}`);
    return { id: String(result.id), status: providerStatus(result.status), amountCents: Number(result.amount), currency: typeof result.currency === "string" ? result.currency.toUpperCase() : undefined, orderId: typeof result.metadata?.order_id === "string" ? result.metadata.order_id : undefined, clientSecret: typeof result.client_secret === "string" ? result.client_secret : undefined, paymentMethodType: Array.isArray(result.payment_method_types) ? String(result.payment_method_types[0] ?? "") : undefined, failureReason: typeof result.last_payment_error?.message === "string" ? result.last_payment_error.message : undefined };
  }

  async getPayment(paymentId: string): Promise<ProviderPayment> {
    if (!this.configured) throw new AppError(503, "PAYMENT_PROVIDER_NOT_CONFIGURED", "Online payments are not configured yet.");
    const result = await stripeGet(`payment_intents/${encodeURIComponent(paymentId)}`);
    return {
      id: String(result.id),
      status: providerStatus(result.status),
      paymentMethodType: Array.isArray(result.payment_method_types) ? String(result.payment_method_types[0] ?? "") : undefined,
      failureReason: typeof result.last_payment_error?.message === "string" ? result.last_payment_error.message : undefined,
      amountCents: Number.isSafeInteger(Number(result.amount_received ?? result.amount)) ? Number(result.amount_received ?? result.amount) : undefined,
      currency: typeof result.currency === "string" ? result.currency.toUpperCase() : undefined,
      orderId: typeof result.metadata?.order_id === "string" ? result.metadata.order_id : undefined,
    };
  }

  async createRefund(input: { paymentId: string; amountCents: number; currency: string; idempotencyKey: string; localRefundId: string }): Promise<ProviderRefund> {
    if (!this.configured) throw new AppError(503, "PAYMENT_PROVIDER_NOT_CONFIGURED", "Online payments are not configured yet.");
    const body = new URLSearchParams({ payment_intent: input.paymentId, amount: String(input.amountCents), reason: "requested_by_customer", "metadata[refund_id]": input.localRefundId });
    const result = await stripeRequest("refunds", body, input.idempotencyKey);
    if (!result || typeof result.id !== "string" || !result.id ||
        !result.metadata || result.metadata.refund_id !== input.localRefundId) {
      throw new AppError(502, "PAYMENT_REFUND_FACTS_INVALID", "The payment provider returned invalid refund identity facts.");
    }
    return {
      id: result.id,
      status: result.status === "succeeded" ? "succeeded" : result.status === "failed" ? "failed" : "pending",
      failureReason: typeof result.failure_reason === "string" ? result.failure_reason : undefined,
      amountCents: Number.isSafeInteger(Number(result.amount)) ? Number(result.amount) : undefined,
      currency: typeof result.currency === "string" ? result.currency.toUpperCase() : undefined,
      paymentId: typeof result.payment_intent === "string" ? result.payment_intent : undefined,
      localRefundId: input.localRefundId,
    };
  }

  async findRefund(input: { paymentId: string; localRefundId: string }): Promise<ProviderRefund | undefined> {
    if (!this.configured) throw new AppError(503, "PAYMENT_PROVIDER_NOT_CONFIGURED", "Online refunds are not configured yet.");
    const result = await stripeGet(`refunds?payment_intent=${encodeURIComponent(input.paymentId)}&limit=100`);
    const match = Array.isArray(result.data)
      ? result.data.find((refund: any) => refund?.metadata?.refund_id === input.localRefundId)
      : undefined;
    if (!match || typeof match.id !== "string" || !match.id || match.metadata?.refund_id !== input.localRefundId) return undefined;
    return {
      id: match.id,
      status: match.status === "succeeded" ? "succeeded" : match.status === "failed" ? "failed" : "pending",
      failureReason: typeof match.failure_reason === "string" ? match.failure_reason : undefined,
      amountCents: Number.isSafeInteger(Number(match.amount)) ? Number(match.amount) : undefined,
      currency: typeof match.currency === "string" ? match.currency.toUpperCase() : undefined,
      paymentId: typeof match.payment_intent === "string" ? match.payment_intent : undefined,
      localRefundId: typeof match.metadata?.refund_id === "string" ? match.metadata.refund_id : undefined,
    };
  }

  verifyWebhook(rawBody: Buffer, signature: string): Record<string, any> {
    if (!env.STRIPE_WEBHOOK_SECRET) throw new AppError(503, "PAYMENT_WEBHOOK_NOT_CONFIGURED", "Payment webhooks are not configured yet.");
    const values = signature.split(",").map((part) => part.split("=", 2) as [string, string]);
    const timestamp = Number(values.find(([key]) => key === "t")?.[1]);
    const signatures = values.filter(([key]) => key === "v1").map(([, value]) => value);
    if (!Number.isInteger(timestamp) || !signatures.length || Math.abs(Date.now() / 1000 - timestamp) > 300) throw new AppError(400, "INVALID_PAYMENT_SIGNATURE", "The payment webhook signature is invalid.");
    const expected = createHmac("sha256", env.STRIPE_WEBHOOK_SECRET).update(`${timestamp}.${rawBody.toString("utf8")}`).digest("hex");
    const expectedBuffer = Buffer.from(expected, "utf8");
    const valid = signatures.some((supplied) => {
      const suppliedBuffer = Buffer.from(supplied, "utf8");
      return expectedBuffer.length === suppliedBuffer.length && timingSafeEqual(expectedBuffer, suppliedBuffer);
    });
    if (!valid) throw new AppError(400, "INVALID_PAYMENT_SIGNATURE", "The payment webhook signature is invalid.");
    let payload: Record<string, any>;
    try { payload = JSON.parse(rawBody.toString("utf8")); } catch { throw new AppError(400, "INVALID_PAYMENT_PAYLOAD", "The payment webhook payload is invalid."); }
    return payload;
  }
}

class FakePaymentProvider implements PaymentProvider {
  readonly name = "fake";
  readonly configured = env.NODE_ENV === "test" && env.PAYMENT_PROVIDER === "fake";

  async createPayment(input: { amountCents: number; currency: string; orderId: string; idempotencyKey: string }): Promise<ProviderPayment> {
    if (!this.configured) throw new AppError(503, "PAYMENT_PROVIDER_NOT_CONFIGURED", "The test payment provider is unavailable outside tests.");
    const id = `fake_pi_${input.idempotencyKey.slice(0, 40)}`;
    fakePaymentCreateCounts.set(id, (fakePaymentCreateCounts.get(id) ?? 0) + 1);
    fakePaymentStatuses.set(id, fakePaymentStatuses.get(id) ?? "requires_action");
    fakePaymentFacts.set(id, { amountCents: input.amountCents, currency: input.currency.toUpperCase(), orderId: input.orderId });
    return { id, status: fakePaymentStatuses.get(id)!, ...fakePaymentFacts.get(id), clientSecret: `fake_secret_${input.orderId}`, paymentMethodType: "card" };
  }

  async retrievePayment(paymentId: string): Promise<ProviderPayment> {
    if (!this.configured) throw new AppError(503, "PAYMENT_PROVIDER_NOT_CONFIGURED", "The test payment provider is unavailable outside tests.");
    const failure = fakePaymentFailures.get(paymentId);
    if (failure) throw new AppError(502, "PAYMENT_PROVIDER_TIMEOUT", failure);
    fakePaymentLookupCounts.set(paymentId, (fakePaymentLookupCounts.get(paymentId) ?? 0) + 1);
    const facts = fakePaymentFacts.get(paymentId);
    return { id: paymentId, status: fakePaymentStatuses.get(paymentId) ?? "requires_action", ...facts, clientSecret: facts ? `fake_secret_${facts.orderId}` : undefined, paymentMethodType: "card" };
  }

  async createRefund(input: { paymentId: string; amountCents: number; currency: string; idempotencyKey: string }): Promise<ProviderRefund> {
    if (!this.configured) throw new AppError(503, "PAYMENT_PROVIDER_NOT_CONFIGURED", "The test payment provider is unavailable outside tests.");
    fakePaymentRefundCounts.set(input.idempotencyKey, (fakePaymentRefundCounts.get(input.idempotencyKey) ?? 0) + 1);
    const failure = fakePaymentRefundFailures.get(input.idempotencyKey);
    const refund = { id: `fake_re_${input.idempotencyKey.slice(0, 40)}`, status: "succeeded" as const, amountCents: input.amountCents, currency: input.currency.toUpperCase(), paymentId: input.paymentId, localRefundId: (input as any).localRefundId };
    fakePaymentRefunds.set(input.idempotencyKey, refund);
    if (failure) throw new AppError(502, "PAYMENT_PROVIDER_TIMEOUT", failure);
    return refund;
  }

  async getPayment(paymentId: string): Promise<ProviderPayment> {
    if (!this.configured) throw new AppError(503, "PAYMENT_PROVIDER_NOT_CONFIGURED", "The test payment provider is unavailable outside tests.");
    fakePaymentLookupCounts.set(paymentId, (fakePaymentLookupCounts.get(paymentId) ?? 0) + 1);
    const succeeded = paymentId.match(/^fake_pi_succeeded_(\d+)_([A-Z]{3})_([0-9a-f-]{36})$/i);
    if (succeeded) return { id: paymentId, status: "succeeded", amountCents: Number(succeeded[1]), currency: succeeded[2].toUpperCase(), orderId: succeeded[3] };
    return { id: paymentId, status: "requires_action", paymentMethodType: "card" };
  }

  async findRefund(_input: { paymentId: string; localRefundId: string }): Promise<ProviderRefund | undefined> {
    if (!this.configured) throw new AppError(503, "PAYMENT_PROVIDER_NOT_CONFIGURED", "The test payment provider is unavailable outside tests.");
    const simulated = _input.paymentId.match(/^fake_pi_refund_(pending|succeeded)_(\d+)_([A-Z]{3})$/);
    if (simulated) return { id: `fake_re_found_${_input.localRefundId}`, status: simulated[1] as "pending" | "succeeded", amountCents: Number(simulated[2]), currency: simulated[3], paymentId: _input.paymentId, localRefundId: _input.localRefundId };
    return [...fakePaymentRefunds.values()].find((refund) => refund.paymentId === _input.paymentId);
  }

  async cancelPayment(paymentId: string): Promise<ProviderPayment> {
    if (!this.configured) throw new AppError(503, "PAYMENT_PROVIDER_NOT_CONFIGURED", "The test payment provider is unavailable outside tests.");
    const transition = fakePaymentStatusOnCancel.get(paymentId);
    if (transition) {
      fakePaymentStatuses.set(paymentId, transition);
      fakePaymentStatusOnCancel.delete(paymentId);
    }
    if (["succeeded", "cancelled", "processing"].includes(fakePaymentStatuses.get(paymentId) ?? "pending")) return this.retrievePayment(paymentId);
    fakePaymentCancelCounts.set(paymentId, (fakePaymentCancelCounts.get(paymentId) ?? 0) + 1);
    fakePaymentStatuses.set(paymentId, "cancelled");
    return this.retrievePayment(paymentId);
  }

  verifyWebhook(rawBody: Buffer, signature: string): Record<string, any> {
    if (!this.configured) throw new AppError(503, "PAYMENT_WEBHOOK_NOT_CONFIGURED", "The test payment provider is unavailable outside tests.");
    if (signature !== "test-signature") throw new AppError(400, "INVALID_PAYMENT_SIGNATURE", "The payment webhook signature is invalid.");
    try { return JSON.parse(rawBody.toString("utf8")); } catch { throw new AppError(400, "INVALID_PAYMENT_PAYLOAD", "The payment webhook payload is invalid."); }
  }
}

export function getPaymentProvider(): PaymentProvider {
  return env.PAYMENT_PROVIDER === "fake" ? new FakePaymentProvider() : new StripeProvider();
}

const fakePaymentStatuses = new Map<string, ProviderPaymentStatus>();
const fakePaymentFailures = new Map<string, string>();
const fakePaymentFacts = new Map<string, { amountCents: number; currency: string; orderId: string }>();
const fakePaymentCreateCounts = new Map<string, number>();
const fakePaymentCancelCounts = new Map<string, number>();
const fakePaymentRefundCounts = new Map<string, number>();
const fakePaymentRefundFailures = new Map<string, string>();
const fakePaymentRefunds = new Map<string, ProviderRefund>();
const fakePaymentLookupCounts = new Map<string, number>();
const fakePaymentStatusOnCancel = new Map<string, ProviderPaymentStatus>();

export function setFakePaymentStatusForTest(paymentId: string, status: ProviderPaymentStatus): void {
  if (env.NODE_ENV !== "test" || env.PAYMENT_PROVIDER !== "fake") throw new Error("Fake payment controls are test-only.");
  fakePaymentStatuses.set(paymentId, status);
  fakePaymentFailures.delete(paymentId);
}

export function setFakePaymentFailureForTest(paymentId: string, message = "Test provider failure"): void {
  if (env.NODE_ENV !== "test" || env.PAYMENT_PROVIDER !== "fake") throw new Error("Fake payment controls are test-only.");
  fakePaymentFailures.set(paymentId, message);
}

export function setFakePaymentFactsForTest(paymentId: string, facts: { amountCents: number; currency: string; orderId: string }): void {
  if (env.NODE_ENV !== "test" || env.PAYMENT_PROVIDER !== "fake") throw new Error("Fake payment controls are test-only.");
  fakePaymentFacts.set(paymentId, facts);
}

export function getFakePaymentCreateCountForTest(paymentId: string): number {
  if (env.NODE_ENV !== "test" || env.PAYMENT_PROVIDER !== "fake") throw new Error("Fake payment controls are test-only.");
  return fakePaymentCreateCounts.get(paymentId) ?? 0;
}

export function getFakePaymentCancelCountForTest(paymentId: string): number {
  if (env.NODE_ENV !== "test" || env.PAYMENT_PROVIDER !== "fake") throw new Error("Fake payment controls are test-only.");
  return fakePaymentCancelCounts.get(paymentId) ?? 0;
}

export function getFakePaymentRefundCountForTest(idempotencyKey: string): number {
  if (env.NODE_ENV !== "test" || env.PAYMENT_PROVIDER !== "fake") throw new Error("Fake payment controls are test-only.");
  return fakePaymentRefundCounts.get(idempotencyKey) ?? 0;
}

/** Simulates a provider mutation that was submitted but whose response was lost. */
export function setFakePaymentRefundFailureAfterCallForTest(idempotencyKey: string, message = "Response lost after refund submission"): void {
  if (env.NODE_ENV !== "test" || env.PAYMENT_PROVIDER !== "fake") throw new Error("Fake payment controls are test-only.");
  fakePaymentRefundFailures.set(idempotencyKey, message);
}

export function getFakePaymentRefundTotalForTest(): number {
  if (env.NODE_ENV !== "test" || env.PAYMENT_PROVIDER !== "fake") throw new Error("Fake payment controls are test-only.");
  return [...fakePaymentRefundCounts.values()].reduce((total, count) => total + count, 0);
}

export function getFakePaymentLookupCountForTest(paymentId: string): number {
  if (env.NODE_ENV !== "test" || env.PAYMENT_PROVIDER !== "fake") throw new Error("Fake payment controls are test-only.");
  return fakePaymentLookupCounts.get(paymentId) ?? 0;
}

export function setFakePaymentStatusOnCancelForTest(paymentId: string, status: ProviderPaymentStatus): void {
  if (env.NODE_ENV !== "test" || env.PAYMENT_PROVIDER !== "fake") throw new Error("Fake payment controls are test-only.");
  fakePaymentStatusOnCancel.set(paymentId, status);
}

export function mapProviderEventStatus(eventType: string): ProviderPaymentStatus | undefined {
  if (eventType === "payment_intent.succeeded") return "succeeded";
  if (eventType === "payment_intent.payment_failed") return "failed";
  if (eventType === "payment_intent.canceled" || eventType === "payment_intent.cancelled") return "cancelled";
  if (eventType === "payment_intent.processing") return "processing";
  if (eventType === "payment_intent.requires_action") return "requires_action";
  return undefined;
}
