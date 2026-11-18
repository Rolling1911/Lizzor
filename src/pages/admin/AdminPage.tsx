import { useCallback, useEffect, useState } from "react";
import { apiRequest } from "../../auth/api";
import { Icon, type IconName } from "../../components/ui/Icon";
import {
  AdminPageHeader,
  ChartContainer,
  DateRangeSelector,
  EmptyState,
  ErrorState,
  KpiCard,
  LoadingState,
  PermissionGate,
} from "../../components/admin/AdminPrimitives";
import type { NavigationItem, PlaceholderPage } from "../../../shared/types";

interface DashboardData {
  metrics: {
    revenue: { value: number; currency: string };
    orders: number;
    unitsSold: number;
    customers: number;
    companies: number;
    averageOrderValue: number;
    excludedCurrencyOrders: number;
    returns: number;
    lowStock: number;
    outOfStock: number;
    availableStock: number;
  };
  profitability: {
    status: "incomplete";
    message: string;
    estimatedProfit: null;
    unavailableSources: string[];
  };
  sections: {
    revenueTrend: Array<{ day: string; orders: number; revenue: number }>;
    recentAdminActivity: Array<{ action: string; entityType: string; createdAt: string }>;
  };
}

interface AdminPageProps {
  page: PlaceholderPage;
  route: NavigationItem;
  isDashboard: boolean;
  allowed: boolean;
}

const sectionStates = [
  ["Sales by country", "Country-level sales will appear after orders are recorded.", "chart-no-axes-combined"],
  ["Sales by category", "Category performance will appear after product sales are recorded.", "chart-no-axes-combined"],
  ["Top products", "No products have sales in this date range.", "package"],
  ["Recent orders", "No orders yet.", "package"],
  ["Low-stock products", "No low-stock products need attention.", "warehouse"],
  ["Recent customers", "No customers joined in this date range.", "users"],
  ["Returns & refunds", "No returns or refunds in this date range.", "receipt-text"],
] as const;

function euro(value: number): string {
  return new Intl.NumberFormat("en", { style: "currency", currency: "EUR", maximumFractionDigits: 2 }).format(value);
}

function Dashboard() {
  const [range, setRange] = useState("30d");
  const [customStart, setCustomStart] = useState(() => {
    const date = new Date();
    date.setUTCDate(date.getUTCDate() - 30);
    return date.toISOString().slice(0, 10);
  });
  const [customEnd, setCustomEnd] = useState(() => new Date().toISOString().slice(0, 10));
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState(false);

  const load = useCallback(async () => {
    setError(false);
    setData(null);
    try {
      const customQuery = range === "custom"
        ? `&start=${encodeURIComponent(new Date(`${customStart}T00:00:00.000Z`).toISOString())}&end=${encodeURIComponent(new Date(`${customEnd}T23:59:59.999Z`).toISOString())}`
        : "";
      const response = await apiRequest<{ data: DashboardData }>(`/admin/dashboard?range=${range}${customQuery}`);
      setData(response.data);
    } catch {
      setError(true);
    }
  }, [customEnd, customStart, range]);

  useEffect(() => { void load(); }, [load]);

  return <>
    <div className="admin-dashboard__controls">
      <div><span className="eyebrow">Reporting period</span><p>All values come from the live Lizzor database.</p></div>
      <DateRangeSelector value={range} onChange={setRange} customStart={customStart} customEnd={customEnd} onCustomStartChange={setCustomStart} onCustomEndChange={setCustomEnd} />
    </div>
    {error ? <ErrorState onRetry={() => void load()} /> :
      !data ? <LoadingState label="Loading live dashboard data…" /> :
      <>
        <section className="admin-kpi-grid" aria-label="Key performance indicators">
          <KpiCard label="Revenue" value={euro(data.metrics.revenue.value)} detail="Recorded EUR order total" tone="accent" />
          <KpiCard label="Orders" value={String(data.metrics.orders)} detail={data.metrics.excludedCurrencyOrders ? `${data.metrics.excludedCurrencyOrders} non-EUR excluded` : "Non-cancelled EUR orders"} />
          <KpiCard label="Units sold" value={String(data.metrics.unitsSold)} />
          <KpiCard label="Customers" value={String(data.metrics.customers)} detail={`${data.metrics.companies} companies`} />
          <KpiCard label="Average order value" value={euro(data.metrics.averageOrderValue)} />
          <KpiCard label="Gross profit" value="Incomplete" detail="Not all cost sources exist" tone="quiet" />
          <KpiCard label="Gross margin" value="Incomplete" detail="Awaiting complete costs" tone="quiet" />
          <KpiCard label="Returns" value={String(data.metrics.returns)} />
          <KpiCard label="Low stock" value={String(data.metrics.lowStock)} />
          <KpiCard label="Out of stock" value={String(data.metrics.outOfStock)} />
          <KpiCard label="Available stock" value={data.metrics.availableStock.toLocaleString()} />
        </section>

        <section className="admin-profitability">
          <div className="admin-profitability__icon"><Icon name="circle-help" size={19} /></div>
          <div><span className="eyebrow">Profitability status</span><h2>Estimated profit is not available yet</h2><p>{data.profitability.message}</p></div>
          <div className="admin-profitability__sources"><span>Missing sources</span><strong>{data.profitability.unavailableSources.join(", ")}</strong></div>
        </section>

        <div className="admin-dashboard-grid">
          <ChartContainer title="Revenue & orders trend" detail={`${data.sections.revenueTrend.length} recorded days`}>
            {data.sections.revenueTrend.length ? <div className="admin-trend-list">{data.sections.revenueTrend.map((point) => <div key={point.day}><time>{point.day}</time><span>{point.orders} orders</span><strong>{euro(point.revenue)}</strong></div>)}</div> : <EmptyState title="No revenue yet" description="Revenue and order trends will appear when orders are recorded." icon="chart-no-axes-combined" />}
          </ChartContainer>
          <section className="admin-panel"><div className="admin-panel__heading"><div><span className="eyebrow">Security & operations</span><h2>Recent admin activity</h2></div></div>
            {data.sections.recentAdminActivity.length ? <div className="admin-activity-list">{data.sections.recentAdminActivity.map((item, index) => <div key={`${item.createdAt}-${index}`}><span className="status-dot" /><div><strong>{item.action.replaceAll(".", " ")}</strong><span>{item.entityType}</span></div><time>{new Date(item.createdAt).toLocaleString()}</time></div>)}</div> : <EmptyState title="No admin activity yet" description="Security and administration events will appear here." />}
          </section>
        </div>
        <section className="admin-section"><div className="admin-section__heading"><div><span className="eyebrow">Operational views</span><h2>Business activity</h2></div><span className="section-note">Live database state</span></div>
          <div className="admin-empty-grid">{sectionStates.map(([title, description, icon]) => <EmptyState key={title} title={title} description={description} icon={icon} />)}</div>
        </section>
      </>}
  </>;
}

export function AdminPage({ page, route, isDashboard, allowed }: AdminPageProps) {
  return <PermissionGate allowed={allowed} fallback={<div className="admin-page"><AdminPageHeader eyebrow="Access control" title="Permission required" description={`You need ${route.permission} to open this workspace.`} /><ErrorState title="This area is restricted" description="Ask an administrator to update your role. Frontend navigation is hidden for convenience; the server remains authoritative." /></div>}>
    <div className="admin-page">
      <AdminPageHeader eyebrow={page.eyebrow} title={page.title} description={page.description} actions={<span className="foundation-chip"><span className="status-dot" /> Admin workspace</span>} />
      {isDashboard ? <Dashboard /> : <section className="admin-module-empty">
        <div className="admin-module-empty__icon"><Icon name={route.icon as IconName} size={22} /></div>
         <div><span className="eyebrow">Workspace</span><h2>{route.label}</h2><p>This workspace is part of the protected Lizzor Admin shell. Records and actions depend on the connected data source.</p></div>
         <dl><div><dt>Required permission</dt><dd>{route.permission}</dd></div><div><dt>Current state</dt><dd>Empty · no records available</dd></div></dl>
      </section>}
    </div>
  </PermissionGate>;
}