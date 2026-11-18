// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  browserStorageKeys,
  clearCheckoutStorageOnLogout,
  readCheckoutRecoveryContext,
  readGuestOrderAccess,
  safeLocalStorageGet,
  safeLocalStorageSet,
  writeCheckoutRecoveryContext,
  writeGuestOrderAccess,
} from "./browserStorage";

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  vi.restoreAllMocks();
});
afterEach(() => vi.restoreAllMocks());

describe("browser storage safety", () => {
  it("writes namespaced, versioned, expiring checkout and guest-order records", () => {
    expect(writeCheckoutRecoveryContext("order-1", "guest-token")).toBe(true);
    expect(readCheckoutRecoveryContext()).toMatchObject({ version: 2, orderId: "order-1", guestToken: "guest-token", owner: "guest" });
    expect(sessionStorage.getItem(browserStorageKeys.checkoutContext)).toContain('"expiresAt"');
    expect(writeGuestOrderAccess("order-1", "guest-token")).toBe(true);
    expect(readGuestOrderAccess("order-1")).toBe("guest-token");
  });

  it("discards unknown-age legacy records and removes invalid or expired records", () => {
    sessionStorage.setItem("lizzor:checkout-payment-context", JSON.stringify({ orderId: "order-1", guestToken: "" }));
    sessionStorage.setItem("lizzor:guest-order:order-1", "legacy-token");
    expect(readCheckoutRecoveryContext()).toBeNull();
    expect(readGuestOrderAccess("order-1")).toBeNull();
    expect(sessionStorage.getItem("lizzor:checkout-payment-context")).toBeNull();
    expect(sessionStorage.getItem("lizzor:guest-order:order-1")).toBeNull();
    sessionStorage.setItem(browserStorageKeys.checkoutContext, JSON.stringify({ version: 2, orderId: "order-2", guestToken: "", owner: "account", expiresAt: Date.now() - 1 }));
    expect(readCheckoutRecoveryContext()).toBeNull();
    expect(sessionStorage.getItem(browserStorageKeys.checkoutContext)).toBeNull();
    sessionStorage.setItem(`${browserStorageKeys.guestOrderPrefix}order-1`, "{broken");
    expect(readGuestOrderAccess("order-1")).toBeNull();
  });

  it("fails safely when Safari/private browsing blocks Web Storage", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new DOMException("Blocked", "SecurityError"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new DOMException("Quota", "QuotaExceededError"); });
    expect(safeLocalStorageGet("test")).toBeNull();
    expect(safeLocalStorageSet("test", "value")).toBe(false);
    expect(readCheckoutRecoveryContext()).toBeNull();
    expect(writeCheckoutRecoveryContext("order-1", "guest-token")).toBe(false);
  });

  it("clears all checkout and guest recovery state on logout", () => {
    writeCheckoutRecoveryContext("order-1", "");
    writeGuestOrderAccess("order-1", "guest-token");
    clearCheckoutStorageOnLogout();
    expect(readCheckoutRecoveryContext()).toBeNull();
    expect(readGuestOrderAccess("order-1")).toBeNull();
  });
});