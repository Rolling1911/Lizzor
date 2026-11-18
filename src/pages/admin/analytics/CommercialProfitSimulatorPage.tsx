import { useEffect, useMemo, useState } from "react";
import { AdminNotice, AdminPageHeader, AdminPanel, AdminField, FormActions, StatusBadge, LoadingState, ErrorState } from "../../../components/admin/AdminPrimitives";
import { Icon } from "../../../components/ui/Icon";
import { apiRequest } from "../../../auth/api";
import {
  formatMoney,
  formatPercent,
  parseMoneyToCents,
  parsePercentToBasisPoints,
  parseSignedPercentToBasisPoints,
  simulateCommercialProfit,
  type ProfitOrderInput,
  type ProfitSimulationResult,
} from "../../../lib/commercialProfit";
import {
  comparePricingStrategy,
  type PricingBandRule,
  type PricingStrategyComparison,
} from "../../../lib/pricingStrategy";

type LineDraft = {
  id: string;
  name: string;
  sku: string;
  cost: string;
  quantity: string;
  price: string;
  discount: string;
  fixedDiscount: string;
};

type Scenario = { id: number; name: string; input: ProfitOrderInput; result: ProfitSimulationResult };

const initialLines: LineDraft[] = [
  { id: "line-1", name: "Merino Everyday Tee", sku: "TEE-MER-001", cost: "18.40", quantity: "2", price: "49.00", discount: "0", fixedDiscount: "0" },
  { id: "line-2", name: "Ribbed Studio Trouser", sku: "TRS-RIB-004", cost: "31.75", quantity: "1", price: "84.00", discount: "10", fixedDiscount: "0" },
];

const presets = {
  standard: { supplierFreight: "8.50", packaging: "1.20", fx: "2.5", payment: "1.8", fixedPayment: "0.30", refund: "2.0", operational: "4.00" },
  crossBorder: { supplierFreight: "14.00", packaging: "1.80", fx: "4.5", payment: "2.1", fixedPayment: "0.30", refund: "3.5", operational: "7.50" },
  lean: { supplierFreight: "5.00", packaging: "0.80", fx: "1.5", payment: "1.5", fixedPayment: "0.25", refund: "1.0", operational: "2.50" },
};

function money(value: string) {
  try { return parseMoneyToCents(value); } catch { return 0; }
}
function percent(value: string) {
  try { return parsePercentToBasisPoints(value); } catch { return 0; }
}
function signedPercent(value: string) {
  try { return parseSignedPercentToBasisPoints(value); } catch { return 0; }
}
function field(setter: (value: string) => void) {
  return (event: React.ChangeEvent<HTMLInputElement>) => setter(event.target.value);
}

export default function CommercialProfitSimulatorPage({ initialPricingBands }: { initialPricingBands?: PricingBandRule[] } = {}) {
  const [lines, setLines] = useState(initialLines);
  const [orderMode, setOrderMode] = useState<"single" | "multi">("multi");
  const [assumptions, setAssumptions] = useState({ supplierFreight: "8.50", shipping: "6.95", packaging: "1.20", fx: "2.5", payment: "1.8", fixedPayment: "0.30", refund: "2.0", operational: "4.00", vat: "23" });
  const [health, setHealth] = useState({ excellent: "30", minimum: "15", loss: "0" });
  const [pricesIncludeVat, setPricesIncludeVat] = useState(true);
  const [scenarioName, setScenarioName] = useState("Base case");
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [activeScenario, setActiveScenario] = useState<number | null>(null);
  const [showFormulas, setShowFormulas] = useState(false);
  const [notice, setNotice] = useState("");
  const [pricingBands, setPricingBands] = useState<PricingBandRule[] | null>(initialPricingBands ?? null);
  const [pricingBandsLoading, setPricingBandsLoading] = useState(!initialPricingBands);
  const [pricingBandsError, setPricingBandsError] = useState("");
  const [targetMargin, setTargetMargin] = useState("25");
  const [minimumProfit, setMinimumProfit] = useState("2.00");
  const [previewRetailRounding, setPreviewRetailRounding] = useState(false);

  const loadPricingBands = () => {
    setPricingBandsLoading(true);
    setPricingBandsError("");
    apiRequest<{ data: PricingBandRule[] }>("/admin/commercial-profit/pricing-bands")
      .then((response) => {
        if (!Array.isArray(response.data)) throw new Error("Pricing bands response was invalid.");
        setPricingBands(response.data);
      })
      .catch((error: unknown) => {
        setPricingBands(null);
        setPricingBandsError(error instanceof Error ? error.message : "Active pricing bands could not be loaded.");
      })
      .finally(() => setPricingBandsLoading(false));
  };

  useEffect(() => {
    if (!initialPricingBands) loadPricingBands();
  }, [initialPricingBands]);

  const input = useMemo<ProfitOrderInput>(() => ({
    lines: (orderMode === "single" ? lines.slice(0, 1) : lines).map((line) => ({
      id: line.id, name: line.name, pricingBandReference: line.sku,
      supplierUnitCostCents: money(line.cost), quantity: Math.max(1, Number(line.quantity) || 1),
      sellingUnitPriceCents: money(line.price), discountBasisPoints: percent(line.discount), fixedDiscountCents: money(line.fixedDiscount),
    })),
    supplierFreightCents: money(assumptions.supplierFreight), customerShippingCents: money(assumptions.shipping),
    packagingCents: money(assumptions.packaging), fxReserveBasisPoints: percent(assumptions.fx),
    paymentFeeBasisPoints: percent(assumptions.payment), paymentFixedFeeCents: money(assumptions.fixedPayment),
    refundReserveBasisPoints: percent(assumptions.refund), operationalReserveCents: money(assumptions.operational),
    vatBasisPoints: percent(assumptions.vat), pricesIncludeVat,
    health: { excellentMarginBasisPoints: percent(health.excellent), minimumMarginBasisPoints: percent(health.minimum), lossMarginBasisPoints: signedPercent(health.loss) },
  }), [assumptions, health, lines, orderMode, pricesIncludeVat]);

  const result = useMemo(() => {
    try { return simulateCommercialProfit(input); } catch { return null; }
  }, [input]);

  const firstLine = lines[0];
  const comparisonInput = useMemo<ProfitOrderInput>(() => ({
    ...input,
    lines: [{
      ...(input.lines[0] ?? {
        id: firstLine?.id ?? "line-1",
        name: firstLine?.name ?? "First product line",
        pricingBandReference: firstLine?.sku ?? "",
        supplierUnitCostCents: 0,
        quantity: 1,
        sellingUnitPriceCents: 0,
        discountBasisPoints: 0,
        fixedDiscountCents: 0,
      }),
      quantity: 1,
    }],
  }), [input, firstLine]);
  const strategyComparison = useMemo<{
    rows: PricingStrategyComparison[];
    focused: PricingStrategyComparison | null;
    error: string;
  }>(() => {
    if (!pricingBands?.length || !comparisonInput.lines.length) return { rows: [], focused: null, error: "" };
    try {
      const margin = parsePercentToBasisPoints(targetMargin);
      const profit = parseMoneyToCents(minimumProfit);
      const lineId = comparisonInput.lines[0].id;
      const rows = ["2", "5", "10", "20", "50", "75", "100"].map((cost) =>
        comparePricingStrategy(comparisonInput, lineId, parseMoneyToCents(cost), pricingBands, margin, profit));
      const focused = comparePricingStrategy(
        comparisonInput,
        lineId,
        comparisonInput.lines[0].supplierUnitCostCents,
        pricingBands,
        margin,
        profit,
      );
      return { rows, focused, error: "" };
    } catch (error) {
      return { rows: [], focused: null, error: error instanceof Error ? error.message : "Pricing strategy comparison could not be calculated." };
    }
  }, [comparisonInput, minimumProfit, pricingBands, targetMargin]);
  const comparisonRows = strategyComparison.rows;
  const focusedComparison = strategyComparison.focused;

  const updateLine = (id: string, key: keyof LineDraft, value: string) => setLines((current) => current.map((line) => line.id === id ? { ...line, [key]: value } : line));
  const updateAssumption = (key: keyof typeof assumptions, value: string) => setAssumptions((current) => ({ ...current, [key]: value }));
  const addLine = () => setLines((current) => [...current, { id: `line-${Date.now()}`, name: "New merchandise line", sku: "", cost: "0.00", quantity: "1", price: "0.00", discount: "0", fixedDiscount: "0" }]);
  const removeLine = (id: string) => setLines((current) => current.length > 1 ? current.filter((line) => line.id !== id) : current);
  const applyPreset = (preset: keyof typeof presets) => setAssumptions((current) => ({ ...current, ...presets[preset] }));
  const saveScenario = () => {
    if (!result || !scenarioName.trim()) return;
    const id = Date.now();
    setScenarios((current) => [...current, { id, name: scenarioName.trim(), input, result }]);
    setActiveScenario(id);
    setNotice(`Saved “${scenarioName.trim()}” to this session.`);
  };
  const restoreScenario = (scenario: Scenario) => {
    setLines(scenario.input.lines.map((line) => ({ id: line.id, name: line.name, sku: line.pricingBandReference ?? "", cost: (line.supplierUnitCostCents / 100).toFixed(2), quantity: String(line.quantity), price: (line.sellingUnitPriceCents / 100).toFixed(2), discount: (line.discountBasisPoints / 100).toFixed(2), fixedDiscount: (line.fixedDiscountCents / 100).toFixed(2) })));
    setAssumptions({ supplierFreight: (scenario.input.supplierFreightCents / 100).toFixed(2), shipping: (scenario.input.customerShippingCents / 100).toFixed(2), packaging: (scenario.input.packagingCents / 100).toFixed(2), fx: (scenario.input.fxReserveBasisPoints / 100).toFixed(2), payment: (scenario.input.paymentFeeBasisPoints / 100).toFixed(2), fixedPayment: (scenario.input.paymentFixedFeeCents / 100).toFixed(2), refund: (scenario.input.refundReserveBasisPoints / 100).toFixed(2), operational: (scenario.input.operationalReserveCents / 100).toFixed(2), vat: (scenario.input.vatBasisPoints / 100).toFixed(2) });
    setOrderMode(scenario.input.lines.length > 1 ? "multi" : "single");
    setPricesIncludeVat(scenario.input.pricesIncludeVat);
    setHealth({ excellent: (scenario.input.health.excellentMarginBasisPoints / 100).toFixed(2), minimum: (scenario.input.health.minimumMarginBasisPoints / 100).toFixed(2), loss: (scenario.input.health.lossMarginBasisPoints / 100).toFixed(2) });
    setNotice(`Restored “${scenario.name}”.`);
  };

  return <div className="admin-page commercial-profit-page">
    <AdminPageHeader eyebrow="Lizzor intelligence / Phase 2A" title="Commercial profit simulator" description="A private decision cockpit for explainable order economics. Nothing here touches live commerce." actions={<span className="commercial-session-pill"><span />Session only</span>} />
    <div className="commercial-intro"><div><span className="eyebrow">Decision surface</span><h2>Know the order before you ship it.</h2><p>Model one order or a mixed basket with the same cost logic used to explain the decision. Change an assumption and the answer moves immediately.</p></div><div className="commercial-intro__stamp"><Icon name="shield-check" size={18} /><span>Local calculation<br /><b>No data leaves this screen</b></span></div></div>
    {notice && <AdminNotice tone="success" title="Scenario updated">{notice}</AdminNotice>}
    <div className="commercial-layout">
      <main className="commercial-workspace">
        <AdminPanel eyebrow="Merchandise" title="Order lines" description="Edit the sell price and landed cost basis for each line. Freight and order costs are allocated below." actions={<div className="commercial-mode-switch" role="group" aria-label="Order mode"><button type="button" className={orderMode === "single" ? "is-active" : ""} onClick={() => setOrderMode("single")}>Single product</button><button type="button" className={orderMode === "multi" ? "is-active" : ""} onClick={() => setOrderMode("multi")}>Multi-product</button></div>}>
          <div className="commercial-lines">
            <div className="commercial-lines__header"><span>Item</span><span>Supplier cost</span><span>Qty</span><span>Sell price</span><span>Discount / fixed</span><span /></div>
            {(orderMode === "single" ? lines.slice(0, 1) : lines).map((line, index) => <div className="commercial-line" key={line.id}>
              <div className="commercial-line__identity"><span className="commercial-line__index">{String(index + 1).padStart(2, "0")}</span><div><input value={line.name} onChange={field((v) => updateLine(line.id, "name", v))} aria-label={`Line ${index + 1} name`} /><input className="commercial-band-input" value={line.sku} onChange={field((v) => updateLine(line.id, "sku", v))} aria-label={`${line.name} pricing band reference`} placeholder="Pricing-band reference (optional)" /></div></div>
              <input className="money-input" value={line.cost} onChange={field((v) => updateLine(line.id, "cost", v))} aria-label={`${line.name} supplier cost`} inputMode="decimal" />
              <input className="quantity-input" value={line.quantity} onChange={field((v) => updateLine(line.id, "quantity", v))} aria-label={`${line.name} quantity`} inputMode="numeric" />
              <input className="money-input" value={line.price} onChange={field((v) => updateLine(line.id, "price", v))} aria-label={`${line.name} sell price`} inputMode="decimal" />
              <div className="commercial-discount"><div><input value={line.discount} onChange={field((v) => updateLine(line.id, "discount", v))} aria-label={`${line.name} percentage discount`} inputMode="decimal" /><span>%</span></div><div><span>€</span><input value={line.fixedDiscount} onChange={field((v) => updateLine(line.id, "fixedDiscount", v))} aria-label={`${line.name} fixed discount`} inputMode="decimal" /></div></div>
              <button className="icon-button commercial-remove" type="button" onClick={() => removeLine(line.id)} aria-label={`Remove ${line.name}`}><Icon name="trash-2" size={16} /></button>
            </div>)}
          </div>
          {orderMode === "multi" && <button type="button" className="button button--quiet button--small commercial-add-line" onClick={addLine}><Icon name="plus" size={14} /> Add merchandise line</button>}
        </AdminPanel>

        <AdminPanel eyebrow="Order assumptions" title="Cost and tax controls" description="These reserves stay explicit so the output is easy to challenge and explain.">
          <div className="commercial-preset-row"><span>Worked-cost preset</span>{(["standard", "crossBorder", "lean"] as const).map((key) => <button type="button" key={key} className="commercial-preset" onClick={() => applyPreset(key)}>{key === "crossBorder" ? "Cross-border" : key === "standard" ? "Standard" : "Lean"} <Icon name="arrow-right" size={12} /></button>)}</div>
          <div className="commercial-fields-grid">
            {([["supplierFreight", "Supplier freight"], ["shipping", "Customer shipping"], ["packaging", "Packaging"], ["operational", "Operational reserve"], ["fixedPayment", "Payment fixed fee"]] as const).map(([key, label]) => <AdminField key={key} label={label} htmlFor={`assumption-${key}`}><div className="commercial-input-wrap"><span>€</span><input id={`assumption-${key}`} value={assumptions[key]} onChange={field((v) => updateAssumption(key, v))} inputMode="decimal" /></div></AdminField>)}
            {([["fx", "FX reserve"], ["payment", "Payment fee"], ["refund", "Refund reserve"], ["vat", "VAT rate"]] as const).map(([key, label]) => <AdminField key={key} label={label} htmlFor={`assumption-${key}`}><div className="commercial-input-wrap"><input id={`assumption-${key}`} value={assumptions[key]} onChange={field((v) => updateAssumption(key, v))} inputMode="decimal" /><span>%</span></div></AdminField>)}
          </div>
          <label className="commercial-toggle"><input type="checkbox" checked={pricesIncludeVat} onChange={(event) => setPricesIncludeVat(event.target.checked)} /><span className="commercial-toggle__track" /><span><b>Prices include VAT</b><small>Use VAT-inclusive customer pricing for the calculation.</small></span></label>
          <div className="commercial-health"><div><span className="eyebrow">Health thresholds</span><p>Set the boundaries that classify this decision. No recommendation is assumed.</p></div><div className="commercial-health__fields">{([["excellent", "Healthy from"], ["minimum", "Warning below"], ["loss", "Loss at or below"]] as const).map(([key, label]) => <AdminField key={key} label={label}><div className="commercial-input-wrap"><input value={health[key]} onChange={field((v) => setHealth((current) => ({ ...current, [key]: v })))} inputMode="decimal" /><span>%</span></div></AdminField>)}</div></div>
        </AdminPanel>

         <AdminPanel eyebrow="Phase 2A.1" title="Pricing strategy comparison" description="Read-only production bands, compared against simulation-only commercial floors. Change any assumption and every result recalculates immediately." className="commercial-pricing-strategy">
           <div className="commercial-strategy-notice"><Icon name="shield-check" size={15} /><span><strong>Production bands are read-only.</strong> Target margin and minimum contribution profit below are simulation-only inputs, not production policy.</span></div>
           {pricingBandsLoading && <LoadingState label="Loading active pricing bands…" />}
           {!pricingBandsLoading && pricingBandsError && <ErrorState title="Pricing bands unavailable" description={`${pricingBandsError} No comparison is shown until live bands load successfully.`} onRetry={loadPricingBands} />}
           {!pricingBandsLoading && !pricingBandsError && !pricingBands?.length && <ErrorState title="No active pricing bands" description="No comparison is shown because no live pricing band rules were returned." onRetry={loadPricingBands} />}
           {!pricingBandsLoading && !pricingBandsError && pricingBands && pricingBands.length > 0 && <>
             <div className="commercial-strategy-controls">
               <AdminField label="Target contribution margin (simulation only)" htmlFor="target-margin" hint="Not production policy"><div className="commercial-input-wrap"><input id="target-margin" value={targetMargin} onChange={field(setTargetMargin)} inputMode="decimal" /><span>%</span></div></AdminField>
               <AdminField label="Minimum contribution profit (simulation only)" htmlFor="minimum-profit" hint="Not production policy"><div className="commercial-input-wrap"><span>€</span><input id="minimum-profit" value={minimumProfit} onChange={field(setMinimumProfit)} inputMode="decimal" /></div></AdminField>
               <label className="commercial-toggle commercial-toggle--strategy"><input type="checkbox" checked={previewRetailRounding} onChange={(event) => setPreviewRetailRounding(event.target.checked)} /><span className="commercial-toggle__track" /><span><b>Preview retail rounding</b><small>Shows .99 as a separate preview only.</small></span></label>
             </div>
              {strategyComparison.error && <ErrorState title="Comparison unavailable" description={strategyComparison.error} />}
             {focusedComparison && <div className="commercial-strategy-cards">
               {[
                 ["Current pricing-band price", focusedComparison.currentBandPriceCents, `Band: ${focusedComparison.bandName}`],
                 ["Minimum margin price", focusedComparison.marginFloor.sellingUnitPriceCents, `Floor: ${targetMargin}% contribution margin`],
                 ["Minimum profit price", focusedComparison.profitFloor.sellingUnitPriceCents, `Floor: ${formatMoney(money(minimumProfit))} contribution profit`],
               ].map(([label, value, detail]) => <article key={String(label)} className="commercial-strategy-card"><span className="eyebrow">{String(label)}</span><strong>{formatMoney(Number(value))}</strong><small>{String(detail)}</small></article>)}
             </div>}
             {focusedComparison && <div className="commercial-required-price"><div><span className="eyebrow">Required commercial price</span><strong>{formatMoney(focusedComparison.requiredCommercialPriceCents)}</strong>{previewRetailRounding && <small>Retail preview: {formatMoney(focusedComparison.retailRoundedPriceCents)} · exact commercial price remains primary</small>}</div><div><span>Binding constraint</span><b>{focusedComparison.bindingConstraints.join(" + ")}</b></div></div>}
             <div className="commercial-strategy-matrix-wrap"><table className="commercial-strategy-matrix"><thead><tr><th>Supplier cost</th><th>Current band</th><th>Current price</th><th>Current contribution</th><th>Current margin</th><th>Margin-floor</th><th>Profit-floor</th><th>Required commercial</th><th>Binding constraint</th><th>Difference EUR</th><th>Difference %</th></tr></thead><tbody>{comparisonRows.map((row) => <tr key={row.supplierCostCents}><td>{formatMoney(row.supplierCostCents)}</td><td>{row.bandName}</td><td>{formatMoney(row.currentBandPriceCents)}</td><td className={row.currentSimulation.contributionProfitCents < 0 ? "is-negative" : "is-positive"}>{formatMoney(row.currentSimulation.contributionProfitCents)}</td><td>{formatPercent(row.currentSimulation.contributionMarginBasisPoints)}</td><td>{formatMoney(row.marginFloor.sellingUnitPriceCents)}</td><td>{formatMoney(row.profitFloor.sellingUnitPriceCents)}</td><td><strong>{formatMoney(row.requiredCommercialPriceCents)}</strong></td><td>{row.bindingConstraints.join(" + ")}</td><td>{formatMoney(row.differenceCents)}</td><td>{formatPercent(row.differenceBasisPoints)}</td></tr>)}</tbody></table></div>
           </>}
         </AdminPanel>

        <AdminPanel eyebrow="Line economics" title="Contribution by merchandise line" description="Order-level costs are distributed transparently using the calculator’s revenue and cost weights.">
          {result && <div className="commercial-table-wrap"><table className="commercial-table"><thead><tr><th>Line</th><th>Revenue ex VAT</th><th>Merchandise cost</th><th>Freight</th><th>Order costs</th><th>Contribution</th></tr></thead><tbody>{result.lines.map((line) => <tr key={line.id}><td><strong>{line.name}</strong>{line.pricingBandReference && <small className="commercial-band-display">{line.pricingBandReference}</small>}<small>{line.quantity} units</small></td><td>{formatMoney(line.allocatedRevenueExVatCents)}</td><td>{formatMoney(line.supplierMerchandiseCostCents)}</td><td>{formatMoney(line.allocatedFreightCents)}</td><td>{formatMoney(line.allocatedOrderCostsCents)}</td><td className={line.contributionProfitCents < 0 ? "is-negative" : "is-positive"}>{formatMoney(line.contributionProfitCents)}</td></tr>)}</tbody></table></div>}
        </AdminPanel>
      </main>

      <aside className="commercial-output">
        <div className={`commercial-result commercial-result--${result?.health.toLowerCase() ?? "loss"}`}>
           <div className="commercial-result__top"><span className="eyebrow">Live result</span>{result && <StatusBadge status={result.health} tone={result.health === "Healthy" ? "positive" : result.health === "Warning" ? "warning" : "negative"} />}</div>
          <strong className="commercial-result__profit">{result ? formatMoney(result.contributionProfitCents) : "—"}</strong><span className="commercial-result__label">Contribution profit</span>
           {result && <small className="commercial-result__health-detail">{result.healthDetail}</small>}
          <div className="commercial-result__margin"><span>Contribution margin</span><b>{result ? formatPercent(result.contributionMarginBasisPoints) : "—"}</b></div>
          <div className="commercial-meter"><span style={{ width: `${Math.max(0, Math.min(100, ((result?.contributionMarginBasisPoints ?? 0) * 100) / Math.max(1, input.health.excellentMarginBasisPoints)))}%` }} /></div>
          <div className="commercial-result__grid"><div><span>Customer charge</span><b>{result ? formatMoney(result.customerChargeCents) : "—"}</b></div><div><span>Revenue ex VAT</span><b>{result ? formatMoney(result.revenueExVatCents) : "—"}</b></div><div><span>Commercial cost</span><b>{result ? formatMoney(result.totalCommercialCostCents) : "—"}</b></div><div><span>VAT amount</span><b>{result ? formatMoney(result.vatAmountCents) : "—"}</b></div></div>
        </div>
        {result && <AdminPanel eyebrow="Transparent result" title="Commercial breakdown" description="VAT, revenue, and every reserve remain separate.">
          <dl className="commercial-breakdown">
            {[
              ["Customer merchandise revenue", result.customerMerchandiseRevenueCents],
              ["Customer shipping revenue", result.customerShippingRevenueCents],
              ["VAT amount", result.vatAmountCents],
              ["Revenue excluding VAT", result.revenueExVatCents],
              ["Supplier merchandise cost", result.supplierMerchandiseCostCents],
              ["Supplier freight", result.supplierFreightCents],
              ["Packaging / handling", result.packagingCents],
              ["Payment processing", result.paymentProcessingCostCents],
              ["Refund reserve", result.refundReserveCents],
              ["FX reserve", result.fxReserveCents],
              ["Operational reserve", result.operationalReserveCents],
              ["Total commercial cost", result.totalCommercialCostCents],
              ["Profit per order", result.contributionProfitCents],
            ].map(([label, value]) => <div key={String(label)}><dt>{label}</dt><dd>{formatMoney(Number(value))}</dd></div>)}
            <div><dt>Contribution margin</dt><dd>{formatPercent(result.contributionMarginBasisPoints)}</dd></div>
          </dl>
        </AdminPanel>}
        <AdminPanel eyebrow="Quick sensitivity" title="Supplier unit cost" description="Populate the first line to pressure-test the current case. All other inputs stay unchanged.">
          <div className="commercial-cost-buttons">{["2", "5", "10", "20", "50", "75", "100"].map((value) => <button type="button" key={value} onClick={() => updateLine(lines[0].id, "cost", `${value}.00`)}><span>€</span>{value}</button>)}</div>
        </AdminPanel>
        <AdminPanel eyebrow="Scenario desk" title="Keep a decision trail" description="Scenarios are temporary and disappear when this session ends.">
          <div className="commercial-save"><input value={scenarioName} onChange={(event) => setScenarioName(event.target.value)} aria-label="Scenario name" placeholder="Scenario name" /><button className="button button--dark button--small" type="button" onClick={saveScenario} disabled={!result}>Save</button></div>
          {scenarios.length ? <><div className="commercial-scenarios">{scenarios.map((scenario) => <div className={`commercial-scenario ${activeScenario === scenario.id ? "is-active" : ""}`} key={scenario.id}><button type="button" onClick={() => restoreScenario(scenario)}><span>{scenario.name}</span><small>{formatMoney(scenario.result.contributionProfitCents)} · {formatPercent(scenario.result.contributionMarginBasisPoints)}</small></button><button type="button" onClick={() => setScenarios((current) => current.filter((item) => item.id !== scenario.id))} aria-label={`Delete ${scenario.name}`}><Icon name="x" size={14} /></button></div>)}</div><div className="commercial-compare"><span className="eyebrow">Side-by-side</span><div className="commercial-compare__head"><span>Metric</span><b>Live</b>{scenarios.slice(-2).map((scenario) => <b key={scenario.id}>{scenario.name}</b>)}</div>{[["Contribution profit", (value: ProfitSimulationResult) => formatMoney(value.contributionProfitCents)], ["Margin", (value: ProfitSimulationResult) => formatPercent(value.contributionMarginBasisPoints)], ["Customer charge", (value: ProfitSimulationResult) => formatMoney(value.customerChargeCents)]].map(([label, formatter]) => <div className="commercial-compare__row" key={String(label)}><span>{String(label)}</span><b>{result ? (formatter as (value: ProfitSimulationResult) => string)(result) : "—"}</b>{scenarios.slice(-2).map((scenario) => <b key={scenario.id}>{(formatter as (value: ProfitSimulationResult) => string)(scenario.result)}</b>)}</div>)}</div></> : <p className="commercial-empty">Save a case to compare the effect of a pricing or cost decision.</p>}
        </AdminPanel>
        <button className="commercial-formula-toggle" type="button" onClick={() => setShowFormulas((value) => !value)}><span><Icon name="circle-help" size={16} /> Explain this result</span><Icon name="chevron-down" size={15} /></button>
        {showFormulas && result && <div className="commercial-formulas">{Object.entries(result.formulas).map(([key, formula]) => <div key={key}><span>{key}</span><p>{formula}</p></div>)}</div>}
        <FormActions><span className="commercial-session-note"><Icon name="shield-check" size={13} /> No persistence by design</span></FormActions>
      </aside>
    </div>
  </div>;
}