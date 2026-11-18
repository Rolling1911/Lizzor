import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Elements, PaymentElement, useElements, useStripe } from "@stripe/react-stripe-js";
import { loadStripe, type Stripe } from "@stripe/stripe-js";
import { apiRequest } from "../../auth/api";
import { LoadingState, StatusBadge } from "../../components/admin/AdminPrimitives";
import { writeCheckoutRecoveryContext } from "../../lib/browserStorage";

type Payment = {
  id: string;
  status: string;
  amount: number;
  currency: string;
  failureReason?: string | null;
};

type PaymentAttempt = { payment: Payment; clientSecret?: string };
type PaymentConfig = { provider: string; publishableKey: string | null; returnOrigin: string | null };

const terminalStatuses = new Set(["paid", "failed", "cancelled", "refunded", "partially_refunded"]);
const settledStatuses = new Set(["paid", "refunded", "partially_refunded"]);
let stripePromise: Promise<Stripe | null> | null = null;

export function canStartPayment(orderStatus: string, paymentStatus?: string): boolean {
  if (orderStatus !== "pending") return false;
  return !paymentStatus || ["pending", "requires_action", "failed", "cancelled"].includes(paymentStatus);
}

export function shouldUnmountPaymentElement(paymentStatus?: string): boolean {
  return Boolean(paymentStatus && ["paid", "cancelled", "refunded", "partially_refunded"].includes(paymentStatus));
}

function paymentMessage(payment?: Payment): string {
  if (!payment) return "No payment attempt has been created for this order.";
  if (payment.status === "paid") return `Payment received securely.`;
  if (payment.status === "processing") return "Your payment is processing. This page will update after Stripe confirms it.";
  if (payment.status === "requires_action") return "Your payment needs another confirmation step.";
  if (payment.status === "failed") return payment.failureReason || "The payment failed. You can try again.";
  if (payment.status === "cancelled") return "The payment was cancelled.";
  return "Your payment is ready to complete.";
}

function StripeConfirmationForm({
  returnUrl,
  onBeforeConfirm,
  onConfirmed,
}: {
  returnUrl: string;
  onBeforeConfirm: () => void;
  onConfirmed: () => Promise<void>;
}) {
  const stripe = useStripe();
  const elements = useElements();
  const [ready, setReady] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const confirmationInFlight = useRef(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    event.stopPropagation();
    if (!stripe || !elements || !ready || confirmationInFlight.current) return;
    confirmationInFlight.current = true;
    setSubmitting(true);
    setError("");
    try {
      const submission = await elements.submit();
      if (submission?.error) {
        setError(submission.error.message || "Check your payment details and try again.");
        return;
      }
      onBeforeConfirm();
      const result = await stripe.confirmPayment({
        elements,
        confirmParams: { return_url: returnUrl },
        redirect: "if_required",
      });
      if (result.error) {
        setError(result.error.message || "Stripe could not confirm this payment.");
        return;
      }
      await onConfirmed();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Stripe could not confirm this payment.");
    } finally {
      confirmationInFlight.current = false;
      setSubmitting(false);
    }
  }

  return (
    <form className="stripe-payment-form" onSubmit={(event) => void submit(event)}>
      <PaymentElement onReady={() => setReady(true)} />
      {error && <p className="form-message form-message--error" role="alert">{error}</p>}
      <button className="button button--dark" type="submit" disabled={!stripe || !elements || !ready || submitting}>
        {submitting ? "Processing payment…" : "Pay securely"}
      </button>
      <small>Payment details are collected securely by Stripe. Lizzor never receives your card number.</small>
    </form>
  );
}

export function StripePaymentPanel({
  orderId,
  orderStatus,
  guestToken,
  onOrderRefresh,
  autoStart = false,
  pollIntervalMs = 1500,
  pollAttempts = 12,
}: {
  orderId: string;
  orderStatus: string;
  guestToken?: string;
  onOrderRefresh?: () => Promise<void>;
  autoStart?: boolean;
  pollIntervalMs?: number;
  pollAttempts?: number;
}) {
  const [payments, setPayments] = useState<Payment[] | null>(null);
  const [config, setConfig] = useState<PaymentConfig | null>(null);
  const [clientSecret, setClientSecret] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const polling = useRef(false);
  const starting = useRef(false);
  const base = guestToken ? `/guest/orders/${orderId}/payments` : `/account/orders/${orderId}/payments`;
  const headers = useMemo(() => guestToken ? { "x-order-access-token": guestToken } : undefined, [guestToken]);

  const load = useCallback(async () => {
    const response = await apiRequest<{ data: Payment[] }>(base, { headers });
    setPayments(response.data);
    await onOrderRefresh?.();
    return response.data[0];
  }, [base, headers, onOrderRefresh]);

  const pollUntilSettled = useCallback(async () => {
    if (polling.current) return;
    polling.current = true;
    try {
      for (let attempt = 0; attempt < pollAttempts; attempt += 1) {
        const latest = await load();
        if (shouldUnmountPaymentElement(latest?.status)) setClientSecret("");
        if (latest && terminalStatuses.has(latest.status)) break;
        await new Promise((resolve) => window.setTimeout(resolve, pollIntervalMs));
      }
    } finally {
      polling.current = false;
    }
  }, [load, pollAttempts, pollIntervalMs]);

  useEffect(() => {
    void Promise.all([
      load(),
      apiRequest<{ data: PaymentConfig }>("/payments/config").then((response) => setConfig(response.data)),
    ]).catch((reason) => setError(reason instanceof Error ? reason.message : "Payment configuration is unavailable."));
  }, [load]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (!params.has("payment_return") && !params.has("redirect_status")) return;
    params.delete("payment_return");
    params.delete("payment_intent");
    params.delete("payment_intent_client_secret");
    params.delete("redirect_status");
    window.history.replaceState(null, "", `${window.location.pathname}${params.size ? `?${params}` : ""}${window.location.hash}`);
    void pollUntilSettled();
  }, [pollUntilSettled]);

  useEffect(() => {
    const latestStatus = payments?.[0]?.status;
    if (autoStart && payments && !clientSecret && latestStatus !== "failed" && latestStatus !== "cancelled" && canStartPayment(orderStatus, latestStatus)) void start();
  // autoStart is intentionally a one-way entry signal; payment status changes are handled by polling.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoStart, payments, clientSecret, orderStatus]);

  async function start() {
    if (starting.current) return;
    starting.current = true;
    setBusy(true);
    setError("");
    try {
      const response = await apiRequest<{ data: PaymentAttempt }>(base, {
        method: "POST",
        headers,
        body: JSON.stringify({ idempotencyKey: crypto.randomUUID() }),
      });
      setPayments((current) => [response.data.payment, ...(current ?? []).filter((item) => item.id !== response.data.payment.id)]);
      if (!response.data.clientSecret) throw new Error("Stripe did not return a client secret for this payment.");
      setClientSecret(response.data.clientSecret);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Payment could not be started.");
    } finally {
      starting.current = false;
      setBusy(false);
    }
  }

  const latest = payments?.[0];
  const publishableKey = config?.publishableKey;
  if (publishableKey && !stripePromise) stripePromise = loadStripe(publishableKey);
  const returnUrl = new URL("/checkout?payment_return=1", config?.returnOrigin || window.location.origin).toString();
  const preserveReturnContext = useCallback(() => {
    writeCheckoutRecoveryContext(orderId, guestToken ?? "");
  }, [guestToken, orderId]);

  return (
    <section className="admin-panel payment-panel">
      <div className="section-heading">
        <div><span className="eyebrow">Payment</span><h2>Payment status</h2></div>
        {latest && <StatusBadge status={latest.status} tone={settledStatuses.has(latest.status) ? "positive" : latest.status === "failed" || latest.status === "cancelled" ? "negative" : "warning"} />}
      </div>
      {!payments ? <LoadingState label="Checking payment status…" /> : <p>{paymentMessage(latest)}</p>}
      {error && <p className="form-message form-message--error" role="alert">{error}</p>}
      {config && (!publishableKey || config.provider !== "stripe") && <p className="form-message form-message--error">Online card payments are not configured.</p>}
      {!clientSecret && publishableKey && canStartPayment(orderStatus, latest?.status) && (
        <button className="button button--dark button--small" disabled={busy} onClick={() => void start()}>
          {busy ? "Preparing secure payment…" : latest ? "Continue payment" : "Pay securely"}
        </button>
      )}
      {clientSecret && stripePromise && (
        <Elements
          stripe={stripePromise}
          options={{
            clientSecret,
            appearance: {
              theme: "stripe",
              variables: { colorPrimary: "#17231b", borderRadius: "8px" },
            },
          }}
        >
          <StripeConfirmationForm returnUrl={returnUrl} onBeforeConfirm={preserveReturnContext} onConfirmed={pollUntilSettled} />
        </Elements>
      )}
    </section>
  );
}