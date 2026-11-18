import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { apiRequest } from "../../../auth/api";
import { AdminPageHeader, ChartContainer, DateRangeSelector, EmptyState, ErrorState, KpiCard, LoadingState, Pagination, StatusBadge } from "../../../components/admin/AdminPrimitives";
import { Icon, type IconName } from "../../../components/ui/Icon";
import { useAuth } from "../../../auth/AuthContext";

type ReportName = "overview" | "sales" | "orders" | "products" | "customers" | "promotions" | "inventory" | "margin" | "fulfillment" | "returns";
type Props = { report?: ReportName };
type ReportResponse = { data: any };

const reportLinks: Array<{ key: ReportName; label: string; permission?: string }> = [
  { key: "overview", label: "Overview" },
  { key: "sales", label: "Sales" },
  { key: "orders", label: "Orders" },
  { key: "products", label: "Products" },
  { key: "customers", label: "Customers" },
  { key: "promotions", label: "Promotions" },
  { key: "inventory", label: "Inventory" },
  { key: "margin", label: "Product contribution", permission: "analytics.margin" },
  { key: "fulfillment", label: "Fulfillment" },
  { key: "returns", label: "Returns" },
];

function euro(value: unknown) {
  return new Intl.NumberFormat("en", { style: "currency", currency: "EUR", maximumFractionDigits: 2 }).format(Number(value ?? 0));
}

function dateValue(value: unknown) {
  return value ? new Date(String(value)).toLocaleDateString() : "—";
}

function tone(status: string): "neutral" | "positive" | "warning" | "negative" {
  if (["paid", "completed", "delivered", "fulfilled", "approved", "received"].includes(status)) return "positive";
  if (["pending", "processing", "in_review", "requested", "packed", "unfulfilled"].includes(status)) return "warning";
  if (["cancelled", "failed", "rejected"].includes(status)) return "negative";
  return "neutral";
}

function exportQuery(report: ReportName, range: string, start: string, end: string) {
  const query = new URLSearchParams({ report, range });
  if (range === "custom") { query.set("start", `${start}T00:00:00.000Z`); query.set("end", `${end}T23:59:59.999Z`); }
  return query;
}

function ExportButton({ report, range, start, end }: { report: ReportName; range: string; start: string; end: string }) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const onExport = async () => {
    setBusy(true); setError("");
    try {
      const response = await fetch(`/api/v1/admin/reports/export?${exportQuery(report, range, start, end)}`, { credentials: "include" });
      if (!response.ok) {
        let message = "The CSV export could not be created.";
        try { const payload = await response.json(); message = payload?.error?.message ?? message; } catch { /* non-JSON error */ }
        throw new Error(message);
      }
      const url = URL.createObjectURL(await response.blob());
      const anchor = document.createElement("a"); anchor.href = url; anchor.download = `${report}-report.csv`; anchor.click(); URL.revokeObjectURL(url);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "The CSV export could not be created."); }
    finally { setBusy(false); }
  };
  return <span className="analytics-export"><button className="button button--quiet button--small" onClick={() => void onExport()} disabled={busy}><Icon name="arrow-up-right" size={14} /> {busy ? "Preparing…" : "Export CSV"}</button>{error && <span className="analytics-export__error" role="alert">{error}</span>}</span>;
}

function Blank({ title, description, icon = "package" }: { title: string; description: string; icon?: IconName }) {
  return <EmptyState title={title} description={description} icon={icon} />;
}

function Filters({ range, setRange, customStart, customEnd, setCustomStart, setCustomEnd }: { range: string; setRange: (value: string) => void; customStart: string; customEnd: string; setCustomStart: (value: string) => void; setCustomEnd: (value: string) => void }) {
  return <div className="analytics-filters">
    <div><span className="eyebrow">Reporting period</span><p>Finalized EUR orders and historical snapshots only.</p></div>
    <DateRangeSelector value={range} onChange={setRange} customStart={customStart} customEnd={customEnd} onCustomStartChange={setCustomStart} onCustomEndChange={setCustomEnd} />
  </div>;
}

function Overview({ data }: { data: any }) {
  const m = data.metrics;
  return <>
    <section className="admin-kpi-grid analytics-kpis">
      <KpiCard label="Gross sales" value={euro(m.grossSales.value)} detail={m.grossSales.change === null ? "No prior comparison" : `${m.grossSales.change}% vs prior period`} tone="accent" />
      <KpiCard label="Net product sales" value={euro(m.netProductSales.value)} detail="After recorded promotions" />
      <KpiCard label="Collected" value={euro(m.collected.value)} detail="Historical order total" />
      <KpiCard label="Orders" value={String(m.orders.value)} detail={m.orders.change === null ? "Finalized EUR orders" : `${m.orders.change}% vs prior period`} />
      <KpiCard label="Average order value" value={euro(m.aov.value)} />
      <KpiCard label="Units sold" value={String(m.unitsSold)} />
      <KpiCard label="Discounts" value={euro(m.discounts)} />
      <KpiCard label="Shipping revenue" value={euro(m.shipping)} />
      <KpiCard label="VAT" value={euro(m.vat)} />
      <KpiCard label="New customers" value={String(m.newCustomers)} />
      <KpiCard label="Repeat customers" value={String(m.repeatCustomers)} detail={`${m.accountCustomers} account customers`} />
      <KpiCard label="Returns" value={String(m.returns)} detail={`${m.returnedItems} items requested`} />
    </section>
    <section className="analytics-definition"><Icon name="circle-help" size={16} /><div><strong>How to read this report</strong><p>{data.definitions.grossSales} {data.definitions.netProductSales} Tax and shipping remain separate from product sales. Profitability is not estimated when historical costs are incomplete.</p></div></section>
    <div className="admin-dashboard-grid">
      <ChartContainer title="Sales trend" detail={`${data.trend.length} recorded days`}>
        {data.trend.length ? <div className="analytics-trend">{data.trend.map((point: any) => <div key={point.day}><time>{point.day}</time><span>{point.orders} orders</span><strong>{euro(point.netSales)}</strong><small>{euro(point.collected)} collected</small></div>)}</div> : <EmptyState title="No finalized sales yet" description="The trend will populate when paid EUR orders are recorded." icon="chart-no-axes-combined" />}
      </ChartContainer>
      <ChartContainer title="Order status mix" detail="All EUR orders in range">
        {data.statuses.length ? <div className="analytics-status-list">{data.statuses.map((item: any) => <div key={item.status}><StatusBadge status={item.status} tone={tone(item.status)} /><strong>{item.count}</strong></div>)}</div> : <EmptyState title="No order activity" description="There are no orders in this period." icon="package" />}
      </ChartContainer>
    </div>
    <section className="admin-profitability"><div className="admin-profitability__icon"><Icon name="circle-help" size={19} /></div><div><span className="eyebrow">Profitability status</span><h2>Margin reporting is intentionally unavailable</h2><p>{data.profitability.message}</p></div><div className="admin-profitability__sources"><span>Boundary</span><strong>Never substitute current product cost for historical cost.</strong></div></section>
    <section className="analytics-definition"><Icon name="circle-help" size={16} /><div><strong>Storefront funnel and search analytics unavailable</strong><p>No privacy-safe first-party event stream is currently stored, so product-view, search, click, cart, and conversion rates are not inferred from server page hits.</p></div></section>
  </>;
}

function SalesReport({ data }: { data: any }) {
  return <><section className="admin-kpi-grid"><KpiCard label="Gross sales" value={euro(data.summary.grossSales)} tone="accent" /><KpiCard label="Net sales" value={euro(data.summary.netSales)} /><KpiCard label="Collected" value={euro(data.summary.collected)} /><KpiCard label="Refunds" value={euro(data.summary.refunds)} /><KpiCard label="Shipping" value={euro(data.summary.shipping)} /><KpiCard label="VAT" value={euro(data.summary.vat)} /><KpiCard label="Orders" value={String(data.summary.orders)} /><KpiCard label="AOV" value={euro(data.summary.aov)} /><KpiCard label="Discounts" value={euro(data.summary.discounts)} /></section><ChartContainer title="Sales by day" detail="Historical order snapshots"><div className="analytics-table"><div className="analytics-table__head"><span>Date</span><span>Orders</span><span>Gross</span><span>Net</span><span>Discounts</span></div>{data.trend.length ? data.trend.map((item: any) => <div className="analytics-table__row" key={item.day}><span>{item.day}</span><span>{item.orders}</span><span>{euro(item.grossSales)}</span><span>{euro(item.netSales)}</span><span>{euro(item.discounts)}</span></div>) : <Blank title="No sales in this period" description="There are no finalized EUR order snapshots to report." icon="chart-no-axes-combined" />}</div></ChartContainer><section className="admin-panel analytics-panel"><div className="admin-panel__heading"><div><span className="eyebrow">Geography</span><h2>Sales by country</h2></div></div>{data.countries?.length ? <div className="analytics-mini-list">{data.countries.map((item: any) => <div key={item.country}><span>{item.country}</span><strong>{item.orders} orders · {euro(item.collected)} collected</strong></div>)}</div> : <Blank title="No country sales" description="Country totals will appear when finalized orders have shipping addresses." icon="globe-2" />}</section></>;
}

function OrdersReport({ data }: { data: any }) {
  return <><div className="analytics-summary-grid">{[["Order status", data.statuses], ["Payment status", data.paymentStatuses], ["Fulfillment stage", data.fulfillmentStages]].map(([title, items]: any) => <section className="admin-panel" key={title}><div className="admin-panel__heading"><div><span className="eyebrow">Breakdown</span><h2>{title}</h2></div></div><div className="analytics-status-list">{items.map((item: any) => <div key={item.status}><StatusBadge status={item.status} tone={tone(item.status)} /><strong>{item.count}</strong></div>)}</div></section>)}</div><section className="admin-panel analytics-panel"><div className="admin-panel__heading"><div><span className="eyebrow">Drill-down</span><h2>Matching orders</h2></div><span className="section-note">Historical totals</span></div><div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>Order</th><th>Date</th><th>Customer</th><th>Status</th><th>Total</th></tr></thead><tbody>{data.items.map((item: any) => <tr key={item.id}><td><Link to={`/admin/orders/${item.id}`}>{item.orderNumber}</Link></td><td>{dateValue(item.createdAt)}</td><td>{item.customer ?? "Guest checkout"}</td><td><StatusBadge status={item.status} tone={tone(item.status)} /></td><td>{euro(item.total)}</td></tr>)}</tbody></table></div>{!data.items.length && <EmptyState title="No matching orders" description="Try a wider date range." icon="package" />}</section></>;
}

function ProductsReport({ data }: { data: any }) {
  return <><section className="admin-panel analytics-panel"><div className="admin-panel__heading"><div><span className="eyebrow">Ranked by recorded orders</span><h2>Product performance</h2></div></div><div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>Product</th><th>Units</th><th>Orders</th><th>Revenue</th><th>Avg price</th><th>Discounts</th></tr></thead><tbody>{data.items.map((item: any) => <tr key={item.productId}><td><strong>{item.productName}</strong><small className="table-subline">{item.sku}</small></td><td>{item.units}</td><td>{item.orders}</td><td>{euro(item.revenue)}</td><td>{euro(item.averageSellingPrice)}</td><td>{euro(item.discounts)}</td></tr>)}</tbody></table></div>{!data.items.length && <EmptyState title="No product sales" description="Product ranking requires finalized order items in the selected period." icon="package" />}</section><div className="analytics-summary-grid"><section className="admin-panel"><div className="admin-panel__heading"><div><span className="eyebrow">Current-catalog attribution</span><h2>Category sales</h2></div></div><div className="analytics-mini-list">{data.categories.map((item: any) => <div key={item.id}><span>{item.name}</span><strong>{euro(item.revenue)} · {item.units} units</strong></div>)}</div></section><section className="admin-panel"><div className="admin-panel__heading"><div><span className="eyebrow">Current-catalog attribution</span><h2>Brand sales</h2></div></div><div className="analytics-mini-list">{data.brands.map((item: any) => <div key={item.id}><span>{item.name}</span><strong>{euro(item.revenue)} · {item.units} units</strong></div>)}</div></section></div><p className="analytics-footnote">{data.note}</p><div className="analytics-summary-grid"><section className="admin-panel"><div className="admin-panel__heading"><div><span className="eyebrow">Inventory signal</span><h2>Low-stock products</h2></div></div><div className="analytics-mini-list">{data.lowStock.map((item: any) => <div key={item.productId}><span>{item.productName}</span><strong>{item.available} available</strong></div>)}</div>{!data.lowStock.length && <p className="section-note">No low-stock products recorded.</p>}</section><section className="admin-panel"><div className="admin-panel__heading"><div><span className="eyebrow">Catalog gap</span><h2>No-sales products</h2></div></div><div className="analytics-mini-list">{data.noSales.slice(0, 8).map((item: any) => <div key={item.productId}><span>{item.productName}</span><small>{item.sku}</small></div>)}</div>{!data.noSales.length && <p className="section-note">Every active published product has a sale in this period.</p>}</section></div></>;
}

function CustomersReport({ data }: { data: any }) {
  return <><section className="admin-panel analytics-panel"><div className="admin-panel__heading"><div><span className="eyebrow">Privacy-safe customer view</span><h2>Customer performance</h2></div></div><div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>Customer</th><th>Type</th><th>Orders</th><th>Revenue</th><th>AOV</th><th>Last order</th></tr></thead><tbody>{data.items.map((item: any) => <tr key={item.customerKey}><td>{item.customer}</td><td><StatusBadge status={item.type} tone="neutral" /></td><td>{item.orders}</td><td>{euro(item.revenue)}</td><td>{euro(item.averageOrderValue)}</td><td>{dateValue(item.lastOrderAt)}</td></tr>)}</tbody></table></div><p className="analytics-footnote">{data.privacy}</p>{!data.items.length && <EmptyState title="No customer activity" description="No finalized customer orders fall in this period." icon="users" />}</section><section className="admin-panel analytics-panel"><div className="admin-panel__heading"><div><span className="eyebrow">B2B accounts</span><h2>Company performance</h2></div></div><div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>Company</th><th>Orders</th><th>Revenue</th><th>AOV</th><th>Last order</th></tr></thead><tbody>{data.companies.map((item: any) => <tr key={item.id}><td>{item.companyName}</td><td>{item.orders}</td><td>{euro(item.revenue)}</td><td>{euro(item.averageOrderValue)}</td><td>{dateValue(item.lastOrderAt)}</td></tr>)}</tbody></table></div>{!data.companies.length && <EmptyState title="No company orders" description="No finalized company orders fall in this period." icon="users" />}</section></>;
}

function PromotionsReport({ data }: { data: any }) {
  return <section className="admin-panel analytics-panel"><div className="admin-panel__heading"><div><span className="eyebrow">Recorded influence</span><h2>Promotions & coupons</h2></div></div><div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>Promotion</th><th>Code</th><th>Uses</th><th>Customers</th><th>Gross value</th><th>Discount</th><th>Net sales</th><th>Remaining</th></tr></thead><tbody>{data.items.map((item: any) => <tr key={item.id}><td>{item.name}</td><td><code>{item.couponCode ?? "Automatic"}</code></td><td>{item.uses}</td><td>{item.customers}</td><td>{euro(item.grossValue)}</td><td>{euro(item.discount)}</td><td>{euro(item.netSales)}</td><td>{item.remainingUses ?? "Unlimited"}</td></tr>)}</tbody></table></div><p className="analytics-footnote">Influence is based on recorded promotion usage rows. This report does not claim incremental or causal revenue.</p>{!data.items.length && <EmptyState title="No promotion usage" description="Promotion usage will appear after eligible orders are completed." icon="receipt-text" />}</section>;
}

function InventoryReport({ data }: { data: any }) {
  return <><section className="admin-panel analytics-panel"><div className="admin-panel__heading"><div><span className="eyebrow">Current sellable stock</span><h2>Inventory status</h2></div></div>{data.items.length ? <div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>Product</th><th>Warehouse</th><th>On hand</th><th>Reserved</th><th>Available</th><th>Threshold</th></tr></thead><tbody>{data.items.map((item: any) => <tr key={item.id}><td>{item.productName ?? item.variantId ?? "Unlabelled SKU"}</td><td>{item.warehouse}</td><td>{item.onHand}</td><td>{item.reserved}</td><td><strong>{item.available}</strong></td><td>{item.threshold}</td></tr>)}</tbody></table></div> : <Blank title="No inventory records" description="No sellable stock records exist for this report." />}</section><section className="admin-panel analytics-panel"><div className="admin-panel__heading"><div><span className="eyebrow">Stock movement ledger</span><h2>Movement summary</h2></div></div>{data.movements.length ? <div className="analytics-mini-list">{data.movements.map((item: any) => <div key={item.type}><span>{item.type.replaceAll("_", " ")}</span><strong>{item.quantity} units · {item.movements} records</strong></div>)}</div> : <Blank title="No stock movements" description="No inventory movements were recorded in this period." />}</section></>;
}

function MarginReport({ data }: { data: any }) {
  return <><section className="admin-kpi-grid"><KpiCard label="Net product revenue" value={euro(data.summary.revenue)} tone="accent" /><KpiCard label="Historical product cost" value={euro(data.summary.productCost)} /><KpiCard label="Product contribution" value={euro(data.summary.productContribution)} /><KpiCard label="Contribution rate" value={`${data.summary.contributionPercent}%`} /><KpiCard label="Current sellable stock value" value={euro(data.summary.currentStockValue)} detail="Current cost basis, not historical margin" /></section><section className="analytics-definition"><Icon name="circle-help" size={16} /><div><strong>Restricted profitability boundary</strong><p>{data.definition}</p></div></section><section className="admin-panel analytics-panel"><div className="admin-panel__heading"><div><span className="eyebrow">Immutable cost snapshots</span><h2>Contribution by product</h2></div></div><div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>Product</th><th>Revenue</th><th>Product cost</th><th>Contribution</th><th>Rate</th></tr></thead><tbody>{data.items.map((item: any) => <tr key={item.productId}><td>{item.productName}</td><td>{euro(item.revenue)}</td><td>{euro(item.productCost)}</td><td>{euro(item.productContribution)}</td><td>{item.contributionPercent}%</td></tr>)}</tbody></table></div></section></>;
}

function FulfillmentReport({ data }: { data: any }) {
  return <><div className="analytics-summary-grid"><section className="admin-panel"><div className="admin-panel__heading"><div><span className="eyebrow">Queue</span><h2>Fulfillment stages</h2></div></div>{data.stages.length ? <div className="analytics-status-list">{data.stages.map((item: any) => <div key={item.stage}><StatusBadge status={item.stage} tone={tone(item.stage)} /><strong>{item.orders}</strong></div>)}</div> : <Blank title="No fulfillment activity" description="No shipments entered a fulfillment stage in this period." />}</section><section className="admin-panel"><div className="admin-panel__heading"><div><span className="eyebrow">Courier usage</span><h2>Shipments by courier</h2></div></div>{data.couriers.length ? <div className="analytics-mini-list">{data.couriers.map((item: any) => <div key={item.courier}><span>{item.courier}</span><strong>{item.orders} orders</strong></div>)}</div> : <Blank title="No courier shipments" description="No courier shipment records exist in this period." />}</section></div><section className="admin-kpi-grid"><KpiCard label="Avg hours to ship" value={data.timing.averageHoursToShip ? `${data.timing.averageHoursToShip}h` : "Unavailable"} /><KpiCard label="Avg transit hours" value={data.timing.averageHoursInTransit ? `${data.timing.averageHoursInTransit}h` : "Unavailable"} /></section><p className="analytics-footnote">{data.note}</p></>;
}

function ReturnsReport({ data }: { data: any }) {
  return <><section className="admin-kpi-grid"><KpiCard label="Requests" value={String(data.summary.requests)} tone="accent" /><KpiCard label="Items requested" value={String(data.summary.items)} /></section><div className="analytics-summary-grid"><section className="admin-panel"><div className="admin-panel__heading"><div><span className="eyebrow">Workflow</span><h2>Return statuses</h2></div></div>{data.statuses.length ? <div className="analytics-status-list">{data.statuses.map((item: any) => <div key={item.status}><StatusBadge status={item.status} tone={tone(item.status)} /><strong>{item.count}</strong></div>)}</div> : <Blank title="No return statuses" description="No return requests were recorded in this period." />}</section><section className="admin-panel"><div className="admin-panel__heading"><div><span className="eyebrow">Reasons</span><h2>Return reasons</h2></div></div>{data.reasons.length ? <div className="analytics-mini-list">{data.reasons.map((item: any) => <div key={item.reason}><span>{item.reason}</span><strong>{item.count}</strong></div>)}</div> : <Blank title="No return reasons" description="Reasons appear when return requests are submitted." />}</section></div><section className="admin-panel analytics-panel"><div className="admin-panel__heading"><div><span className="eyebrow">Product signal</span><h2>Products with return requests</h2></div></div>{data.products.length ? <div className="analytics-mini-list">{data.products.map((item: any) => <div key={item.productName}><span>{item.productName}</span><strong>{item.items} items</strong></div>)}</div> : <Blank title="No returned products" description="No products have return requests in this period." />}<p className="analytics-footnote">{data.note}</p></section></>;
}

export function AnalyticsPage({ report = "overview" }: Props) {
  const location = useLocation();
  const reportsMode = location.pathname.startsWith("/admin/reports");
  const { permissions } = useAuth();
  const [range, setRange] = useState("30d");
  const [customStart, setCustomStart] = useState(() => new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10));
  const [customEnd, setCustomEnd] = useState(() => new Date().toISOString().slice(0, 10));
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState("");
  const [page, setPage] = useState(1);
  const requestGeneration = useRef(0);
  const endpoint = useMemo(() => {
    const params = new URLSearchParams({ range });
    if (report === "orders") { params.set("page", String(page)); params.set("pageSize", "25"); }
    if (range === "custom") { params.set("start", `${customStart}T00:00:00.000Z`); params.set("end", `${customEnd}T23:59:59.999Z`); }
    return `/admin/analytics${report === "overview" ? "" : `/${report}`}?${params.toString()}`;
  }, [customEnd, customStart, page, range, report]);
  const load = useCallback(async (signal?: AbortSignal) => {
    const generation = ++requestGeneration.current;
    setData(null);
    setError("");
    try {
      const result = (await apiRequest<ReportResponse>(endpoint, { signal })).data;
      if (generation === requestGeneration.current) setData(result);
    } catch (reason) {
      if (generation === requestGeneration.current && !(reason instanceof DOMException && reason.name === "AbortError")) setError(reason instanceof Error ? reason.message : "The analytics report could not be loaded.");
    }
  }, [endpoint]);
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);
  useEffect(() => { setPage(1); }, [report, range, customStart, customEnd]);
  const title = report === "overview" ? "Analytics overview" : `${report[0]!.toUpperCase()}${report.slice(1)} report`;
  const reportContent = data && report === "overview" ? <Overview data={data} /> : data && report === "sales" ? <SalesReport data={data} /> : data && report === "orders" ? <OrdersReport data={data} /> : data && report === "products" ? <ProductsReport data={data} /> : data && report === "customers" ? <CustomersReport data={data} /> : data && report === "promotions" ? <PromotionsReport data={data} /> : data && report === "inventory" ? <InventoryReport data={data} /> : data && report === "margin" ? <MarginReport data={data} /> : data && report === "fulfillment" ? <FulfillmentReport data={data} /> : data && report === "returns" ? <ReturnsReport data={data} /> : null;
  return <div className="admin-page analytics-page">
    <AdminPageHeader eyebrow="Lizzor intelligence" title={title} description="Read-only business reporting from authoritative historical records." actions={<ExportButton report={report} range={range} start={customStart} end={customEnd} />} />
    <nav className="analytics-nav" aria-label="Analytics reports">{reportLinks.filter((item) => !item.permission || permissions.includes(item.permission)).map((item) => {
      const to = reportsMode
        ? item.key === "sales" ? "/admin/reports" : `/admin/reports/${item.key}`
        : item.key === "overview" ? "/admin/analytics" : `/admin/analytics/${item.key}`;
      return <Link key={item.key} className={item.key === report ? "is-active" : ""} to={to}>{item.label}</Link>;
    })}</nav>
    <Filters range={range} setRange={setRange} customStart={customStart} customEnd={customEnd} setCustomStart={setCustomStart} setCustomEnd={setCustomEnd} />
    {error ? <ErrorState description={error} onRetry={() => void load()} /> : !data ? <LoadingState label="Loading verified analytics…" /> : <>{reportContent}{data.meta && <Pagination page={data.meta.page} hasNext={data.meta.hasNext} onChange={setPage} />}</>}
  </div>;
}

export function ReportsPage() {
  return <AnalyticsPage report="sales" />;
}