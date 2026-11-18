import { createHmac, randomBytes } from "node:crypto";
import { z } from "zod";
import { env } from "../config/env.js";

/** The only wire format used by the Toonies integration. */
export type TooniesEnvelope<T> = {
  status: boolean;
  code: number;
  msg: string;
  data: T;
};

export type TooniesRequestHeaders = {
  "X-App-Key": string;
  "X-Timestamp": string;
  "X-Nonce": string;
  "X-Signature": string;
  "content-type": "application/json";
};

export type TooniesTransportResponse = {
  /** Toonies documents HTTP 200 for both successful and failed envelopes. */
  httpStatus?: number;
  envelope: TooniesEnvelope<unknown>;
};

export type TooniesTransport = (request: {
  path: string;
  body: Buffer;
  headers: TooniesRequestHeaders;
  signal: AbortSignal;
}) => Promise<TooniesTransportResponse>;

export const TOONIES_BASE_URL = "https://openplatform.toonies.com";
const APPROVAL_COOLDOWN_MS = 5 * 60 * 1000;
const RATE_LIMIT_COOLDOWN_MS = 60 * 1000;
const DETAIL_MIN_INTERVAL_MS = 1_250;
const DETAIL_CACHE_MS = 30 * 60 * 1000;
const MAX_RETRIES = 2;
const MAX_RESPONSE_BYTES = 1_000_000;

const errorMessages: Record<number, string> = {
  40001: "Toonies rejected the request parameters.",
  40003: "Toonies rejected the request signature.",
  40004: "The Toonies request timestamp is invalid.",
  40005: "The Toonies request nonce was already used.",
  40006: "Toonies API access is pending approval.",
  40010: "The Toonies product or SKU is invalid.",
  40011: "The Toonies SKU is unavailable or does not match the product.",
  40020: "The Toonies balance is insufficient.",
  40021: "The Toonies stock is insufficient.",
  40022: "The Toonies minimum order quantity was not met.",
  40030: "The destination country is not supported by Toonies.",
  40031: "The Toonies API order task number has already been used.",
  40040: "The Toonies order precheck is not ready.",
  40041: "The Toonies order snapshot has expired.",
  40042: "Toonies returned no orderable items.",
  42901: "The Toonies API rate limit was reached.",
  50001: "Toonies returned a server error.",
};

export class TooniesError extends Error {
  readonly code: number;
  readonly retryable: boolean;
  readonly approvalPending: boolean;

  constructor(code: number, message?: string) {
    super(message || errorMessages[code] || "The Toonies API request failed.");
    this.name = "TooniesError";
    this.code = code;
    this.retryable = code === 50001;
    this.approvalPending = code === 40006;
  }
}

export function generateTooniesNonce(): string {
  // 16 bytes -> 32 ASCII hex characters, within the documented limit.
  return randomBytes(16).toString("hex");
}

function requestBytes(body: string | Buffer | Uint8Array): Buffer {
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body);
  return Buffer.from(body, "utf8");
}

/**
 * Signs the exact bytes sent on the wire. Callers passing JSON should
 * serialize it once and pass that same string to both this function and the
 * transport; re-stringifying here would permit whitespace/key-order drift.
 */
export function signTooniesRequest(input: {
  appKey: string;
  appSecret: string;
  path: string;
  timestamp: number;
  nonce: string;
  body: string | Buffer | Uint8Array;
}): TooniesRequestHeaders {
  if (!input.appKey) throw new Error("Toonies app key is required.");
  if (!input.appSecret) throw new Error("Toonies app secret is required.");
  if (!/^\/v1\/[a-z0-9/_-]+$/i.test(input.path) || input.path.endsWith("/") || input.path.includes("?")) {
    throw new Error("Toonies path must be a versioned path without a query or trailing slash.");
  }
  if (!Number.isSafeInteger(input.timestamp) || input.timestamp < 0) throw new Error("Toonies timestamp must be unix seconds.");
  if (!/^[\x21-\x7e]{1,32}$/.test(input.nonce)) throw new Error("Toonies nonce must be 1-32 visible ASCII characters.");
  const body = requestBytes(input.body);
  const stringToSign = Buffer.concat([
    Buffer.from(`POST&${input.path}&${input.timestamp}&${input.nonce}&`, "utf8"),
    body,
  ]);
  const signature = createHmac("sha256", input.appSecret).update(stringToSign).digest("hex").toUpperCase();
  return {
    "X-App-Key": input.appKey,
    "X-Timestamp": String(input.timestamp),
    "X-Nonce": input.nonce,
    "X-Signature": signature,
    "content-type": "application/json",
  };
}

function stripHtml(value: string): string {
  return value.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
}

const searchInput = z.object({
  keyword: z.string().transform(stripHtml).pipe(z.string().min(1).max(100)),
  page: z.number().int().min(1).optional(),
  page_size: z.number().int().min(1).max(50).optional(),
  cursor: z.string().min(1).max(512).optional(),
  sort_field: z.enum(["price", "monthSold", "rePurchaseRate"]).optional(),
  sort_order: z.enum(["asc", "desc"]).optional(),
  category_id: z.string().min(1).max(255).optional(),
  price_start: z.number().finite().min(0).optional(),
  price_end: z.number().finite().min(0).optional(),
}).strict().refine((value) => value.price_start === undefined || value.price_end === undefined || value.price_end >= value.price_start, { message: "price_end must be greater than or equal to price_start." });

const detailInput = z.object({ product_code: z.string().min(1).max(64) }).strict();
const precheckInput = z.object({
  client_task_no: z.string().regex(/^[A-Za-z0-9_-]+$/).max(64),
  items: z.array(z.object({
    product_code: z.string().min(1).max(64),
    sku_code: z.string().min(1).max(128),
    num: z.number().int().positive(),
  }).strict()).min(1).max(200),
}).strict();
const taskInput = z.object({ task_id: z.string().min(1).max(32) }).strict();
const createInput = z.object({
  task_id: z.string().min(1).max(32),
  api_order_sn: z.string().regex(/^[A-Za-z0-9_-]+$/).min(1).max(64),
  consignee: z.string().min(1).max(200),
  phone: z.string().min(1).max(64),
  country_code: z.string().min(2).max(3),
  province: z.string().max(100),
  city: z.string().max(100),
  address: z.string().min(1).max(500),
  postcode: z.string().max(30),
  email: z.string().email().max(320),
}).strict();
const getInput = z.object({ order_sn: z.string().min(1).max(128) }).strict();
const listInput = z.object({
  status: z.string().max(32).optional(),
  order_source: z.string().max(64).optional(),
  date_start: z.number().int().optional(),
  date_end: z.number().int().optional(),
  page: z.number().int().min(1).optional(),
  page_size: z.number().int().min(1).max(50).optional(),
}).strict();
const balanceInput = z.object({}).strict();

export type TooniesClientOptions = {
  app_key?: string;
  app_secret?: string;
  appKey?: string;
  appSecret?: string;
  transport?: TooniesTransport;
  now?: () => number;
  nonce?: () => string;
  timeoutMs?: number;
  approvalCooldownMs?: number;
  rateLimitCooldownMs?: number;
  detailIntervalMs?: number;
};

function jsonBody(input: unknown): Buffer {
  return Buffer.from(JSON.stringify(input), "utf8");
}

async function fetchTransport(request: {
  path: string;
  body: Buffer;
  headers: TooniesRequestHeaders;
  signal: AbortSignal;
}): Promise<TooniesTransportResponse> {
  if (env.NODE_ENV !== "production") {
    throw new Error(`Live Toonies transport is disabled in ${env.NODE_ENV}; inject an explicit fixture transport.`);
  }
  const response = await fetch(`${TOONIES_BASE_URL}${request.path}`, {
    method: "POST",
    headers: request.headers,
    body: request.body as unknown as BodyInit,
    signal: request.signal,
  });
  const declaredLength = Number(response.headers.get("content-length") ?? 0);
  if (declaredLength > MAX_RESPONSE_BYTES) throw new TooniesError(50001, "Toonies response exceeded the maximum size.");
  let envelope: unknown;
  try {
    const reader = response.body?.getReader();
    if (!reader) throw new TooniesError(50001, "Toonies returned an empty response.");
    const chunks: Buffer[] = [];
    let total = 0;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new TooniesError(50001, "Toonies response exceeded the maximum size.");
      }
      chunks.push(Buffer.from(chunk.value));
    }
    const bytes = Buffer.concat(chunks, total);
    envelope = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    if (error instanceof TooniesError) throw error;
    throw new TooniesError(50001, "Toonies returned an invalid response envelope.");
  }
  const parsed = z.object({
    status: z.boolean(),
    code: z.number(),
    msg: z.string(),
    data: z.unknown(),
  }).safeParse(envelope);
  if (!parsed.success) throw new TooniesError(50001, "Toonies returned an invalid response envelope.");
  return { httpStatus: response.status, envelope: parsed.data };
}

type CacheEntry = { expiresAt: number; value: unknown };

/**
 * Injectable Toonies client. Financial create is exposed for the durable
 * settlement service only; callers must not use it as a generic retrying API.
 */
export class TooniesClient {
  private readonly appKey: string;
  private readonly appSecret: string;
  private readonly transport: TooniesTransport;
  private readonly now: () => number;
  private readonly nonce: () => string;
  private readonly timeoutMs: number;
  private readonly approvalCooldownMs: number;
  private readonly rateLimitCooldownMs: number;
  private readonly detailIntervalMs: number;
  private approvalUntil = 0;
  private rateLimitedUntil = 0;
  private readonly detailCache = new Map<string, CacheEntry>();
  private detailNextAt = 0;
  private detailGate: Promise<void> = Promise.resolve();

  constructor(options: TooniesClientOptions = {}) {
    this.appKey = options.app_key ?? env.app_key ?? options.appKey ?? env.TOONIES_APP_KEY ?? "";
    this.appSecret = options.app_secret ?? env.app_secret ?? options.appSecret ?? env.TOONIES_APP_SECRET ?? "";
    this.transport = options.transport ?? fetchTransport;
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
    this.nonce = options.nonce ?? generateTooniesNonce;
    this.timeoutMs = Math.max(100, Math.min(options.timeoutMs ?? 10_000, 60_000));
    this.approvalCooldownMs = Math.max(1_000, options.approvalCooldownMs ?? APPROVAL_COOLDOWN_MS);
    this.rateLimitCooldownMs = Math.max(1_000, Math.min(options.rateLimitCooldownMs ?? RATE_LIMIT_COOLDOWN_MS, 5 * 60 * 1000));
    this.detailIntervalMs = Math.max(1_250, options.detailIntervalMs ?? DETAIL_MIN_INTERVAL_MS);
  }

  get approvalPending(): boolean {
    return Date.now() < this.approvalUntil;
  }

  private async call(path: string, payload: unknown, retry = true): Promise<unknown> {
    if (this.approvalPending) throw new TooniesError(40006);
    if (Date.now() < this.rateLimitedUntil) throw new TooniesError(42901);
    const body = jsonBody(payload);
    let attempt = 0;
    while (true) {
      const timestamp = this.now();
      const headers = signTooniesRequest({
        appKey: this.appKey,
        appSecret: this.appSecret,
        path,
        timestamp,
        nonce: this.nonce(),
        body,
      });
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const result = await this.transport({ path, body, headers, signal: controller.signal });
        const envelope = result.envelope;
        if (envelope.code === 40006) {
          this.approvalUntil = Date.now() + this.approvalCooldownMs;
          throw new TooniesError(40006, envelope.msg);
        }
        if (envelope.code === 42901) {
          this.rateLimitedUntil = Date.now() + this.rateLimitCooldownMs;
          throw new TooniesError(42901);
        }
        // The official success envelope is status=true, code=200.
        if (envelope.status && envelope.code === 200) return envelope.data;
        const error = new TooniesError(envelope.code, envelope.msg);
        if (!retry || !error.retryable || attempt >= MAX_RETRIES) throw error;
        attempt += 1;
      } catch (error) {
        if (error instanceof TooniesError) {
          if (!retry || !error.retryable || attempt >= MAX_RETRIES) throw error;
          attempt += 1;
        } else if (!retry || attempt >= MAX_RETRIES) {
          throw new TooniesError(50001, "The Toonies request timed out or could not be completed.");
        } else {
          attempt += 1;
        }
      } finally {
        clearTimeout(timeout);
      }
    }
  }

  async search(input: z.input<typeof searchInput>): Promise<unknown> {
    const parsed = searchInput.parse(input);
    return this.call("/v1/product/search", {
      ...parsed,
      page: parsed.page ?? 1,
      page_size: parsed.page_size ?? 20,
    });
  }

  async detail(input: z.input<typeof detailInput>): Promise<unknown> {
    const parsed = detailInput.parse(input);
    const key = parsed.product_code;
    const existing = this.detailCache.get(key);
    if (existing && existing.expiresAt > Date.now()) return existing.value;
    const turn = this.detailGate.then(async () => {
      const wait = this.detailNextAt - Date.now();
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      this.detailNextAt = Date.now() + this.detailIntervalMs;
    });
    this.detailGate = turn.catch(() => undefined);
    await turn;
    const value = await this.call("/v1/product/detail", parsed);
    this.detailCache.set(key, { value, expiresAt: Date.now() + DETAIL_CACHE_MS });
    return value;
  }

  async precheck(input: z.input<typeof precheckInput>): Promise<unknown> {
    return this.call("/v1/order/precheck", precheckInput.parse(input));
  }

  async task(input: z.input<typeof taskInput>): Promise<unknown> {
    return this.call("/v1/order/task", taskInput.parse(input));
  }

  async create(input: z.input<typeof createInput>): Promise<unknown> {
    // Financial create is always driven by the durable settlement journal.
    // Never apply the ordinary client retry loop to this endpoint.
    return this.call("/v1/order/create", createInput.parse(input), false);
  }

  async getOrder(input: z.input<typeof getInput>): Promise<unknown> {
    return this.call("/v1/order/get", getInput.parse(input));
  }

  async get(input: z.input<typeof getInput>): Promise<unknown> {
    return this.getOrder(input);
  }

  async listOrders(input: z.input<typeof listInput> = {}): Promise<unknown> {
    return this.call("/v1/order/list", listInput.parse(input));
  }

  async list(input: z.input<typeof listInput> = {}): Promise<unknown> {
    return this.listOrders(input);
  }

  async balance(): Promise<unknown> {
    return this.call("/v1/user/balance", balanceInput.parse({}));
  }
}

export type TooniesFixture = Record<string, TooniesEnvelope<unknown> | TooniesEnvelope<unknown>[]>;

/**
 * Deterministic, in-memory transport for unit tests. It validates no network
 * and records raw bodies/headers without ever retaining the app secret.
 */
export class TooniesFixtureTransport {
  readonly requests: Array<{ path: string; body: Buffer; headers: TooniesRequestHeaders }> = [];
  private readonly fixtures: TooniesFixture;
  private readonly calls = new Map<string, number>();

  constructor(fixtures: TooniesFixture) {
    this.fixtures = fixtures;
  }

  readonly request: TooniesTransport = async ({ path, body, headers }) => {
    this.requests.push({ path, body: Buffer.from(body), headers: { ...headers } });
    const fixture = this.fixtures[path];
    if (!fixture) {
      return { envelope: { status: false, code: 50001, msg: "Fixture not found.", data: null } };
    }
    if (Array.isArray(fixture)) {
      const index = this.calls.get(path) ?? 0;
      this.calls.set(path, index + 1);
      return { envelope: fixture[Math.min(index, fixture.length - 1)]! };
    }
    return { envelope: fixture };
  };
}

/** Safe operational status for admin UI; never includes credentials. */
export function tooniesAccessStatus(client: TooniesClient): { approvalPending: boolean } {
  return { approvalPending: client.approvalPending };
}