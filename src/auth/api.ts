function readCookie(name: string): string | undefined {
  return document.cookie
    .split("; ")
    .find((cookie) => cookie.startsWith(`${name}=`))
    ?.split("=")
    .slice(1)
    .join("=");
}

export class ApiError extends Error {
  constructor(public readonly code: string | undefined, message: string, public readonly details?: unknown) {
    super(message);
    this.name = "ApiError";
  }
}

export async function apiRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const method = init.method?.toUpperCase() ?? "GET";
  const headers = new Headers(init.headers);
  if (init.body && !(init.body instanceof FormData)) headers.set("content-type", "application/json");
  if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
    let csrfToken = readCookie("lizzor_csrf");
    if (!csrfToken) {
      await fetch("/api/v1/auth/me", { credentials: "include" });
      csrfToken = readCookie("lizzor_csrf");
    }
    if (csrfToken) headers.set("x-csrf-token", decodeURIComponent(csrfToken));
  }
  const response = await fetch(`/api/v1${path}`, { ...init, headers, credentials: "include" });
  const payload = response.status === 204 ? undefined : await response.json();
  if (!response.ok) {
    throw new ApiError(payload?.error?.code, payload?.error?.message ?? "The request could not be completed.", payload?.error?.details);
  }
  return payload as T;
}