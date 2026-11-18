export type MoneyCents = number;
export type BasisPoints = number;

export type ProfitLineInput = {
  id: string;
  name: string;
  supplierUnitCostCents: MoneyCents;
  quantity: number;
  sellingUnitPriceCents: MoneyCents;
  discountBasisPoints: BasisPoints;
  fixedDiscountCents: MoneyCents;
  pricingBandReference?: string;
};

export type ProfitOrderInput = {
  lines: ProfitLineInput[];
  supplierFreightCents: MoneyCents;
  customerShippingCents: MoneyCents;
  packagingCents: MoneyCents;
  fxReserveBasisPoints: BasisPoints;
  paymentFeeBasisPoints: BasisPoints;
  paymentFixedFeeCents: MoneyCents;
  refundReserveBasisPoints: BasisPoints;
  operationalReserveCents: MoneyCents;
  vatBasisPoints: BasisPoints;
  pricesIncludeVat: boolean;
  health: {
    excellentMarginBasisPoints: BasisPoints;
    minimumMarginBasisPoints: BasisPoints;
    lossMarginBasisPoints: BasisPoints;
  };
};

export type ProfitLineResult = ProfitLineInput & {
  grossRevenueCents: MoneyCents;
  percentageDiscountCents: MoneyCents;
  netMerchandiseRevenueCents: MoneyCents;
  supplierMerchandiseCostCents: MoneyCents;
  allocatedRevenueExVatCents: MoneyCents;
  allocatedFreightCents: MoneyCents;
  allocatedOrderCostsCents: MoneyCents;
  contributionProfitCents: MoneyCents;
};

export type ProfitSimulationResult = {
  lines: ProfitLineResult[];
  customerMerchandiseRevenueCents: MoneyCents;
  customerShippingRevenueCents: MoneyCents;
  customerChargeCents: MoneyCents;
  vatAmountCents: MoneyCents;
  revenueExVatCents: MoneyCents;
  supplierMerchandiseCostCents: MoneyCents;
  supplierFreightCents: MoneyCents;
  packagingCents: MoneyCents;
  paymentProcessingCostCents: MoneyCents;
  refundReserveCents: MoneyCents;
  fxReserveCents: MoneyCents;
  operationalReserveCents: MoneyCents;
  totalCommercialCostCents: MoneyCents;
  contributionProfitCents: MoneyCents;
  contributionMarginBasisPoints: BasisPoints;
  health: "Healthy" | "Warning" | "Loss";
  healthDetail: string;
  formulas: Record<string, string>;
};

function integer(value: number, label: string, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`${label} must be a safe integer of at least ${minimum}.`);
  return value;
}

function add(...values: number[]) {
  const result = values.reduce((total, value) => total + value, 0);
  return integer(result, "Calculated amount");
}

function roundDivide(numerator: number, denominator: number) {
  integer(numerator, "Numerator");
  integer(denominator, "Denominator", 1);
  return Math.floor((numerator + Math.floor(denominator / 2)) / denominator);
}

export function percentOf(cents: MoneyCents, basisPoints: BasisPoints) {
  integer(cents, "Money");
  integer(basisPoints, "Percentage");
  const product = integer(cents * basisPoints, "Percentage product");
  return roundDivide(product, 10_000);
}

export function parseMoneyToCents(value: string): MoneyCents {
  const normalized = value.trim();
  const match = /^(\d+)(?:\.(\d{0,2}))?$/.exec(normalized);
  if (!match) throw new Error("Enter a non-negative amount with no more than two decimals.");
  const whole = Number(match[1]);
  const fraction = Number((match[2] ?? "").padEnd(2, "0"));
  return integer(whole * 100 + fraction, "Money");
}

export function parsePercentToBasisPoints(value: string): BasisPoints {
  const normalized = value.trim();
  const match = /^(\d+)(?:\.(\d{0,2}))?$/.exec(normalized);
  if (!match) throw new Error("Enter a non-negative percentage with no more than two decimals.");
  const whole = Number(match[1]);
  const fraction = Number((match[2] ?? "").padEnd(2, "0"));
  return integer(whole * 100 + fraction, "Percentage");
}

export function parseSignedPercentToBasisPoints(value: string): BasisPoints {
  const normalized = value.trim();
  const match = /^(-?)(\d+)(?:\.(\d{0,2}))?$/.exec(normalized);
  if (!match) throw new Error("Enter a percentage with no more than two decimals.");
  const whole = Number(match[2]);
  const fraction = Number((match[3] ?? "").padEnd(2, "0"));
  const result = (whole * 100 + fraction) * (match[1] === "-" ? -1 : 1);
  if (!Number.isSafeInteger(result)) throw new Error("Percentage is outside the supported range.");
  return result;
}

export function formatMoney(cents: MoneyCents) {
  const sign = cents < 0 ? "-" : "";
  const absolute = Math.abs(cents);
  return `${sign}€${Math.floor(absolute / 100).toLocaleString("en-IE")}.${String(absolute % 100).padStart(2, "0")}`;
}

export function formatPercent(basisPoints: BasisPoints) {
  const sign = basisPoints < 0 ? "-" : "";
  const absolute = Math.abs(basisPoints);
  return `${sign}${Math.floor(absolute / 100)}.${String(absolute % 100).padStart(2, "0")}%`;
}

function allocate(total: number, weights: number[]) {
  integer(total, "Allocation total");
  if (!weights.length) return [];
  const weightTotal = add(...weights);
  const effectiveWeights = weightTotal > 0 ? weights : weights.map(() => 1);
  const effectiveTotal = weightTotal > 0 ? weightTotal : weights.length;
  let allocated = 0;
  return effectiveWeights.map((weight, index) => {
    if (index === weights.length - 1) return total - allocated;
    const amount = Math.floor((total * weight) / effectiveTotal);
    allocated += amount;
    return amount;
  });
}

export function simulateCommercialProfit(input: ProfitOrderInput): ProfitSimulationResult {
  if (!input.lines.length) throw new Error("At least one merchandise line is required.");
  if (input.health.excellentMarginBasisPoints < input.health.minimumMarginBasisPoints
    || input.health.minimumMarginBasisPoints < input.health.lossMarginBasisPoints) {
    throw new Error("Health thresholds must be ordered from excellent to minimum acceptable to loss.");
  }
  const lines = input.lines.map((line) => {
    integer(line.quantity, "Quantity", 1);
    const grossRevenueCents = integer(line.sellingUnitPriceCents * line.quantity, "Gross line revenue");
    const percentageDiscountCents = percentOf(grossRevenueCents, line.discountBasisPoints);
    const fixedDiscountCents = Math.min(integer(line.fixedDiscountCents, "Fixed discount"), grossRevenueCents - percentageDiscountCents);
    const netMerchandiseRevenueCents = grossRevenueCents - percentageDiscountCents - fixedDiscountCents;
    const supplierMerchandiseCostCents = integer(line.supplierUnitCostCents * line.quantity, "Supplier line cost");
    return { ...line, fixedDiscountCents, grossRevenueCents, percentageDiscountCents, netMerchandiseRevenueCents, supplierMerchandiseCostCents };
  });

  const customerMerchandiseRevenueCents = add(...lines.map((line) => line.netMerchandiseRevenueCents));
  const supplierMerchandiseCostCents = add(...lines.map((line) => line.supplierMerchandiseCostCents));
  const customerRevenueBeforeVatTreatment = add(customerMerchandiseRevenueCents, input.customerShippingCents);
  const vatAmountCents = input.pricesIncludeVat
    ? roundDivide(customerRevenueBeforeVatTreatment * input.vatBasisPoints, 10_000 + input.vatBasisPoints)
    : percentOf(customerRevenueBeforeVatTreatment, input.vatBasisPoints);
  const revenueExVatCents = input.pricesIncludeVat
    ? customerRevenueBeforeVatTreatment - vatAmountCents
    : customerRevenueBeforeVatTreatment;
  const customerChargeCents = input.pricesIncludeVat
    ? customerRevenueBeforeVatTreatment
    : add(customerRevenueBeforeVatTreatment, vatAmountCents);
  const paymentProcessingCostCents = add(percentOf(customerChargeCents, input.paymentFeeBasisPoints), input.paymentFixedFeeCents);
  const refundReserveCents = percentOf(customerChargeCents, input.refundReserveBasisPoints);
  const fxReserveCents = percentOf(add(supplierMerchandiseCostCents, input.supplierFreightCents), input.fxReserveBasisPoints);
  const totalCommercialCostCents = add(
    supplierMerchandiseCostCents,
    input.supplierFreightCents,
    input.packagingCents,
    paymentProcessingCostCents,
    refundReserveCents,
    fxReserveCents,
    input.operationalReserveCents,
  );
  const contributionProfitCents = revenueExVatCents - totalCommercialCostCents;
  const contributionMarginBasisPoints = revenueExVatCents > 0
    ? Math.round((contributionProfitCents * 10_000) / revenueExVatCents)
    : contributionProfitCents < 0 ? -10_000 : 0;
  const health = contributionMarginBasisPoints <= input.health.lossMarginBasisPoints
    ? "Loss"
    : contributionMarginBasisPoints < input.health.minimumMarginBasisPoints
      ? "Warning"
      : "Healthy";
  const healthDetail = health === "Loss"
    ? "At or below the configured loss threshold"
    : health === "Warning"
      ? "Below the configured minimum acceptable margin"
      : contributionMarginBasisPoints < input.health.excellentMarginBasisPoints
        ? "Healthy; below the configured excellent margin"
        : "At or above the configured excellent margin";

  const revenueAllocations = allocate(revenueExVatCents, lines.map((line) => line.netMerchandiseRevenueCents));
  const freightAllocations = allocate(input.supplierFreightCents, lines.map((line) => line.supplierMerchandiseCostCents));
  const otherOrderCosts = totalCommercialCostCents - supplierMerchandiseCostCents - input.supplierFreightCents;
  const otherAllocations = allocate(otherOrderCosts, lines.map((line) => line.netMerchandiseRevenueCents));
  const resultLines = lines.map((line, index) => ({
    ...line,
    allocatedRevenueExVatCents: revenueAllocations[index],
    allocatedFreightCents: freightAllocations[index],
    allocatedOrderCostsCents: otherAllocations[index],
    contributionProfitCents: revenueAllocations[index] - line.supplierMerchandiseCostCents - freightAllocations[index] - otherAllocations[index],
  }));

  return {
    lines: resultLines,
    customerMerchandiseRevenueCents,
    customerShippingRevenueCents: input.customerShippingCents,
    customerChargeCents,
    vatAmountCents,
    revenueExVatCents,
    supplierMerchandiseCostCents,
    supplierFreightCents: input.supplierFreightCents,
    packagingCents: input.packagingCents,
    paymentProcessingCostCents,
    refundReserveCents,
    fxReserveCents,
    operationalReserveCents: input.operationalReserveCents,
    totalCommercialCostCents,
    contributionProfitCents,
    contributionMarginBasisPoints,
    health,
    healthDetail,
    formulas: {
      customerMerchandiseRevenue: "Σ ((selling price × quantity) − percentage discount − fixed discount)",
      customerShippingRevenue: "Configured customer shipping charge",
      customerCharge: input.pricesIncludeVat ? "Merchandise revenue + shipping revenue" : "Merchandise revenue + shipping revenue + VAT",
      vatAmount: input.pricesIncludeVat ? "VAT-inclusive revenue × VAT rate ÷ (100% + VAT rate)" : "VAT-exclusive revenue × VAT rate",
      revenueExcludingVat: input.pricesIncludeVat ? "Merchandise revenue + shipping revenue − VAT" : "Merchandise revenue + shipping revenue",
      supplierMerchandiseCost: "Σ (supplier unit cost × quantity)",
      supplierFreight: "Configured supplier freight",
      packagingHandling: "Configured packaging and handling cost",
      paymentProcessing: "Customer charge × processor percentage + processor fixed fee",
      refundReserve: "Customer charge × refund reserve percentage",
      fxReserve: "(Supplier merchandise cost + supplier freight) × FX reserve percentage",
      operationalReserve: "Configured operational reserve",
      totalCommercialCost: "Merchandise cost + freight + packaging + payment + refund + FX + operational reserves",
      contributionProfit: "Revenue excluding VAT − total commercial cost",
      contributionMargin: "Contribution profit ÷ revenue excluding VAT",
      profitPerProduct: "Allocated ex-VAT revenue − merchandise cost − allocated freight − allocated order costs",
      profitPerOrder: "Revenue excluding VAT − total commercial cost",
    },
  };
}