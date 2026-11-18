/**
 * Provider-neutral foreign exchange contracts.
 *
 * Providers return decimal strings deliberately.  FX rates are financial
 * inputs and must not be converted through a JavaScript Number before they
 * are persisted or used for normalization.
 */
export type FxObservation = {
  provider: string;
  source: string;
  series: string;
  baseCurrency: string;
  quoteCurrency: string;
  rate: string;
  observedAt: Date;
  fetchedAt: Date;
  responseHash?: string;
  rawMetadata?: Record<string, unknown>;
};

export type FxProvider = {
  readonly name: string;
  readonly source: string;
  readonly series: string;
  readonly baseCurrency: string;
  readonly quoteCurrency: string;
  fetchObservation(): Promise<FxObservation>;
};

export class FxProviderError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly status?: number;

  constructor(code: string, message: string, options: { retryable?: boolean; status?: number } = {}) {
    super(message);
    this.name = "FxProviderError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.status = options.status;
  }
}

function decimalParts(value: string): { integer: bigint; scale: number } {
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) {
    throw new Error("Decimal value is not canonical.");
  }
  const [whole, fraction = ""] = value.split(".");
  return { integer: BigInt(`${whole}${fraction}`), scale: fraction.length };
}

/**
 * Exact CNY / (CNY per EUR) conversion, rounded half-up to four decimals.
 * The original amount and rate are decimal strings, so this remains exact
 * even when a provider sends more precision than the catalogue column.
 */
export function normalizeCnyToEur(amountCny: string, cnyPerEur: string): string {
  const amount = decimalParts(amountCny);
  const rate = decimalParts(cnyPerEur);
  if (amount.integer < 0n || rate.integer <= 0n) throw new Error("Amount must be nonnegative and rate must be positive.");

  // (amount / 10^a) / (rate / 10^r), scaled by 10^4 for rounding.
  let numerator = amount.integer * 10n ** BigInt(rate.scale + 4);
  let denominator = rate.integer * 10n ** BigInt(amount.scale);
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  const rounded = remainder * 2n >= denominator ? quotient + 1n : quotient;
  const integerPart = rounded / 10_000n;
  const fractionalPart = String(rounded % 10_000n).padStart(4, "0");
  return `${integerPart}.${fractionalPart}`;
}

export function assertValidFxObservation(observation: FxObservation, now: Date, maxAgeMs: number): FxObservation {
  if (observation.provider.length > 80 || observation.source.length > 80 || observation.series.length > 160) {
    throw new FxProviderError("FX_METADATA_INVALID", "FX provider metadata is too long.");
  }
  if (observation.baseCurrency !== "EUR" || observation.quoteCurrency !== "CNY") {
    throw new FxProviderError("FX_PAIR_INVALID", "Only the ECB EUR/CNY series is supported.");
  }
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(observation.rate)) {
    throw new FxProviderError("FX_RATE_INVALID", "The FX provider returned a malformed rate.");
  }
  const numericRate = Number(observation.rate);
  if (!Number.isFinite(numericRate) || numericRate <= 0 || numericRate < 0.000001 || numericRate > 1000) {
    throw new FxProviderError("FX_RATE_INVALID", "The FX provider returned an implausible rate.");
  }
  if (!(observation.observedAt instanceof Date) || Number.isNaN(observation.observedAt.getTime())) {
    throw new FxProviderError("FX_OBSERVATION_INVALID", "The FX observation timestamp is invalid.");
  }
  if (observation.observedAt.getTime() > now.getTime()) {
    throw new FxProviderError("FX_OBSERVATION_FUTURE", "The FX observation is in the future.");
  }
  if (observation.observedAt.getTime() < now.getTime() - maxAgeMs) {
    throw new FxProviderError("FX_OBSERVATION_STALE", "The FX observation is stale.");
  }
  if (!(observation.fetchedAt instanceof Date) || Number.isNaN(observation.fetchedAt.getTime())) {
    throw new FxProviderError("FX_FETCHED_AT_INVALID", "The FX fetch timestamp is invalid.");
  }
  if (observation.fetchedAt.getTime() > now.getTime()) {
    throw new FxProviderError("FX_FETCHED_AT_INVALID", "The FX fetch timestamp is in the future.");
  }
  return observation;
}