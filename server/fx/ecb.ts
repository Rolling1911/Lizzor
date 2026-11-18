import { createHash } from "node:crypto";
import { FxProviderError, type FxObservation, type FxProvider } from "./provider.js";

export const ECB_CNY_EUR_SERIES = "EXR.D.CNY.EUR.SP00.A";
export const ECB_CNY_EUR_URL = "https://data-api.ecb.europa.eu/service/data/EXR/D.CNY.EUR.SP00.A?format=csvdata&lastNObservations=5";
const MAX_RESPONSE_BYTES = 1_000_000;

export type FxHttpResponse = {
  status: number;
  headers?: Headers;
  body: AsyncIterable<Uint8Array> | ReadableStream<Uint8Array> | string | Buffer | Uint8Array;
};

export type FxHttpTransport = (request: {
  url: string;
  headers: Record<string, string>;
  signal: AbortSignal;
}) => Promise<FxHttpResponse>;

export type EcbProviderOptions = {
  transport?: FxHttpTransport;
  now?: () => Date;
  delay?: (milliseconds: number) => Promise<void>;
  timeoutMs?: number;
  maxRetries?: number;
  userAgent?: string;
};

function parseCsv(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let closedQuote = false;
  for (let i = 0; i < input.length; i += 1) {
    const character = input[i]!;
    if (quoted) {
      if (character === '"') {
        if (input[i + 1] === '"') { field += '"'; i += 1; } else { quoted = false; closedQuote = true; }
      } else field += character;
    } else if (closedQuote) {
      if (character === ",") { row.push(field); field = ""; closedQuote = false; }
      else if (character === "\n" || character === "\r") {
        if (character === "\r" && input[i + 1] === "\n") i += 1;
        row.push(field); field = ""; closedQuote = false;
        if (row.some((value) => value.length > 0)) rows.push(row);
        row = [];
      } else throw new FxProviderError("FX_CSV_INVALID", "ECB returned malformed CSV.");
    } else if (character === '"') {
      if (field.length !== 0) throw new FxProviderError("FX_CSV_INVALID", "ECB returned malformed CSV.");
      quoted = true;
    } else if (character === ",") {
      row.push(field); field = "";
    } else if (character === "\n" || character === "\r") {
      if (character === "\r" && input[i + 1] === "\n") i += 1;
      row.push(field); field = "";
      if (row.some((value) => value.length > 0)) rows.push(row);
      row = [];
    } else field += character;
  }
  if (quoted) throw new FxProviderError("FX_CSV_INVALID", "ECB returned malformed CSV.");
  if (field.length > 0 || row.length > 0 || closedQuote) { row.push(field); rows.push(row); }
  return rows;
}

function validRate(value: string): boolean {
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) return false;
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 && numeric >= 0.000001 && numeric <= 1000;
}

export function parseEcbCsv(csv: string, now = new Date()): { rate: string; observedAt: Date } {
  const rows = parseCsv(csv);
  if (!rows.length) throw new FxProviderError("FX_CSV_INVALID", "ECB returned an empty CSV response.");
  const header = rows[0]!.map((value) => value.trim());
  const keyIndex = header.indexOf("KEY");
  const frequencyIndex = header.indexOf("FREQ");
  const currencyIndex = header.indexOf("CURRENCY");
  const denominatorIndex = header.indexOf("CURRENCY_DENOM");
  const typeIndex = header.indexOf("EXR_TYPE");
  const suffixIndex = header.indexOf("EXR_SUFFIX");
  const timeIndex = header.indexOf("TIME_PERIOD");
  const valueIndex = header.indexOf("OBS_VALUE");
  if ([keyIndex, frequencyIndex, currencyIndex, denominatorIndex, typeIndex, suffixIndex, timeIndex, valueIndex].some((index) => index < 0)) {
    throw new FxProviderError("FX_CSV_INVALID", "ECB CSV is missing required series metadata.");
  }
  let selected: { rate: string; observedAt: Date } | undefined;
  for (const row of rows.slice(1)) {
    const expectedSeries = row[keyIndex]?.trim() === ECB_CNY_EUR_SERIES
      && row[frequencyIndex]?.trim() === "D"
      && row[currencyIndex]?.trim() === "CNY"
      && row[denominatorIndex]?.trim() === "EUR"
      && row[typeIndex]?.trim() === "SP00"
      && row[suffixIndex]?.trim() === "A";
    if (!expectedSeries) throw new FxProviderError("FX_PAIR_INVALID", "ECB returned an unexpected currency pair or series.");
    const dateValue = row[timeIndex]?.trim() ?? "";
    const rate = row[valueIndex]?.trim() ?? "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateValue) || !validRate(rate)) {
      throw new FxProviderError("FX_OBSERVATION_INVALID", "ECB returned a malformed CNY/EUR observation.");
    }
    const observedAt = new Date(`${dateValue}T00:00:00.000Z`);
    if (Number.isNaN(observedAt.getTime()) || observedAt.toISOString().slice(0, 10) !== dateValue) {
      throw new FxProviderError("FX_OBSERVATION_INVALID", "ECB returned an invalid observation date.");
    }
    if (observedAt.getTime() > now.getTime()) {
      throw new FxProviderError("FX_OBSERVATION_FUTURE", "ECB returned a future observation.");
    }
    if (!selected || observedAt > selected.observedAt) selected = { rate, observedAt };
  }
  if (!selected) throw new FxProviderError("FX_OBSERVATION_INVALID", "ECB returned no valid CNY/EUR observation.");
  return selected;
}

async function defaultTransport(request: { url: string; headers: Record<string, string>; signal: AbortSignal }): Promise<FxHttpResponse> {
  const response = await fetch(request.url, { headers: request.headers, signal: request.signal });
  return { status: response.status, headers: response.headers, body: response.body ?? "" };
}

async function readBody(body: FxHttpResponse["body"]): Promise<Buffer> {
  if (typeof body === "string") {
    const bytes = Buffer.from(body, "utf8");
    if (bytes.byteLength > MAX_RESPONSE_BYTES) throw new FxProviderError("FX_RESPONSE_TOO_LARGE", "ECB response exceeded the maximum size.");
    return bytes;
  }
  if (Buffer.isBuffer(body)) {
    if (body.byteLength > MAX_RESPONSE_BYTES) throw new FxProviderError("FX_RESPONSE_TOO_LARGE", "ECB response exceeded the maximum size.");
    return body;
  }
  if (body instanceof Uint8Array) {
    if (body.byteLength > MAX_RESPONSE_BYTES) throw new FxProviderError("FX_RESPONSE_TOO_LARGE", "ECB response exceeded the maximum size.");
    return Buffer.from(body);
  }
  if (typeof ReadableStream !== "undefined" && body instanceof ReadableStream) {
    const reader = body.getReader();
    const chunks: Buffer[] = [];
    let total = 0;
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new FxProviderError("FX_RESPONSE_TOO_LARGE", "ECB response exceeded the maximum size."); }
      chunks.push(Buffer.from(part.value));
    }
    return Buffer.concat(chunks, total);
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const part of body) {
    total += part.byteLength;
    if (total > MAX_RESPONSE_BYTES) throw new FxProviderError("FX_RESPONSE_TOO_LARGE", "ECB response exceeded the maximum size.");
    chunks.push(Buffer.from(part));
  }
  return Buffer.concat(chunks, total);
}

export class EcbFxProvider implements FxProvider {
  readonly name = "ECB";
  readonly source = "ECB";
  readonly series = ECB_CNY_EUR_SERIES;
  readonly baseCurrency = "EUR";
  readonly quoteCurrency = "CNY";
  private readonly transport: FxHttpTransport;
  private readonly now: () => Date;
  private readonly delay: (milliseconds: number) => Promise<void>;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly userAgent: string;

  constructor(options: EcbProviderOptions = {}) {
    this.transport = options.transport ?? defaultTransport;
    this.now = options.now ?? (() => new Date());
    this.delay = options.delay ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.timeoutMs = Math.max(5_000, Math.min(options.timeoutMs ?? 8_000, 10_000));
    this.maxRetries = Math.max(0, Math.min(options.maxRetries ?? 3, 3));
    this.userAgent = options.userAgent ?? "Lizzor-ECB-FX/1.0";
  }

  async fetchObservation(): Promise<FxObservation> {
    let attempt = 0;
    while (true) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const response = await this.transport({
          url: ECB_CNY_EUR_URL,
          headers: { Accept: "text/csv", "User-Agent": this.userAgent },
          signal: controller.signal,
        });
        const shouldRetry = response.status === 429 || response.status >= 500;
        if (response.status < 200 || response.status >= 300) {
          if (!shouldRetry) throw new FxProviderError("FX_HTTP_ERROR", `ECB returned HTTP ${response.status}.`, { status: response.status });
          throw new FxProviderError("FX_HTTP_RETRYABLE", `ECB returned HTTP ${response.status}.`, { retryable: true, status: response.status });
        }
        const bytes = await readBody(response.body);
        const fetchedAt = this.now();
        const parsed = parseEcbCsv(bytes.toString("utf8"), fetchedAt);
        return { provider: this.name, source: this.source, series: this.series, baseCurrency: this.baseCurrency, quoteCurrency: this.quoteCurrency, rate: parsed.rate, observedAt: parsed.observedAt, fetchedAt, responseHash: createHash("sha256").update(bytes).digest("hex"), rawMetadata: { contentType: response.headers?.get("content-type") ?? "text/csv" } };
      } catch (error) {
        const normalized = error instanceof FxProviderError ? error : new FxProviderError("FX_TRANSPORT_ERROR", "ECB request failed.", { retryable: true });
        if (!normalized.retryable || attempt >= this.maxRetries) throw normalized;
        attempt += 1;
        await this.delay(Math.min(1_000, 100 * 2 ** (attempt - 1)));
      } finally {
        clearTimeout(timer);
      }
    }
  }
}