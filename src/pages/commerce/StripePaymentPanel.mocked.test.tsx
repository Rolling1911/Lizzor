// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";

const mocks = vi.hoisted(() => ({
  apiRequest: vi.fn(),
  elementsSubmit: vi.fn(),
  confirmPayment: vi.fn(),
  loadStripe: vi.fn(async () => ({ mocked: true })),
  authUser: null as null | {
    email: string;
    phone?: string | null;
    accountType: "personal" | "business";
    firstName: string;
    lastName: string;
  },
}));

vi.mock("../../auth/api", () => ({ apiRequest: mocks.apiRequest }));
vi.mock("../../auth/AuthContext", () => ({
  useAuth: () => ({ user: mocks.authUser, loading: false }),
}));
vi.mock("@stripe/stripe-js", () => ({ loadStripe: mocks.loadStripe }));
vi.mock("@stripe/react-stripe-js", () => ({
  Elements: ({ children }: { children: React.ReactNode }) => <div data-testid="stripe-elements">{children}</div>,
  PaymentElement: ({ onReady }: { onReady?: () => void }) => {
    React.useEffect(() => { onReady?.(); }, [onReady]);
    return <div data-testid="payment-element">Mock Stripe Payment Element</div>;
  },
  useStripe: () => ({ confirmPayment: mocks.confirmPayment }),
  useElements: () => ({ mocked: true, submit: mocks.elementsSubmit }),
}));

import { StripePaymentPanel } from "./StripePaymentPanel";
import { CartPage, CheckoutPage, CustomerOrderDetailPage, GuestOrderDetailPage, ShopPage, customerOrderTitle, vatTotalLabel } from "./CommercePages";
import { browserStorageKeys, readCheckoutRecoveryContext, readGuestOrderAccess, writeCheckoutRecoveryContext, writeGuestOrderAccess } from "../../lib/browserStorage";

type Status = "pending" | "requires_action" | "processing" | "paid" | "failed" | "cancelled";
const payment = (status: Status) => ({
  id: "payment-1",
  status,
  amount: 25,
  currency: "EUR",
  failureReason: status === "failed" ? "Card declined" : null,
});
const config = { provider: "stripe", publishableKey: "pk_test_mocked", returnOrigin: "https://lizzor.com" };
const order = {
  id: "order-1",
  orderNumber: "LZ-MOCK-1",
  createdAt: "2026-09-04T12:00:00.000Z",
  status: "pending",
  paymentStatus: "pending",
  fulfillmentStatus: "unfulfilled",
  fulfillmentStage: "pending",
  currency: "EUR",
  grandTotal: 25,
  items: [{
    id: "internal-order-item-uuid",
    productName: "Visible Product",
    variantName: "Blue",
    sku: "phase5b1-1788083137180-9eeafceea72dd8-variant",
    quantity: 1,
    unitPrice: 25,
    taxRate: 19,
    lineTotal: 25,
  }],
};

function setupApi({
  base,
  statuses = ["pending"],
}: {
  base: string;
  statuses?: Status[];
}) {
  let reads = 0;
  mocks.apiRequest.mockImplementation(async (path: string, init: RequestInit = {}) => {
    if (path === "/payments/config") return { data: config };
    if (path === base && init.method === "POST") {
      return { data: { payment: payment("pending"), clientSecret: "pi_mock_secret" } };
    }
    if (path === base) {
      const status = statuses[Math.min(reads, statuses.length - 1)];
      reads += 1;
      return { data: [payment(status)] };
    }
    throw new Error(`Unexpected request: ${init.method ?? "GET"} ${path}`);
  });
}

async function initiateAndConfirm({
  path,
  base,
  guestToken,
}: {
  path: string;
  base: string;
  guestToken?: string;
}) {
  window.history.replaceState(null, "", path);
  setupApi({ base, statuses: ["pending", "processing", "paid"] });
  mocks.confirmPayment.mockResolvedValue({ paymentIntent: { status: "processing" } });
  const onOrderRefresh = vi.fn(async () => undefined);
  render(
    <StripePaymentPanel
      orderId="order-1"
      orderStatus="pending"
      guestToken={guestToken}
      onOrderRefresh={onOrderRefresh}
      pollIntervalMs={1}
      pollAttempts={5}
    />,
  );

  const prepare = await screen.findByRole("button", { name: "Continue payment" });
  fireEvent.click(prepare);
  fireEvent.click(prepare);
  await screen.findByTestId("payment-element");
  expect(mocks.apiRequest.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);

  const payButton = screen.getByRole("button", { name: "Pay securely" });
  await waitFor(() => expect((payButton as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(payButton);
  fireEvent.click(payButton);
  await waitFor(() => expect(mocks.confirmPayment).toHaveBeenCalledTimes(1));
  expect(mocks.confirmPayment).toHaveBeenCalledWith({
    elements: { mocked: true, submit: mocks.elementsSubmit },
    confirmParams: { return_url: "https://lizzor.com/checkout?payment_return=1" },
    redirect: "if_required",
  });
  expect(mocks.elementsSubmit).toHaveBeenCalledTimes(1);
  expect(mocks.elementsSubmit.mock.invocationCallOrder[0]).toBeLessThan(mocks.confirmPayment.mock.invocationCallOrder[0]);
}

async function verifyRedirectReturn({
  path,
  base,
  finalStatus,
  guestToken,
  redirectStatus = finalStatus,
}: {
  path: string;
  base: string;
  finalStatus: Exclude<Status, "pending">;
  guestToken?: string;
  redirectStatus?: string;
}) {
  window.history.replaceState(null, "", `${path}?payment_return=1&payment_intent=pi_mock&payment_intent_client_secret=secret&redirect_status=${redirectStatus}`);
  setupApi({ base, statuses: ["processing", "processing", finalStatus] });
  const onOrderRefresh = vi.fn(async () => undefined);
  render(
    <StripePaymentPanel
      orderId="order-1"
      orderStatus={finalStatus === "cancelled" ? "cancelled" : "pending"}
      guestToken={guestToken}
      onOrderRefresh={onOrderRefresh}
      pollIntervalMs={1}
      pollAttempts={5}
    />,
  );

  await waitFor(() => {
    const expected = finalStatus === "paid"
      ? "Payment received securely."
      : finalStatus === "processing"
        ? "Your payment is processing. This page will update after Stripe confirms it."
        : finalStatus === "failed"
          ? "Card declined"
          : "The payment was cancelled.";
    expect(screen.getByText(expected)).toBeTruthy();
  });
  expect(window.location.search).toBe("");
  expect(mocks.apiRequest.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
  expect(onOrderRefresh).toHaveBeenCalled();
  if (guestToken) {
    const paymentCalls = mocks.apiRequest.mock.calls.filter(([requestPath]) => requestPath === base);
    expect(paymentCalls.every(([, init]) => init?.headers?.["x-order-access-token"] === guestToken)).toBe(true);
  }
}

describe("StripePaymentPanel mocked confirmation and redirect flows", () => {
  beforeEach(() => {
    mocks.apiRequest.mockReset();
    mocks.elementsSubmit.mockReset();
    mocks.elementsSubmit.mockResolvedValue({});
    mocks.confirmPayment.mockReset();
    mocks.loadStripe.mockClear();
    mocks.authUser = null;
    sessionStorage.clear();
  });
  afterEach(() => cleanup());

  it("starts authenticated redirect-capable 3D Secure confirmation once with the canonical return URL", async () => {
    await initiateAndConfirm({
      path: "/account/orders/order-1",
      base: "/account/orders/order-1/payments",
    });
  });

  it("starts guest redirect-capable 3D Secure confirmation once while preserving guest authorization", async () => {
    await initiateAndConfirm({
      path: "/order-confirmation/order-1",
      base: "/guest/orders/order-1/payments",
      guestToken: "guest-token",
    });
    const paymentCalls = mocks.apiRequest.mock.calls.filter(([path]) => path === "/guest/orders/order-1/payments");
    expect(paymentCalls.every(([, init]) => init?.headers?.["x-order-access-token"] === "guest-token")).toBe(true);
  });

  it("does not block Stripe confirmation when sessionStorage is unavailable", async () => {
    const blocked = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new DOMException("Blocked", "QuotaExceededError"); });
    await initiateAndConfirm({
      path: "/order-confirmation/order-1",
      base: "/guest/orders/order-1/payments",
      guestToken: "guest-token",
    });
    blocked.mockRestore();
  });

  it.each([
    ["authenticated", "/account/orders/order-1", "/account/orders/order-1/payments", undefined],
    ["guest", "/order-confirmation/order-1", "/guest/orders/order-1/payments", "guest-token"],
  ])("restores and polls %s orders after Stripe redirect success", async (_kind, path, base, guestToken) => {
    await verifyRedirectReturn({ path, base, finalStatus: "paid", guestToken });
  });

  it.each([
    ["authenticated", "/account/orders/order-1", "/account/orders/order-1/payments", undefined, "processing"],
    ["authenticated", "/account/orders/order-1", "/account/orders/order-1/payments", undefined, "failed"],
    ["authenticated", "/account/orders/order-1", "/account/orders/order-1/payments", undefined, "cancelled"],
    ["guest", "/order-confirmation/order-1", "/guest/orders/order-1/payments", "guest-token", "processing"],
    ["guest", "/order-confirmation/order-1", "/guest/orders/order-1/payments", "guest-token", "failed"],
    ["guest", "/order-confirmation/order-1", "/guest/orders/order-1/payments", "guest-token", "cancelled"],
  ] as const)("uses backend %s %s status after redirect without creating another attempt", async (_kind, path, base, guestToken, finalStatus) => {
    await verifyRedirectReturn({
      path,
      base,
      finalStatus,
      guestToken,
    });
  });

  it("does not trust a successful browser redirect before the backend reports payment settlement", async () => {
    await verifyRedirectReturn({
      path: "/account/orders/order-1",
      base: "/account/orders/order-1/payments",
      finalStatus: "processing",
      redirectStatus: "succeeded",
    });
    expect(screen.queryByText("Payment received securely.")).toBeNull();
  });

  it("keeps the Payment Element available after a mocked authentication cancellation error", async () => {
    window.history.replaceState(null, "", "/account/orders/order-1");
    setupApi({ base: "/account/orders/order-1/payments" });
    mocks.confirmPayment.mockResolvedValue({ error: { message: "Authentication was cancelled." } });
    render(<StripePaymentPanel orderId="order-1" orderStatus="pending" pollIntervalMs={1} pollAttempts={2} />);
    fireEvent.click(await screen.findByRole("button", { name: "Continue payment" }));
    const form = (await screen.findByTestId("payment-element")).closest("form")!;
    await waitFor(() => expect((screen.getByRole("button", { name: "Pay securely" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.submit(form);
    await screen.findByText("Authentication was cancelled.");
    expect(screen.getByTestId("payment-element")).toBeTruthy();
    expect(mocks.confirmPayment).toHaveBeenCalledTimes(1);
  });

  it("prevents native form submission and surfaces Payment Element validation without confirming", async () => {
    window.history.replaceState(null, "", "/checkout");
    setupApi({ base: "/account/orders/order-1/payments" });
    mocks.elementsSubmit.mockResolvedValue({ error: { message: "Your card number is incomplete." } });
    render(<StripePaymentPanel orderId="order-1" orderStatus="pending" pollIntervalMs={1} pollAttempts={2} />);
    fireEvent.click(await screen.findByRole("button", { name: "Continue payment" }));
    const form = (await screen.findByTestId("payment-element")).closest("form")!;
    fireEvent.submit(form);
    await screen.findByText("Your card number is incomplete.");
    expect(mocks.confirmPayment).not.toHaveBeenCalled();
    expect((screen.getByRole("button", { name: "Pay securely" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("polls backend state after confirmation succeeds and preserves the existing order context", async () => {
    window.history.replaceState(null, "", "/checkout");
    setupApi({ base: "/account/orders/order-1/payments", statuses: ["pending", "paid"] });
    mocks.confirmPayment.mockResolvedValue({ paymentIntent: { status: "processing" } });
    const onOrderRefresh = vi.fn(async () => undefined);
    render(<StripePaymentPanel orderId="order-1" orderStatus="pending" onOrderRefresh={onOrderRefresh} pollIntervalMs={1} pollAttempts={3} />);
    fireEvent.click(await screen.findByRole("button", { name: "Continue payment" }));
    const paymentForm = (await screen.findByTestId("payment-element")).closest("form")!;
    await waitFor(() => expect((screen.getByRole("button", { name: "Pay securely" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.submit(paymentForm);
    await waitFor(() => expect(screen.getByText("Payment received securely.")).toBeTruthy());
    expect(mocks.confirmPayment).toHaveBeenCalledTimes(1);
    expect(onOrderRefresh).toHaveBeenCalled();
    expect(readCheckoutRecoveryContext()?.orderId).toBe("order-1");
    expect(mocks.apiRequest.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });

  it.each([
    ["authenticated", "/account/orders/order-1", "/account/orders/order-1/payments", undefined],
    ["guest", "/order-confirmation/order-1", "/guest/orders/order-1/payments", "guest-token"],
  ])("restores the real %s order page after a Stripe redirect", async (kind, path, paymentBase, guestToken) => {
    window.history.replaceState(null, "", `${path}?payment_return=1&payment_intent=pi_mock&redirect_status=succeeded`);
    if (guestToken) writeGuestOrderAccess("order-1", guestToken);
    mocks.apiRequest.mockImplementation(async (requestPath: string, init: RequestInit = {}) => {
      if (requestPath === "/payments/config") return { data: config };
      if (requestPath === paymentBase) {
        return { data: [payment("paid")] };
      }
      if (requestPath === path.replace("/order-confirmation/", "/guest/orders/")) {
        if (guestToken) expect((init.headers as Record<string, string> | undefined)?.["x-order-access-token"]).toBe(guestToken);
        return { data: { ...order, paymentStatus: "paid", status: "confirmed" } };
      }
      if (requestPath === path) return { data: { ...order, paymentStatus: "paid", status: "confirmed" } };
      if (requestPath.endsWith("/tracking")) return { data: { shipments: [], timeline: [] } };
      if (requestPath.endsWith("/returns")) return { data: [] };
      throw new Error(`Unexpected ${kind} route request: ${init.method ?? "GET"} ${requestPath}`);
    });

    render(
      <MemoryRouter initialEntries={[`${path}?payment_return=1&payment_intent=pi_mock&redirect_status=succeeded`]}>
        <Routes>
          <Route path="/account/orders/:id" element={<CustomerOrderDetailPage />} />
          <Route path="/order-confirmation/:id" element={<GuestOrderDetailPage />} />
        </Routes>
      </MemoryRouter>,
    );

    await screen.findByText("LZ-MOCK-1");
    await waitFor(() => expect(screen.getByText("Payment received securely.")).toBeTruthy());
    expect(screen.getByText("Visible Product · Blue")).toBeTruthy();
    expect(screen.queryByText("phase5b1-1788083137180-9eeafceea72dd8-variant")).toBeNull();
    expect(screen.queryByText("internal-order-item-uuid")).toBeNull();
    expect(mocks.apiRequest.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
    if (guestToken) {
      const guestCalls = mocks.apiRequest.mock.calls.filter(([requestPath]) => requestPath.startsWith("/guest/orders/order-1"));
      expect(guestCalls.length).toBeGreaterThan(0);
      expect(guestCalls.every(([, init]) => init?.headers?.["x-order-access-token"] === guestToken)).toBe(true);
    }
  });

  it("renders meaningful catalog and cart labels without internal product metadata", async () => {
    const internalSku = "phase5b1-1788083137180-9eeafceea72dd8-variant";
    mocks.apiRequest.mockImplementation(async (path: string) => {
      if (path === "/shop/products") return { data: { items: [{ productId: "internal-product-uuid", variantId: "internal-variant-uuid", productName: "Visible Product", variantTitle: "Blue", sku: internalSku, unitPrice: 25, currency: "EUR", available: 4 }] } };
      if (path === "/cart") return { data: { id: "internal-cart-uuid", currency: "EUR", items: [{ id: "internal-cart-item-uuid", productId: "internal-product-uuid", variantId: "internal-variant-uuid", productName: "Visible Product", variantTitle: "Blue", sku: internalSku, quantity: 1, unitPrice: 25, lineTotal: 25, nextTier: null, priceChanged: false, available: 4, availability: "available", taxIncluded: 0, vatRate: 0 }], totals: { subtotal: 25, discountTotal: 0, shippingTotal: 0, taxTotal: 0, grandTotal: 25 }, hasUnavailableItems: false, hasPriceChanges: false } };
      throw new Error(`Unexpected metadata test request: ${path}`);
    });

    const shop = render(<MemoryRouter><ShopPage /></MemoryRouter>);
    await screen.findByText("Visible Product");
    expect(screen.getByText("Blue")).toBeTruthy();
    expect(screen.queryByText(internalSku)).toBeNull();
    expect(shop.container.textContent).not.toContain("internal-product-uuid");
    shop.unmount();

    const cart = render(<MemoryRouter><CartPage /></MemoryRouter>);
    await screen.findByText("Visible Product · Blue");
    expect(screen.queryByText(internalSku)).toBeNull();
    expect(cart.container.textContent).not.toContain("internal-cart-item-uuid");
    expect(cart.container.textContent).not.toContain("internal-variant-uuid");
  });

  it("never falls back to a database order ID for a customer-visible title", () => {
    expect(customerOrderTitle(undefined)).toBe("Order details");
    expect(customerOrderTitle("", "Order record")).toBe("Order record");
    expect(customerOrderTitle("LZ-2026-1001")).toBe("LZ-2026-1001");
  });

  it("formats VAT total labels from authoritative item rates", () => {
    expect(vatTotalLabel([{ vatRate: 19 }])).toBe("VAT included (19%)");
    expect(vatTotalLabel([{ taxRate: 5 }, { taxRate: 19 }, { taxRate: 19 }])).toBe("VAT included (5% / 19%)");
    expect(vatTotalLabel([])).toBe("VAT included");
  });

  it.each([
    ["authenticated", true],
    ["guest", false],
  ] as const)("keeps %s checkout in Details → Shipping → Pay for one order and one active payment", async (_kind, authenticated) => {
    if (authenticated) {
      mocks.authUser = {
        email: "buyer@example.com",
        phone: null,
        accountType: "personal",
        firstName: "Ada",
        lastName: "Buyer",
      };
    }
    const orderApiPath = authenticated ? "/account/orders/order-1" : "/guest/orders/order-1";
    const paymentBase = authenticated ? "/account/orders/order-1/payments" : "/guest/orders/order-1/payments";
    const guestToken = authenticated ? undefined : "guest-checkout-token";
    const checkoutOrder = { ...order, subtotal: 25, discountTotal: 5, shippingTotal: 3, taxTotal: 3, grandTotal: 23 };
    let backendPaid = false;
    const cart = {
      id: "cart-1",
      currency: "EUR",
      items: [{ id: "item-1", vatRate: 19 }],
      totals: { subtotal: 25, discountTotal: 0, shippingTotal: 0, taxTotal: 0, grandTotal: 25 },
      hasUnavailableItems: false,
      hasPriceChanges: false,
    };
    mocks.apiRequest.mockImplementation(async (path: string, init: RequestInit = {}) => {
      if (path === "/cart") return { data: cart };
      if (path === "/checkout/validate" && init.method === "POST") {
        const request = JSON.parse(String(init.body));
        expect(request.shippingAddress.countryCode).toBe("CY");
        expect(request.expectedGrandTotal).toBeUndefined();
        return { data: { valid: true, priceChanged: false, subtotal: 25, discountTotal: 5, shippingTotal: 3, taxTotal: 3, grandTotal: 23 } };
      }
      if (path === "/checkout/order" && init.method === "POST") {
        const request = JSON.parse(String(init.body));
        expect(request.expectedGrandTotal).toBe(23);
        return { data: { order: checkoutOrder, guestAccessToken: guestToken, replayed: false } };
      }
      if (path === orderApiPath) {
        if (guestToken) expect((init.headers as Record<string, string> | undefined)?.["x-order-access-token"]).toBe(guestToken);
        return { data: backendPaid ? { ...checkoutOrder, status: "confirmed", paymentStatus: "paid" } : checkoutOrder };
      }
      if (path === "/payments/config") return { data: config };
      if (path === paymentBase && init.method === "POST") {
        if (guestToken) expect((init.headers as Record<string, string> | undefined)?.["x-order-access-token"]).toBe(guestToken);
        return { data: { payment: payment("pending"), clientSecret: "pi_mock_secret" } };
      }
      if (path === paymentBase) {
        if (guestToken) expect((init.headers as Record<string, string> | undefined)?.["x-order-access-token"]).toBe(guestToken);
        return { data: [] };
      }
      throw new Error(`Unexpected checkout flow request: ${init.method ?? "GET"} ${path}`);
    });

    render(
      <MemoryRouter initialEntries={["/checkout"]}>
        <Routes>
          <Route path="/checkout" element={<CheckoutPage />} />
          <Route path="*" element={<div>Unexpected order-history redirect</div>} />
        </Routes>
      </MemoryRouter>,
    );

    await screen.findByText("Complete your order");
    if (!authenticated) fireEvent.change(screen.getByLabelText("Email"), { target: { value: "guest@example.com" } });
    fireEvent.change(screen.getByLabelText("First name"), { target: { value: "Ada" } });
    fireEvent.change(screen.getByLabelText("Last name"), { target: { value: "Buyer" } });
    fireEvent.change(screen.getByLabelText("Address line"), { target: { value: "1 Market Street" } });
    fireEvent.change(screen.getByLabelText("City"), { target: { value: "Nicosia" } });
    fireEvent.change(screen.getByLabelText("Postal code"), { target: { value: "1010" } });
    fireEvent.click(screen.getByRole("button", { name: /Continue to shipping/ }));
    await screen.findByText("Where should we deliver?");
    expect(mocks.apiRequest.mock.calls.filter(([path]) => path === "/checkout/order")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Check delivery options" }));
    const delivery = await screen.findByRole("radio", { name: /Standard delivery/ });
    expect(screen.getAllByText("€3.00").length).toBeGreaterThan(0);
    expect(screen.getAllByText("€23.00").length).toBeGreaterThan(0);
    expect(screen.getByText("VAT included (19%)")).toBeTruthy();
    expect(mocks.apiRequest.mock.calls.filter(([path]) => path === "/checkout/order")).toHaveLength(0);
    fireEvent.click(delivery);
    fireEvent.click(screen.getByRole("button", { name: /Continue to payment/ }));

    await screen.findByText("03 / Pay");
    expect(screen.queryByText("Unexpected order-history redirect")).toBeNull();
    expect(mocks.apiRequest.mock.calls.filter(([path, init]) => path === "/checkout/order" && init?.method === "POST")).toHaveLength(1);
    if (guestToken) expect(readGuestOrderAccess("order-1")).toBe(guestToken);
    await screen.findByTestId("payment-element");
    expect(document.querySelector("form form")).toBeNull();
    expect(mocks.apiRequest.mock.calls.filter(([path, init]) => path === paymentBase && init?.method === "POST")).toHaveLength(1);
    expect(mocks.apiRequest.mock.calls.filter(([path, init]) => path === "/checkout/order" && init?.method === "POST")).toHaveLength(1);
    backendPaid = true;
    fireEvent.click(screen.getByRole("button", { name: "Refresh payment status" }));
    await screen.findByText("Thank you. Your order is confirmed.");
    expect(screen.getByText("LZ-MOCK-1")).toBeTruthy();
  });

  it("restores the same guest Pay step after a 3DS return and resumes the active payment", async () => {
    const guestToken = "guest-checkout-token";
    writeCheckoutRecoveryContext("order-1", guestToken);
    window.history.replaceState(null, "", "/checkout?payment_return=1&payment_intent=pi_mock&redirect_status=requires_action");
    let paymentReads = 0;
    mocks.apiRequest.mockImplementation(async (path: string, init: RequestInit = {}) => {
      if (path === "/cart") return { data: { id: "empty-cart", currency: "EUR", items: [], totals: { subtotal: 0, discountTotal: 0, shippingTotal: 0, taxTotal: 0, grandTotal: 0 }, hasUnavailableItems: false, hasPriceChanges: false } };
      if (path === "/guest/orders/order-1") {
        expect((init.headers as Record<string, string> | undefined)?.["x-order-access-token"]).toBe(guestToken);
        return { data: { ...order, subtotal: 25, discountTotal: 0, shippingTotal: 0, taxTotal: 0 } };
      }
      if (path === "/payments/config") return { data: config };
      if (path === "/guest/orders/order-1/payments" && init.method === "POST") {
        expect((init.headers as Record<string, string> | undefined)?.["x-order-access-token"]).toBe(guestToken);
        return { data: { payment: payment("requires_action"), clientSecret: "pi_mock_secret" } };
      }
      if (path === "/guest/orders/order-1/payments") {
        expect((init.headers as Record<string, string> | undefined)?.["x-order-access-token"]).toBe(guestToken);
        paymentReads += 1;
        return { data: [payment(paymentReads > 1 ? "requires_action" : "processing")] };
      }
      throw new Error(`Unexpected restored checkout request: ${init.method ?? "GET"} ${path}`);
    });

    render(<MemoryRouter initialEntries={["/checkout?payment_return=1&payment_intent=pi_mock&redirect_status=requires_action"]}><Routes><Route path="/checkout" element={<CheckoutPage />} /></Routes></MemoryRouter>);

    await screen.findByText("03 / Pay");
    await waitFor(() => expect(window.location.search).toBe(""));
    expect(await screen.findByTestId("payment-element")).toBeTruthy();
    expect(screen.getByText("Your payment needs another confirmation step.")).toBeTruthy();
    expect(mocks.apiRequest.mock.calls.filter(([path, init]) => path === "/checkout/order" && init?.method === "POST")).toHaveLength(0);
    expect(mocks.apiRequest.mock.calls.filter(([path, init]) => path === "/guest/orders/order-1/payments" && init?.method === "POST")).toHaveLength(1);
    expect(sessionStorage.getItem(browserStorageKeys.checkoutContext)).toContain("order-1");
  });

  it("clears stale account recovery when the authenticated owner cannot access that order", async () => {
    writeCheckoutRecoveryContext("order-1", "");
    window.history.replaceState(null, "", "/checkout");
    mocks.authUser = { email: "other@example.test", phone: null, accountType: "personal", firstName: "Other", lastName: "User" };
    mocks.apiRequest.mockImplementation(async (path: string) => {
      if (path === "/cart") return { data: { id: "empty-cart", currency: "EUR", items: [], totals: { subtotal: 0, discountTotal: 0, shippingTotal: 0, taxTotal: 0, grandTotal: 0 }, hasUnavailableItems: false, hasPriceChanges: false } };
      if (path === "/account/orders/order-1") throw new Error("Order not found");
      throw new Error(`Unexpected stale account request: ${path}`);
    });
    render(<MemoryRouter><CheckoutPage /></MemoryRouter>);
    await waitFor(() => expect(readCheckoutRecoveryContext()).toBeNull());
    expect(screen.queryByText("03 / Pay")).toBeNull();
  });

  it("retains checkout recovery for a cancelled payment on an otherwise pending order", async () => {
    const guestToken = "guest-retry-token";
    writeCheckoutRecoveryContext("order-1", guestToken);
    mocks.apiRequest.mockImplementation(async (path: string, init: RequestInit = {}) => {
      if (path === "/cart") return { data: { id: "empty-cart", currency: "EUR", items: [], totals: { subtotal: 0, discountTotal: 0, shippingTotal: 0, taxTotal: 0, grandTotal: 0 }, hasUnavailableItems: false, hasPriceChanges: false } };
      if (path === "/guest/orders/order-1") return { data: { ...order, status: "pending", paymentStatus: "cancelled" } };
      if (path === "/payments/config") return { data: config };
      if (path === "/guest/orders/order-1/payments" && init.method === "POST") return { data: { payment: payment("requires_action"), clientSecret: "pi_retry_secret" } };
      if (path === "/guest/orders/order-1/payments") return { data: [payment("cancelled")] };
      throw new Error(`Unexpected cancelled retry request: ${init.method ?? "GET"} ${path}`);
    });
    render(<MemoryRouter><CheckoutPage /></MemoryRouter>);
    await screen.findByText("03 / Pay");
    expect(readCheckoutRecoveryContext()?.orderId).toBe("order-1");
    fireEvent.click(await screen.findByRole("button", { name: "Continue payment" }));
    expect(await screen.findByTestId("payment-element")).toBeTruthy();
  });
});