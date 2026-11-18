import { useCallback, useEffect, useMemo, useState } from "react";
import { apiRequest } from "../../../auth/api";
import { AdminPageHeader, EmptyState, ErrorState, FilterBar, LoadingState, Pagination, SearchInput } from "../../../components/admin/AdminPrimitives";

type Audit = { id: string; actor: string | null; action: string; entityType: string; entityId: string | null; oldValues: unknown; newValues: unknown; createdAt: string };
type AuditList = { items: Audit[]; meta: { page: number; pageSize: number; total: number; hasNext: boolean } };
const titleCase = (value: string) => value.replaceAll("_", " ").replaceAll(".", " ").replace(/\b\w/g, (character) => character.toUpperCase());

function displayValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") return value;
  try { return JSON.stringify(value); } catch { return "Unavailable"; }
}

function ChangeBlock({ label, value }: { label: string; value: unknown }) {
  if (value === null || value === undefined) return null;
  const entries: Array<[string, unknown]> = value && typeof value === "object" && !Array.isArray(value) ? Object.entries(value) : [["value", value]];
  return <div className="audit-change"><span className="eyebrow">{label}</span>{entries.map(([key, entryValue]) => <div key={key}><strong>{titleCase(key)}</strong><span>{displayValue(entryValue)}</span></div>)}</div>;
}

export function ActivityLogsPage() {
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [action, setAction] = useState("");
  const [entityType, setEntityType] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<AuditList | null>(null);
  const [selected, setSelected] = useState<Audit | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState("");

  const query = useMemo(() => {
    const params = new URLSearchParams({ page: String(page), pageSize: "25" });
    if (search) params.set("search", search);
    if (action.trim()) params.set("action", action.trim());
    if (entityType.trim()) params.set("entityType", entityType.trim());
    if (from) params.set("from", `${from}T00:00:00.000Z`);
    if (to) params.set("to", `${to}T23:59:59.999Z`);
    return params.toString();
  }, [action, entityType, from, page, search, to]);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try { setData((await apiRequest<{ data: AuditList }>(`/admin/activity?${query}`)).data); }
    catch (requestError) { setError(requestError instanceof Error ? requestError.message : "Activity logs could not be loaded."); }
    finally { setLoading(false); }
  }, [query]);

  async function inspect(id: string) {
    setDetailLoading(true);
    setError("");
    try { setSelected((await apiRequest<{ data: Audit }>(`/admin/activity/${id}`)).data); }
    catch (requestError) { setError(requestError instanceof Error ? requestError.message : "The activity detail could not be loaded."); }
    finally { setDetailLoading(false); }
  }

  useEffect(() => { void load(); }, [load]);

  return <div className="admin-page operations-page">
    <AdminPageHeader eyebrow="Administration" title="Activity logs" description="Investigate administrative changes with sensitive values redacted at the API boundary." actions={<span className="foundation-chip"><span className="status-dot" /> Immutable history</span>} />
    {error && <ErrorState title="Activity log action failed" description={error} onRetry={() => void load()} />}
    <section className="admin-panel">
      <div className="admin-panel__heading"><div><span className="eyebrow">Audit history</span><h2>{data?.meta.total.toLocaleString() ?? "—"} recorded events</h2></div><span className="section-note">Read-only · redacted</span></div>
      <FilterBar><SearchInput value={searchInput} onChange={setSearchInput} onSubmit={() => { setSearch(searchInput.trim()); setPage(1); }} placeholder="Search actor, action, entity, ID…" /><label className="admin-filter">Action<input value={action} onChange={(event) => { setAction(event.target.value); setPage(1); }} placeholder="e.g. refund" /></label><label className="admin-filter">Entity<input value={entityType} onChange={(event) => { setEntityType(event.target.value); setPage(1); }} placeholder="e.g. payment" /></label><label className="admin-filter">From<input type="date" value={from} max={to || undefined} onChange={(event) => { setFrom(event.target.value); setPage(1); }} /></label><label className="admin-filter">To<input type="date" value={to} min={from || undefined} onChange={(event) => { setTo(event.target.value); setPage(1); }} /></label></FilterBar>
      {loading ? <LoadingState label="Loading audit history…" /> : data?.items.length ? <div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>Actor</th><th>Action</th><th>Entity</th><th>Change summary</th><th>Timestamp</th><th /></tr></thead><tbody>{data.items.map((item) => <tr key={item.id}><td>{item.actor ?? "System"}</td><td><strong>{titleCase(item.action)}</strong></td><td>{titleCase(item.entityType)}<small className="table-subline">{item.entityId ? item.entityId.slice(0, 12) : "No ID"}</small></td><td>{item.newValues ? "New values recorded" : item.oldValues ? "Previous values recorded" : "Event recorded"}</td><td>{new Date(item.createdAt).toLocaleString()}</td><td><button className="button button--quiet button--small" onClick={() => void inspect(item.id)}>Inspect</button></td></tr>)}</tbody></table></div> : <EmptyState title="No activity found" description="Administrative events will appear here when the system records them. No sample events have been added." icon="receipt-text" />}
      {data?.items.length ? <Pagination page={data.meta.page} hasNext={data.meta.hasNext} onChange={setPage} /> : null}
    </section>
    <section className="admin-panel">
      {detailLoading ? <LoadingState label="Loading event detail…" /> : selected ? <><div className="admin-panel__heading"><div><span className="eyebrow">Event detail</span><h2>{titleCase(selected.action)}</h2></div><button className="button button--quiet button--small" onClick={() => setSelected(null)}>Close</button></div><dl className="admin-detail-list"><div><dt>Actor</dt><dd>{selected.actor ?? "System"}</dd></div><div><dt>Entity</dt><dd>{titleCase(selected.entityType)}{selected.entityId ? ` · ${selected.entityId}` : ""}</dd></div><div><dt>Timestamp</dt><dd>{new Date(selected.createdAt).toLocaleString()}</dd></div></dl><div className="audit-change-grid"><ChangeBlock label="Previous values" value={selected.oldValues} /><ChangeBlock label="New values" value={selected.newValues} /></div><p className="section-note">Secrets, payment data, contact details, addresses, and business identifiers are redacted before this data reaches the Admin client.</p></> : <EmptyState title="Inspect an event" description="Choose an audit event to review its actor, entity, timestamp, and redacted change summary." icon="receipt-text" />}
    </section>
  </div>;
}