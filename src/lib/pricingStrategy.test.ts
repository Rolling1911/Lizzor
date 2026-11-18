import { describe, expect, it } from "vitest";
import { simulateCommercialProfit, type ProfitOrderInput } from "./commercialProfit";
import {
  calculatePricingBandPrice,
  comparePricingStrategy,
  roundUpToRetail99,
  solveMinimumPriceForMargin,
  solveMinimumPriceForProfit,
  type PricingBandRule,
} from "./pricingStrategy";

const rules: PricingBandRule[] = [
  { id: "1", name: "0–5", ruleType: "markup_percent", minCostEur: "0", maxCostEur: "5", value: "100", roundingMode: "none", priority: 1 },
  { id: "2", name: "5–15", ruleType: "markup_percent", minCostEur: "5", maxCostEur: "15", value: "70", roundingMode: "none", priority: 2 },
  { id: "3", name: "15–30", ruleType: "markup_percent", minCostEur: "15", maxCostEur: "30", value: "50", roundingMode: "none", priority: 3 },
  { id: "4", name: "30–75", ruleType: "markup_percent", minCostEur: "30", maxCostEur: "75", value: "35", roundingMode: "none", priority: 4 },
  { id: "5", name: "75+", ruleType: "markup_percent", minCostEur: "75", maxCostEur: null, value: "25", roundingMode: "none", priority: 5 },
];

const input: ProfitOrderInput = {
  lines: [{ id: "line", name: "Product", supplierUnitCostCents: 1000, quantity: 1, sellingUnitPriceCents: 2000, discountBasisPoints: 0, fixedDiscountCents: 0 }],
  supplierFreightCents: 850,
  customerShippingCents: 695,
  packagingCents: 120,
  fxReserveBasisPoints: 250,
  paymentFeeBasisPoints: 180,
  paymentFixedFeeCents: 30,
  refundReserveBasisPoints: 200,
  operationalReserveCents: 400,
  vatBasisPoints: 2300,
  pricesIncludeVat: true,
  health: { excellentMarginBasisPoints: 3000, minimumMarginBasisPoints: 1500, lossMarginBasisPoints: 0 },
};

describe("pricing strategy comparison", () => {
  it("matches the five half-open production bands", () => {
    expect(calculatePricingBandPrice(200, rules)).toMatchObject({ priceCents: 400, bandName: "0–5" });
    expect(calculatePricingBandPrice(500, rules)).toMatchObject({ priceCents: 850, bandName: "5–15" });
    expect(calculatePricingBandPrice(1500, rules)).toMatchObject({ priceCents: 2250, bandName: "15–30" });
    expect(calculatePricingBandPrice(7500, rules)).toMatchObject({ priceCents: 9375, bandName: "75+" });
  });

  it("returns the lowest cent satisfying the margin floor", () => {
    const solved = solveMinimumPriceForMargin(input, "line", 2500);
    expect(BigInt(solved.simulation.contributionProfitCents) * 10_000n).toBeGreaterThanOrEqual(BigInt(solved.simulation.revenueExVatCents) * 2500n);
    const below = simulateCommercialProfit({ ...input, lines: [{ ...input.lines[0], sellingUnitPriceCents: solved.sellingUnitPriceCents - 1 }] });
    expect(BigInt(below.contributionProfitCents) * 10_000n).toBeLessThan(BigInt(below.revenueExVatCents) * 2500n);
  });

  it("returns the lowest cent satisfying the euro-profit floor", () => {
    const solved = solveMinimumPriceForProfit(input, "line", 200);
    expect(solved.simulation.contributionProfitCents).toBeGreaterThanOrEqual(200);
    const comparison = comparePricingStrategy(input, "line", 1000, rules, 2500, 200);
    expect(comparison.profitFloor.sellingUnitPriceCents).toBe(solved.sellingUnitPriceCents);
  });

  it("proves one cent below each binding floor fails", () => {
    const margin = solveMinimumPriceForMargin(input, "line", 2500);
    const profit = solveMinimumPriceForProfit(input, "line", 200);
    const marginBelow = simulateCommercialProfit({ ...input, lines: [{ ...input.lines[0], sellingUnitPriceCents: margin.sellingUnitPriceCents - 1 }] });
    expect(BigInt(marginBelow.contributionProfitCents) * 10_000n).toBeLessThan(BigInt(marginBelow.revenueExVatCents) * 2500n);
    const profitBelow = simulateCommercialProfit({ ...input, lines: [{ ...input.lines[0], sellingUnitPriceCents: profit.sellingUnitPriceCents - 1 }] });
    expect(profitBelow.contributionProfitCents).toBeLessThan(200);
  });

  it("reconciles every required matrix supplier cost", () => {
    for (const cost of [200, 500, 1000, 2000, 5000, 7500, 10000]) {
      const row = comparePricingStrategy(input, "line", cost, rules, 2500, 200);
      const simulateAt = (price: number) => simulateCommercialProfit({
        ...input,
        lines: [{ ...input.lines[0], quantity: 1, supplierUnitCostCents: cost, sellingUnitPriceCents: price }],
      });
      const marginPasses = (result: ReturnType<typeof simulateCommercialProfit>) =>
        result.revenueExVatCents > 0
        && BigInt(result.contributionProfitCents) * 10_000n >= BigInt(result.revenueExVatCents) * 2500n;
      expect(marginPasses(row.marginFloor.simulation)).toBe(true);
      expect(marginPasses(simulateAt(row.marginFloor.sellingUnitPriceCents - 1))).toBe(false);
      expect(row.profitFloor.simulation.contributionProfitCents).toBeGreaterThanOrEqual(200);
      expect(simulateAt(row.profitFloor.sellingUnitPriceCents - 1).contributionProfitCents).toBeLessThan(200);
      expect(row.currentSimulation).toEqual(simulateAt(row.currentBandPriceCents));
      const required = simulateAt(row.requiredCommercialPriceCents);
      expect(marginPasses(required)).toBe(true);
      expect(required.contributionProfitCents).toBeGreaterThanOrEqual(200);
      expect(row.requiredCommercialPriceCents).toBe(Math.max(row.currentBandPriceCents, row.marginFloor.sellingUnitPriceCents, row.profitFloor.sellingUnitPriceCents));
      expect(row.differenceCents).toBe(row.requiredCommercialPriceCents - row.currentBandPriceCents);
    }
  });

  it("matches fixed, margin, whole, and upward-safe .99 production rule arithmetic", () => {
    expect(calculatePricingBandPrice(1234, [{
      id: "fixed", name: "Fixed", ruleType: "markup_fixed", minCostEur: "0", maxCostEur: null, value: "2.50", roundingMode: "none", priority: 1,
    }]).priceCents).toBe(1484);
    expect(calculatePricingBandPrice(1000, [{
      id: "margin", name: "Margin", ruleType: "margin_percent", minCostEur: "0", maxCostEur: null, value: "20", roundingMode: "none", priority: 1,
    }]).priceCents).toBe(1250);
    expect(calculatePricingBandPrice(101, [{
      id: "whole", name: "Whole", ruleType: "markup_percent", minCostEur: "0", maxCostEur: null, value: "10", roundingMode: "whole", priority: 1,
    }]).priceCents).toBe(200);
    expect(calculatePricingBandPrice(1000, [{
      id: "retail", name: "Retail", ruleType: "markup_percent", minCostEur: "0", maxCostEur: null, value: "10", roundingMode: "99", priority: 1,
    }]).priceCents).toBe(1199);
  });

  it("keeps exact floors under VAT-exclusive prices and discounts", () => {
    const discounted = {
      ...input,
      pricesIncludeVat: false,
      lines: [{ ...input.lines[0], discountBasisPoints: 1250, fixedDiscountCents: 175 }],
    };
    const solved = solveMinimumPriceForMargin(discounted, "line", 2500);
    const below = simulateCommercialProfit({ ...discounted, lines: [{ ...discounted.lines[0], sellingUnitPriceCents: solved.sellingUnitPriceCents - 1 }] });
    expect(BigInt(solved.simulation.contributionProfitCents) * 10_000n).toBeGreaterThanOrEqual(BigInt(solved.simulation.revenueExVatCents) * 2500n);
    expect(BigInt(below.contributionProfitCents) * 10_000n).toBeLessThan(BigInt(below.revenueExVatCents) * 2500n);
  });

  it("keeps optional .99 preview upward-safe and separate", () => {
    expect(roundUpToRetail99(1000)).toBe(1099);
    expect(roundUpToRetail99(1099)).toBe(1099);
    expect(roundUpToRetail99(1100)).toBe(1199);
  });
});