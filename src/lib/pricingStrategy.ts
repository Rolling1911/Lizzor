import {
  simulateCommercialProfit,
  type BasisPoints,
  type MoneyCents,
  type ProfitOrderInput,
  type ProfitSimulationResult,
} from "./commercialProfit";

export type PricingBandRule = {
  id: string;
  name: string;
  ruleType: "markup_percent" | "markup_fixed" | "margin_percent";
  minCostEur: string;
  maxCostEur: string | null;
  value: string;
  roundingMode: "none" | "whole" | "99";
  priority: number;
};

export type PriceFloorSolution = {
  sellingUnitPriceCents: MoneyCents;
  simulation: ProfitSimulationResult;
};

export type PricingStrategyComparison = {
  supplierCostCents: MoneyCents;
  bandName: string;
  currentBandPriceCents: MoneyCents;
  currentSimulation: ProfitSimulationResult;
  marginFloor: PriceFloorSolution;
  profitFloor: PriceFloorSolution;
  requiredCommercialPriceCents: MoneyCents;
  bindingConstraints: Array<"Current band" | "Margin floor" | "Profit floor">;
  differenceCents: MoneyCents;
  differenceBasisPoints: BasisPoints;
  retailRoundedPriceCents: MoneyCents;
};

function safeInteger(value: number, label: string, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`${label} must be a safe integer of at least ${minimum}.`);
  return value;
}

function fraction(value: string) {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!match) throw new Error(`Invalid decimal value: ${value}`);
  const decimal = match[2] ?? "";
  return { numerator: BigInt(`${match[1]}${decimal}`), denominator: 10n ** BigInt(decimal.length) };
}

function isAtLeastDecimalEur(cents: MoneyCents, value: string) {
  const target = fraction(value);
  return BigInt(cents) * target.denominator >= target.numerator * 100n;
}

function nearestInteger(numerator: bigint, denominator: bigint) {
  return numerator / denominator + ((numerator % denominator) * 2n >= denominator ? 1n : 0n);
}

export function calculatePricingBandPrice(
  supplierCostCents: MoneyCents,
  rules: PricingBandRule[],
): { priceCents: MoneyCents; bandName: string } {
  safeInteger(supplierCostCents, "Supplier cost");
  const rule = [...rules].sort((a, b) => a.priority - b.priority).find((candidate) =>
    isAtLeastDecimalEur(supplierCostCents, candidate.minCostEur)
    && (candidate.maxCostEur === null || !isAtLeastDecimalEur(supplierCostCents, candidate.maxCostEur)));
  if (!rule) throw new Error("No active production pricing band covers this supplier cost.");

  const costNumerator = BigInt(supplierCostCents);
  const costDenominator = 100n;
  const value = fraction(rule.value);
  let numerator: bigint;
  let denominator: bigint;
  if (rule.ruleType === "markup_percent") {
    numerator = costNumerator * (100n * value.denominator + value.numerator);
    denominator = costDenominator * 100n * value.denominator;
  } else if (rule.ruleType === "markup_fixed") {
    numerator = costNumerator * value.denominator + value.numerator * costDenominator;
    denominator = costDenominator * value.denominator;
  } else {
    if (value.numerator >= 100n * value.denominator) throw new Error("Margin pricing value must be below 100 percent.");
    numerator = costNumerator * 100n * value.denominator;
    denominator = costDenominator * (100n * value.denominator - value.numerator);
  }

  let cents: bigint;
  if (rule.roundingMode === "whole") cents = ((numerator + denominator - 1n) / denominator) * 100n;
  else if (rule.roundingMode === "99") {
    const whole = numerator / denominator;
    const candidate = whole * 100n + 99n;
    cents = candidate * denominator >= numerator * 100n ? candidate : candidate + 100n;
  } else cents = nearestInteger(numerator * 100n, denominator);

  const priceCents = Number(cents);
  safeInteger(priceCents, "Band price", supplierCostCents);
  return { priceCents, bandName: rule.name };
}

function withCandidate(input: ProfitOrderInput, lineId: string, priceCents: MoneyCents) {
  let found = 0;
  const lines = input.lines.map((line) => {
    if (line.id !== lineId) return line;
    found += 1;
    return { ...line, sellingUnitPriceCents: priceCents };
  });
  if (found !== 1) throw new Error("The pricing solver requires exactly one matching merchandise line.");
  return { ...input, lines };
}

function solveMinimumPrice(
  input: ProfitOrderInput,
  lineId: string,
  predicate: (result: ProfitSimulationResult) => boolean,
  lowerBoundCents = 0,
): PriceFloorSolution {
  safeInteger(lowerBoundCents, "Price lower bound");
  const evaluate = (price: number) => simulateCommercialProfit(withCandidate(input, lineId, price));
  const lowerResult = evaluate(lowerBoundCents);
  if (predicate(lowerResult)) return { sellingUnitPriceCents: lowerBoundCents, simulation: lowerResult };

  let low = lowerBoundCents;
  let high = Math.max(1, lowerBoundCents * 2);
  let highResult = evaluate(high);
  while (!predicate(highResult)) {
    low = high;
    if (high > Math.floor(Number.MAX_SAFE_INTEGER / 2)) throw new Error("The requested pricing floor cannot be solved within safe integer limits.");
    high *= 2;
    highResult = evaluate(high);
  }
  while (low + 1 < high) {
    const middle = low + Math.floor((high - low) / 2);
    const result = evaluate(middle);
    if (predicate(result)) {
      high = middle;
      highResult = result;
    } else low = middle;
  }
  return { sellingUnitPriceCents: high, simulation: highResult };
}

export function solveMinimumPriceForMargin(
  input: ProfitOrderInput,
  lineId: string,
  targetMarginBasisPoints: BasisPoints,
  lowerBoundCents = 0,
) {
  safeInteger(targetMarginBasisPoints, "Target contribution margin");
  if (targetMarginBasisPoints >= 10_000) throw new Error("Target contribution margin must be below 100 percent.");
  return solveMinimumPrice(input, lineId, (result) =>
    result.revenueExVatCents > 0
    && BigInt(result.contributionProfitCents) * 10_000n >= BigInt(result.revenueExVatCents) * BigInt(targetMarginBasisPoints),
  lowerBoundCents);
}

export function solveMinimumPriceForProfit(
  input: ProfitOrderInput,
  lineId: string,
  minimumContributionProfitCents: MoneyCents,
  lowerBoundCents = 0,
) {
  safeInteger(minimumContributionProfitCents, "Minimum contribution profit");
  return solveMinimumPrice(input, lineId, (result) => result.contributionProfitCents >= minimumContributionProfitCents, lowerBoundCents);
}

export function roundUpToRetail99(priceCents: MoneyCents) {
  safeInteger(priceCents, "Commercial price");
  const candidate = Math.floor(priceCents / 100) * 100 + 99;
  return candidate >= priceCents ? candidate : candidate + 100;
}

export function comparePricingStrategy(
  input: ProfitOrderInput,
  lineId: string,
  supplierCostCents: MoneyCents,
  rules: PricingBandRule[],
  targetMarginBasisPoints: BasisPoints,
  minimumContributionProfitCents: MoneyCents,
): PricingStrategyComparison {
  const oneLineInput: ProfitOrderInput = {
    ...input,
    lines: input.lines.filter((line) => line.id === lineId).map((line) => ({
      ...line,
      quantity: 1,
      supplierUnitCostCents: supplierCostCents,
    })),
  };
  if (oneLineInput.lines.length !== 1) throw new Error("A comparison line is required.");
  const band = calculatePricingBandPrice(supplierCostCents, rules);
  const currentSimulation = simulateCommercialProfit(withCandidate(oneLineInput, lineId, band.priceCents));
  const marginFloor = solveMinimumPriceForMargin(oneLineInput, lineId, targetMarginBasisPoints);
  const profitFloor = solveMinimumPriceForProfit(oneLineInput, lineId, minimumContributionProfitCents);
  const requiredCommercialPriceCents = Math.max(band.priceCents, marginFloor.sellingUnitPriceCents, profitFloor.sellingUnitPriceCents);
  const bindingConstraints: PricingStrategyComparison["bindingConstraints"] = [];
  if (requiredCommercialPriceCents === band.priceCents) bindingConstraints.push("Current band");
  if (requiredCommercialPriceCents === marginFloor.sellingUnitPriceCents) bindingConstraints.push("Margin floor");
  if (requiredCommercialPriceCents === profitFloor.sellingUnitPriceCents) bindingConstraints.push("Profit floor");
  const differenceCents = requiredCommercialPriceCents - band.priceCents;
  const differenceBasisPoints = band.priceCents > 0 ? Math.round((differenceCents * 10_000) / band.priceCents) : 0;
  return {
    supplierCostCents,
    bandName: band.bandName,
    currentBandPriceCents: band.priceCents,
    currentSimulation,
    marginFloor,
    profitFloor,
    requiredCommercialPriceCents,
    bindingConstraints,
    differenceCents,
    differenceBasisPoints,
    retailRoundedPriceCents: roundUpToRetail99(requiredCommercialPriceCents),
  };
}