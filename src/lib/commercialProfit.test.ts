import { describe, expect, it } from "vitest";
import { parseMoneyToCents, parsePercentToBasisPoints, parseSignedPercentToBasisPoints, simulateCommercialProfit, type ProfitOrderInput } from "./commercialProfit";

function scenario(overrides: Partial<ProfitOrderInput> = {}): ProfitOrderInput {
  return {
    lines: [{ id: "one", name: "Product 1", supplierUnitCostCents: 500, quantity: 2, sellingUnitPriceCents: 1500, discountBasisPoints: 0, fixedDiscountCents: 0 }],
    supplierFreightCents: 300,
    customerShippingCents: 500,
    packagingCents: 100,
    fxReserveBasisPoints: 200,
    paymentFeeBasisPoints: 290,
    paymentFixedFeeCents: 30,
    refundReserveBasisPoints: 100,
    operationalReserveCents: 50,
    vatBasisPoints: 1900,
    pricesIncludeVat: true,
    health: { excellentMarginBasisPoints: 3500, minimumMarginBasisPoints: 1500, lossMarginBasisPoints: 0 },
    ...overrides,
  };
}

describe("commercial profit simulator", () => {
  it("parses decimal money and percentage inputs without floating point", () => {
    expect(parseMoneyToCents("0.10") + parseMoneyToCents("0.20")).toBe(30);
    expect(parsePercentToBasisPoints("2.90")).toBe(290);
    expect(parseSignedPercentToBasisPoints("-5.25")).toBe(-525);
    expect(() => parseMoneyToCents("1.001")).toThrow();
  });

  it("extracts VAT from VAT-inclusive revenue", () => {
    const result = simulateCommercialProfit(scenario({ lines: [{ ...scenario().lines[0], quantity: 1, sellingUnitPriceCents: 11900 }], customerShippingCents: 0 }));
    expect(result.vatAmountCents).toBe(1900);
    expect(result.revenueExVatCents).toBe(10000);
    expect(result.customerChargeCents).toBe(11900);
  });

  it("adds VAT to VAT-exclusive customer charges without removing it from revenue", () => {
    const result = simulateCommercialProfit(scenario({ pricesIncludeVat: false, lines: [{ ...scenario().lines[0], quantity: 1, sellingUnitPriceCents: 10000 }], customerShippingCents: 0 }));
    expect(result.vatAmountCents).toBe(1900);
    expect(result.revenueExVatCents).toBe(10000);
    expect(result.customerChargeCents).toBe(11900);
  });

  it("applies percentage discounts", () => {
    expect(simulateCommercialProfit(scenario({ lines: [{ ...scenario().lines[0], quantity: 1, sellingUnitPriceCents: 10000, discountBasisPoints: 1000 }] }))).toMatchObject({ customerMerchandiseRevenueCents: 9000 });
  });

  it("applies fixed discounts", () => {
    expect(simulateCommercialProfit(scenario({ lines: [{ ...scenario().lines[0], quantity: 1, sellingUnitPriceCents: 10000, fixedDiscountCents: 1250 }] }))).toMatchObject({ customerMerchandiseRevenueCents: 8750 });
  });

  it("applies percentage then fixed discounts and caps them at gross revenue", () => {
    const result = simulateCommercialProfit(scenario({ lines: [{ ...scenario().lines[0], quantity: 1, sellingUnitPriceCents: 10000, discountBasisPoints: 1000, fixedDiscountCents: 9500 }] }));
    expect(result.customerMerchandiseRevenueCents).toBe(0);
  });

  it("totals multiple merchandise lines and preserves per-line profits", () => {
    const result = simulateCommercialProfit(scenario({ lines: [
      scenario().lines[0],
      { id: "two", name: "Product 2", supplierUnitCostCents: 2000, quantity: 1, sellingUnitPriceCents: 5000, discountBasisPoints: 0, fixedDiscountCents: 0 },
    ] }));
    expect(result.customerMerchandiseRevenueCents).toBe(8000);
    expect(result.supplierMerchandiseCostCents).toBe(3000);
    expect(result.lines.reduce((sum, line) => sum + line.contributionProfitCents, 0)).toBe(result.contributionProfitCents);
  });

  it("allocates all freight across merchandise lines", () => {
    const result = simulateCommercialProfit(scenario({ lines: [scenario().lines[0], { ...scenario().lines[0], id: "two" }] }));
    expect(result.lines.reduce((sum, line) => sum + line.allocatedFreightCents, 0)).toBe(result.supplierFreightCents);
  });

  it("combines processor percentage and fixed fees", () => {
    const result = simulateCommercialProfit(scenario({ pricesIncludeVat: false, vatBasisPoints: 0, customerShippingCents: 0 }));
    expect(result.paymentProcessingCostCents).toBe(117);
  });

  it("calculates FX, refund, and operational reserves independently", () => {
    const result = simulateCommercialProfit(scenario());
    expect(result.fxReserveCents).toBe(26);
    expect(result.refundReserveCents).toBe(35);
    expect(result.operationalReserveCents).toBe(50);
  });

  it("reconciles contribution profit, total cost, and margin", () => {
    const result = simulateCommercialProfit(scenario());
    expect(result.contributionProfitCents).toBe(result.revenueExVatCents - result.totalCommercialCostCents);
    expect(result.contributionMarginBasisPoints).toBe(Math.round(result.contributionProfitCents * 10_000 / result.revenueExVatCents));
  });

  it("handles one-cent percentage rounding deterministically", () => {
    const result = simulateCommercialProfit(scenario({ lines: [{ ...scenario().lines[0], quantity: 1, sellingUnitPriceCents: 1, discountBasisPoints: 5000 }], customerShippingCents: 0 }));
    expect(result.lines[0].percentageDiscountCents).toBe(1);
  });

  it("classifies health from editable thresholds", () => {
    expect(simulateCommercialProfit(scenario({ health: { excellentMarginBasisPoints: 9000, minimumMarginBasisPoints: 5000, lossMarginBasisPoints: -5000 } })).health).toBe("Warning");
    expect(simulateCommercialProfit(scenario({ lines: [{ ...scenario().lines[0], supplierUnitCostCents: 5000 }] })).health).toBe("Loss");
    expect(() => simulateCommercialProfit(scenario({ health: { excellentMarginBasisPoints: 1000, minimumMarginBasisPoints: 2000, lossMarginBasisPoints: 0 } }))).toThrow(/ordered/);
  });

  it("honors minimum and signed loss boundaries independently", () => {
    const negative = simulateCommercialProfit(scenario({
      lines: [{ ...scenario().lines[0], supplierUnitCostCents: 11000 }],
      health: { excellentMarginBasisPoints: 3000, minimumMarginBasisPoints: 1500, lossMarginBasisPoints: -10000 },
    }));
    expect(negative.contributionMarginBasisPoints).toBeLessThan(0);

    const aboveLoss = simulateCommercialProfit(scenario({
      lines: [{ ...scenario().lines[0], supplierUnitCostCents: 11000 }],
      health: {
        excellentMarginBasisPoints: 3000,
        minimumMarginBasisPoints: 1500,
        lossMarginBasisPoints: negative.contributionMarginBasisPoints - 1,
      },
    }));
    expect(aboveLoss.health).toBe("Warning");

    const atLoss = simulateCommercialProfit(scenario({
      lines: [{ ...scenario().lines[0], supplierUnitCostCents: 11000 }],
      health: {
        excellentMarginBasisPoints: 3000,
        minimumMarginBasisPoints: 1500,
        lossMarginBasisPoints: negative.contributionMarginBasisPoints,
      },
    }));
    expect(atLoss.health).toBe("Loss");
  });

  it("is a pure local calculation with no browser or provider calls", () => {
    const before = structuredClone(scenario());
    const after = structuredClone(before);
    simulateCommercialProfit(after);
    expect(after).toEqual(before);
    expect(String(simulateCommercialProfit)).not.toMatch(/fetch|apiRequest|Stripe|Toonies/);
  });
});