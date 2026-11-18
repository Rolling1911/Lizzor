import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { apiRequest } from "../../../auth/api";
import { useAuth } from "../../../auth/AuthContext";
import { AdminPageHeader, EmptyState, ErrorState, KpiCard, LoadingState, Pagination, SearchInput, StatusBadge } from "../../../components/admin/AdminPrimitives";

const queueLabels: Record<string, { label: string; description: string; icon: "receipt-text" | "bell" | "package" | "warehouse" | "users" }> = {
  new_orders: { label: "New orders", description: "Orders awaiting confirmation or payment.", icon: "receipt-text" },
  payment_attention: { label: "Payment attention", description: "Unsettled payments and recovery work.", icon: "receipt-text" },
  fulfillment_ready: { label: "Ready to fulfill", description: "Paid orders waiting to be picked.", icon: "package" },
  shipment_exceptions: { label: "Shipment exceptions", description: "Missing tracking or stalled shipments.", icon: "package" },
  pending_returns: { label: "Pending returns", description: "Returns waiting for review.", icon: "receipt-text" },
  pending_refunds: { label: "Pending refunds", description: "Refunds needing completion or review.", icon: "receipt-text" },
  inventory_alerts: { label: "Inventory alerts", description: "Low and out-of-stock inventory.", icon: "warehouse" },
  reservation_exceptions: { label: "Reservation exceptions", description: "Expired or cancelled reservations.", icon: "warehouse" },
  account_issues: { label: "Account issues", description: "Customer and company records needing review.", icon: "users" },
  notification_failures: { label: "Notification failures", description: "Failed transactional deliveries.", icon: "bell" },
};

type QueueKey = keyof typeof queueLabels;
type QueueRow = {
  id: string;
  kind: string;
  title: string;
  subtitle: string | null;
  status: string;
  severity: "critical" | "warning" | "info";
  createdAt: string;
  updatedAt: string;
  amount: string | null;
  currency: string | null;
  href: string;
};
type QueueResult = { items: QueueRow[]; meta: { page: number; pageSize: number; total: number; hasNext: boolean } };
type OperationsResponse = { refreshedAt: string; queues: Record<QueueKey, number>; queue: QueueKey; result: QueueResult };
type TimelineItem = { id: string; source: "audit" | "note"; action: string; details: Record<string, unknown> | null; createdAt: string; actor: string | null };
type Timeline = { entityType: string; entityId: string; items: TimelineItem[] };

const money = (amount: string | null, currency: string | null) => amount === null ? "—" : new Intl.NumberFormat("en-IE", { style: "currency", currency: currency ?? "EUR" }).format(Number(amount));
const titleCase = (value: string) => value.replaceAll("_", " ").replaceAll(".", " ").replace(/\b\w/g, (character) => character.toUpperCase());

export function OperationsPage() {
  const { permissions } = useAuth();
  const canManage = permissions.includes("operations.manage");
  const [queue, setQueue] = useState<QueueKey>("new_orders");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<OperationsResponse | null>(null);
  const [selected, setSelected] = useState<QueueRow | null>(null);
  const [timeline, setTimeline] = useState<Timeline | null>(null);
  const [note, setNote] = useState("");
  const [loading, setLoading] = useState(true);
  const [timelineLoading, setTimelineLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const query = useMemo(() => {
    const params = new URLSearchParams({ queue, page: String(page), pageSize: "20" });
    if (search) params.set("search", search);
    return params.toString();
  }, [page, queue, search]);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await apiRequest<{ data: OperationsResponse }>(`/admin/operations?${query}`);
      setData(response.data);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Operations could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, [query]);

  useEffect(() => { void load(); }, [load]);

  async function inspect(row: QueueRow) {
    setSelected(row);
    setTimeline(null);
    setTimelineLoading(true);
    setNotice("");
    try {
      const response = await apiRequest<{ data: Timeline }>(`/admin/operations/timeline/${row.kind}/${row.id}`);
      setTimeline(response.data);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "The operational history could not be loaded.");
    } finally {
      setTimelineLoading(false);
    }
  }

  async function addNote() {
    if (!selected || !note.trim() || !canManage) return;
    try {
      await apiRequest(`/admin/operations/notes`, { method: "POST", body: JSON.stringify({ entityType: selected.kind, entityId: selected.id, body: note.trim() }) });
      setNote("");
      setNotice("Internal note added.");
      await inspect(selected);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "The internal note could not be saved.");
    }
  }

  const exportHref = `/api/v1/admin/operations/export?queue=${encodeURIComponent(queue)}${search ? `&search=${encodeURIComponent(search)}` : ""}`;
  const selectedLabel = selected ? `${selected.title} · ${titleCase(selected.kind)}` : "";

  return <div className="admin-page operations-page">
    <AdminPageHeader
      eyebrow="Production operations"
      title="Control center"
      description="Prioritize live exceptions across orders, payments, fulfillment, inventory, accounts, and communication."
      actions={<div className="operations-header-actions"><span className="foundation-chip"><span className="status-dot" /> Live queues</span><button className="button button--quiet button--small" onClick={() => void load()} disabled={loading}>Refresh</button></div>}
    />

    <section className="operations-callout">
      <div><span className="eyebrow">Attention model</span><h2>Work the oldest risk first.</h2><p>These queues are read from the same order, payment, inventory, fulfillment, account, and notification records used by the rest of the platform. Nothing here changes a commerce record automatically.</p></div>
      {data && <span className="section-note">Refreshed {new Date(data.refreshedAt).toLocaleTimeString()}</span>}
    </section>

    <section className="operations-queue-grid" aria-label="Operational attention queues">
      {Object.entries(queueLabels).map(([key, item]) => {
        const queueKey = key as QueueKey;
        const count = data?.queues[queueKey] ?? 0;
        return <button type="button" key={key} className={`operations-queue-card ${queue === queueKey ? "is-active" : ""}`} onClick={() => { setQueue(queueKey); setPage(1); setSelected(null); }} aria-pressed={queue === queueKey}>
          <span className="operations-queue-card__top"><span className={`severity-mark severity-mark--${count ? "warning" : "quiet"}`} />{count ? `${count} open` : "Clear"}</span>
          <strong>{item.label}</strong><span>{item.description}</span>
        </button>;
      })}
    </section>

    <section className="operations-toolbar">
      <div><span className="eyebrow">Queue</span><h2>{queueLabels[queue].label}</h2><p>{queueLabels[queue].description}</p></div>
      <div className="operations-toolbar__actions">
        <SearchInput value={searchInput} onChange={setSearchInput} onSubmit={() => { setSearch(searchInput.trim()); setPage(1); }} placeholder="Search order, email, SKU, or reference…" />
        <a className="button button--quiet button--small" href={exportHref}>Export CSV</a>
      </div>
    </section>

    {notice && <div className="commerce-notice commerce-notice--success" role="status">{notice}</div>}
    {error && <ErrorState description={error} onRetry={() => void load()} />}
    {loading && !data ? <LoadingState label="Loading operational queues…" /> : data && <div className="operations-content">
      <section className="admin-panel operations-list-panel">
        <div className="admin-panel__heading"><div><span className="eyebrow">Actionable records</span><h2>{data.result.meta.total.toLocaleString()} in this queue</h2></div><span className="section-note">Server-filtered · page {data.result.meta.page}</span></div>
        {data.result.items.length ? <div className="operations-list">
          {data.result.items.map((row) => <article className={`operations-row operations-row--${row.severity}`} key={`${row.kind}-${row.id}`}>
            <div className="operations-row__main"><div className="operations-row__title"><span className={`severity-mark severity-mark--${row.severity}`} /><strong>{row.title}</strong><StatusBadge status={titleCase(row.status)} tone={row.severity === "critical" ? "negative" : row.severity === "warning" ? "warning" : "neutral"} /></div><span>{row.subtitle ?? "No additional context"}</span><small>Updated {new Date(row.updatedAt).toLocaleString()}</small></div>
            <div className="operations-row__amount">{money(row.amount, row.currency)}</div>
            <div className="operations-row__actions"><button className="button button--quiet button--small" onClick={() => void inspect(row)}>Inspect</button><Link className="button button--quiet button--small" to={row.href}>Open</Link></div>
          </article>)}
        </div> : <EmptyState title={`No ${queueLabels[queue].label.toLowerCase()}`} description="This queue is clear for the current filters. New records will appear here when the underlying system reports an exception." icon={queueLabels[queue].icon} />}
        {data.result.items.length > 0 && <Pagination page={data.result.meta.page} hasNext={data.result.meta.hasNext} onChange={setPage} />}
      </section>

      <aside className="admin-panel operations-detail-panel">
        {selected ? <><div className="admin-panel__heading"><div><span className="eyebrow">Operational detail</span><h2>{selectedLabel}</h2></div><button className="button button--quiet button--small" onClick={() => setSelected(null)}>Close</button></div><div className="operations-detail-summary"><StatusBadge status={titleCase(selected.status)} tone={selected.severity === "critical" ? "negative" : selected.severity === "warning" ? "warning" : "neutral"} /><span>{selected.subtitle ?? "No additional context"}</span><Link className="text-link" to={selected.href}>Open authoritative record</Link></div>
          <div className="operations-timeline"><span className="eyebrow">Timeline</span>{timelineLoading ? <LoadingState label="Loading history…" /> : timeline?.items.length ? timeline.items.map((item) => <div className="operations-timeline__item" key={`${item.source}-${item.id}`}><span className={`timeline-dot timeline-dot--${item.source}`} /><div><strong>{item.source === "note" ? "Internal note" : titleCase(item.action)}</strong><span>{item.source === "note" && typeof item.details?.body === "string" ? item.details.body : item.details ? Object.entries(item.details).filter(([key]) => !/token|secret|password|payload/i.test(key)).map(([key, value]) => `${titleCase(key)}: ${typeof value === "object" ? JSON.stringify(value) : String(value)}`).join(" · ") : "No additional details"}</span><small>{item.actor ?? "System"} · {new Date(item.createdAt).toLocaleString()}</small></div></div>) : <EmptyState title="No history yet" description="Audit events and staff notes will appear as this record is worked." />}</div>
          {canManage && <div className="operations-note-form"><label className="commerce-field">Internal note<textarea value={note} onChange={(event) => setNote(event.target.value)} maxLength={5000} placeholder="Add context for the next operator…" /></label><button className="button button--dark button--small" onClick={() => void addNote()} disabled={!note.trim()}>Add note</button></div>}
        </> : <EmptyState title="Inspect a record" description="Choose a queue item to see its audit history and leave a staff-only note." icon="receipt-text" />}
      </aside>
    </div>}
  </div>;
}