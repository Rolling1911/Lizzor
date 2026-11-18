const CHECKOUT_CONTEXT_KEY = "lizzor.checkout-payment-context.v2";
const LEGACY_CHECKOUT_CONTEXT_KEY = "lizzor:checkout-payment-context";
const GUEST_ORDER_PREFIX = "lizzor.guest-order.v1:";
const LEGACY_GUEST_ORDER_PREFIX = "lizzor:guest-order:";
const RECOVERY_TTL_MS = 24 * 60 * 60 * 1000;

export type CheckoutRecoveryContext = {
  version: 2;
  orderId: string;
  guestToken: string;
  owner: "guest" | "account";
  expiresAt: number;
};

function usableId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128 && !/[/?#]/.test(value);
}

function usableToken(value: unknown): value is string {
  return typeof value === "string" && value.length <= 256;
}

export function safeLocalStorageGet(key: string): string | null {
  try { return window.localStorage.getItem(key); } catch { return null; }
}

export function safeLocalStorageSet(key: string, value: string): boolean {
  try { window.localStorage.setItem(key, value); return true; } catch { return false; }
}

export function safeLocalStorageRemove(key: string): void {
  try { window.localStorage.removeItem(key); } catch { /* Storage may be blocked. */ }
}

function safeSessionGet(key: string): string | null {
  try { return window.sessionStorage.getItem(key); } catch { return null; }
}

function safeSessionSet(key: string, value: string): boolean {
  try { window.sessionStorage.setItem(key, value); return true; } catch { return false; }
}

function safeSessionRemove(key: string): void {
  try { window.sessionStorage.removeItem(key); } catch { /* Storage may be blocked. */ }
}

export function writeCheckoutRecoveryContext(orderId: string, guestToken = ""): boolean {
  if (!usableId(orderId) || !usableToken(guestToken)) return false;
  const value: CheckoutRecoveryContext = {
    version: 2,
    orderId,
    guestToken,
    owner: guestToken ? "guest" : "account",
    expiresAt: Date.now() + RECOVERY_TTL_MS,
  };
  return safeSessionSet(CHECKOUT_CONTEXT_KEY, JSON.stringify(value));
}

export function readCheckoutRecoveryContext(): CheckoutRecoveryContext | null {
  const raw = safeSessionGet(CHECKOUT_CONTEXT_KEY);
  if (raw) {
    try {
      const value = JSON.parse(raw) as Partial<CheckoutRecoveryContext>;
      if (
        value.version === 2
        && usableId(value.orderId)
        && usableToken(value.guestToken)
        && value.owner === (value.guestToken ? "guest" : "account")
        && typeof value.expiresAt === "number"
        && value.expiresAt > Date.now()
      ) return value as CheckoutRecoveryContext;
    } catch { /* Invalid records are removed below. */ }
    safeSessionRemove(CHECKOUT_CONTEXT_KEY);
    return null;
  }
  const legacy = safeSessionGet(LEGACY_CHECKOUT_CONTEXT_KEY);
  if (!legacy) return null;
  safeSessionRemove(LEGACY_CHECKOUT_CONTEXT_KEY);
  return null;
}

export function clearCheckoutRecoveryContext(): void {
  safeSessionRemove(CHECKOUT_CONTEXT_KEY);
  safeSessionRemove(LEGACY_CHECKOUT_CONTEXT_KEY);
}

export function writeGuestOrderAccess(orderId: string, token: string): boolean {
  if (!usableId(orderId) || !token || !usableToken(token)) return false;
  return safeSessionSet(`${GUEST_ORDER_PREFIX}${orderId}`, JSON.stringify({ version: 1, token, expiresAt: Date.now() + RECOVERY_TTL_MS }));
}

export function readGuestOrderAccess(orderId: string): string | null {
  if (!usableId(orderId)) return null;
  const key = `${GUEST_ORDER_PREFIX}${orderId}`;
  const raw = safeSessionGet(key);
  if (raw) {
    try {
      const value = JSON.parse(raw) as { version?: unknown; token?: unknown; expiresAt?: unknown };
      if (value.version === 1 && usableToken(value.token) && value.token && typeof value.expiresAt === "number" && value.expiresAt > Date.now()) return value.token;
    } catch { /* Invalid records are removed below. */ }
    safeSessionRemove(key);
    return null;
  }
  const legacyKey = `${LEGACY_GUEST_ORDER_PREFIX}${orderId}`;
  const legacy = safeSessionGet(legacyKey);
  safeSessionRemove(legacyKey);
  return null;
}

export function clearGuestOrderAccess(orderId: string): void {
  safeSessionRemove(`${GUEST_ORDER_PREFIX}${orderId}`);
  safeSessionRemove(`${LEGACY_GUEST_ORDER_PREFIX}${orderId}`);
}

export function clearCheckoutStorageOnLogout(): void {
  clearCheckoutRecoveryContext();
  try {
    for (let index = window.sessionStorage.length - 1; index >= 0; index -= 1) {
      const key = window.sessionStorage.key(index);
      if (key?.startsWith(GUEST_ORDER_PREFIX) || key?.startsWith(LEGACY_GUEST_ORDER_PREFIX)) window.sessionStorage.removeItem(key);
    }
  } catch { /* Logout must still complete when storage is blocked. */ }
}

export const browserStorageKeys = {
  checkoutContext: CHECKOUT_CONTEXT_KEY,
  guestOrderPrefix: GUEST_ORDER_PREFIX,
  recoveryTtlMs: RECOVERY_TTL_MS,
} as const;