import { createHash } from "node:crypto";
import { AppError } from "../middleware/error-handler.js";

export type TaxMode = "inclusive" | "exclusive";

export interface PayableLineInput {
  key: string;
  merchandiseCents: number;
  vatRate: number | string;
  taxMode: TaxMode;
  vatClassifiedAt?: Date | string | null;
}

export interface PayableLineResult extends PayableLineInput {
  taxCents: number;
  payableMerchandiseCents: number;
}

function assertCents(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new AppError(500, "INVALID_MONEY", "A monetary value could not be reconciled.");
  }
  return value;
}

function roundedRatio(numerator: bigint, denominator: bigint): number {
  const rounded = (numerator + denominator / 2n) / denominator;
  const value = Number(rounded);
  return assertCents(value);
}

export function moneyToCents(value: number | string): number {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new AppError(500, "INVALID_MONEY", "A monetary value could not be reconciled.");
    return assertCents(Math.round((value + Number.EPSILON) * 100));
  }
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!match) throw new AppError(500, "INVALID_MONEY", "A stored monetary value is invalid.");
  return assertCents(Number(match[1]) * 100 + Number(((match[2] ?? "") + "00").slice(0, 2)));
}

export function centsToMoney(value: number): number {
  return assertCents(value) / 100;
}

function vatBasisPoints(value: number | string): number {
  const numeric = Number(value);
  const basisPoints = Math.round(numeric * 100);
  if (!Number.isFinite(numeric) || !Number.isSafeInteger(basisPoints) || basisPoints < 0 || basisPoints > 10_000) {
    throw new AppError(500, "INVALID_VAT_RATE", "A VAT rate could not be reconciled.");
  }
  return basisPoints;
}

export function calculatePayableTotals(input: {
  lines: PayableLineInput[];
  shippingCents: number;
}) {
  const shippingCents = assertCents(input.shippingCents);
  const lines: PayableLineResult[] = input.lines.map((line) => {
    const merchandiseCents = assertCents(line.merchandiseCents);
    const rate = vatBasisPoints(line.vatRate);
    const numerator = BigInt(merchandiseCents) * BigInt(rate);
    const taxCents = line.taxMode === "inclusive"
      ? roundedRatio(numerator, BigInt(10_000 + rate))
      : roundedRatio(numerator, 10_000n);
    return {
      ...line,
      merchandiseCents,
      taxCents,
      payableMerchandiseCents: merchandiseCents + (line.taxMode === "exclusive" ? taxCents : 0),
    };
  });
  const sum = (values: number[]) => {
    const total = values.reduce((result, value) => result + BigInt(value), 0n);
    return assertCents(Number(total));
  };
  const merchandiseCents = sum(lines.map((line) => line.merchandiseCents));
  const taxCents = sum(lines.map((line) => line.taxCents));
  const payableMerchandiseCents = sum(lines.map((line) => line.payableMerchandiseCents));
  const payableTotalCents = assertCents(payableMerchandiseCents + shippingCents);
  return { lines, merchandiseCents, taxCents, shippingCents, payableMerchandiseCents, payableTotalCents };
}

export function payableTotalFingerprint(input: {
  currency: string;
  lines: Array<PayableLineInput & { productId: string; variantId?: string | null; quantity: number }>;
  shippingCents: number;
  payableTotalCents: number;
}): string {
  return createHash("sha256").update(JSON.stringify({
    currency: input.currency.toUpperCase(),
    shippingCents: assertCents(input.shippingCents),
    payableTotalCents: assertCents(input.payableTotalCents),
    lines: input.lines.map((line) => ({
      key: line.key,
      productId: line.productId,
      variantId: line.variantId ?? null,
      quantity: Number(line.quantity),
      merchandiseCents: assertCents(line.merchandiseCents),
      vatRateBasisPoints: vatBasisPoints(line.vatRate),
      taxMode: line.taxMode,
      vatClassifiedAt: line.vatClassifiedAt ? new Date(line.vatClassifiedAt).toISOString() : null,
    })).sort((a, b) => a.key.localeCompare(b.key)),
  })).digest("hex");
}