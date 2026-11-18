import { AppError } from "../middleware/error-handler.js";

export function moneyCents(value: number): number {
  if (!Number.isFinite(value)) throw new AppError(409, "MERCHANDISE_PRICE_INVALID", "Merchandise pricing is invalid.");
  return Math.round(value * 100);
}

function decimalFraction(value: number): { numerator: bigint; denominator: bigint } {
  if (!Number.isFinite(value)) throw new AppError(409, "MERCHANDISE_PRICE_INVALID", "Merchandise pricing is invalid.");
  const text = String(value);
  const [coefficient, exponentText] = text.toLowerCase().split("e");
  const exponent = Number(exponentText ?? 0);
  const negative = coefficient.startsWith("-");
  const unsigned = negative ? coefficient.slice(1) : coefficient;
  const [whole, decimal = ""] = unsigned.split(".");
  let numerator = BigInt(`${whole || "0"}${decimal}`);
  let denominator = 10n ** BigInt(decimal.length);
  if (exponent > 0) numerator *= 10n ** BigInt(exponent);
  if (exponent < 0) denominator *= 10n ** BigInt(-exponent);
  return { numerator: negative ? -numerator : numerator, denominator };
}

export function assertMerchandisePriceFloor(input: {
  unitCost: number;
  quantity?: number;
  merchandiseRevenue: number;
  code?: string;
  message?: string;
}): void {
  const quantity = input.quantity ?? 1;
  const cost = decimalFraction(input.unitCost);
  const scaledCost = cost.numerator * BigInt(quantity) * 100n;
  const required = Number((scaledCost + cost.denominator - 1n) / cost.denominator);
  const offered = moneyCents(input.merchandiseRevenue);
  if (offered < required) {
    throw new AppError(
      409,
      input.code ?? "MERCHANDISE_PRICE_BELOW_COST",
      input.message ?? "The merchandise price is below its current authoritative cost and cannot be used.",
      { requiredMerchandiseTotal: required / 100, offeredMerchandiseTotal: offered / 100 },
    );
  }
}