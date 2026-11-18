import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiRequest, ApiError } from "../../../auth/api";
import { useAuth } from "../../../auth/AuthContext";
import { AdminPageHeader, AdminTabs, EmptyState, ErrorState, LoadingState, Pagination, SearchInput, StatusBadge } from "../../../components/admin/AdminPrimitives";
import { Icon } from "../../../components/ui/Icon";
import { TooniesCategoryEditor, TooniesPricingEditor, TooniesShippingEditor } from "./TooniesEditors";
import "./TooniesPage.css";

type Tab = "overview" | "catalogue" | "categories" | "pricing" | "shipping" | "sync" | "procurement";
type AnyRecord = Record<string, any>;

const money = (value: any, currency = "EUR") => value == null ? "—" : `${currency} ${Number(value).toFixed(2)}`;
const tone = (value: string) => value === "available" || value === "completed" || value === "mapped" ? "positive" : value === "approval_pending" || value === "needs_review" || value === "running" || value === "partial" ? "warning" : value === "failed" || value === "error" ? "negative" : "neutral";
const label = (value: string) => value.replaceAll("_", " ").replace(/\b\w/g, (c) => c.toUpperCase());

export function TooniesPage() {
  const { permissions } = useAuth();
  const canSync = permissions.includes("supplier_integrations.sync");
  const canImport = permissions.includes("supplier_integrations.import");
  const canManage = permissions.includes("supplier_integrations.manage");
  const canPrice = permissions.includes("supplier_integrations.pricing");
  const canShippingView = permissions.includes("supplier_shipping.view");
  const canShippingManage = permissions.includes("supplier_shipping.manage");
  const [tab, setTab] = useState<Tab>("overview");
  const [overview, setOverview] = useState<AnyRecord | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [fx, setFx] = useState<AnyRecord | null>(null);
  const [fxLoading, setFxLoading] = useState(false);

  const loadOverview = useCallback(async () => {
    setError("");
    try { const next = (await apiRequest<{ data: AnyRecord }>("/admin/suppliers/toonies/overview")).data; setOverview(next); setFx(next.fx ?? null); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Toonies overview could not be loaded."); }
  }, []);
  useEffect(() => { void loadOverview(); }, [loadOverview]);
  const access = overview?.supplier?.access;
  const tabs: Array<{ value: Tab; label: string }> = [{ value: "overview", label: "Overview" }, { value: "catalogue", label: "Catalogue" }, { value: "categories", label: "Category mapping" }, { value: "pricing", label: "Pricing" }, ...(canShippingView ? [{ value: "shipping" as Tab, label: "Shipping" }] : []), { value: "sync", label: "Synchronization" }, { value: "procurement", label: "Precheck attempts" }];

  async function action(path: string, body?: AnyRecord) {
    setNotice(""); setError("");
    try { await apiRequest(path, { method: "POST", body: JSON.stringify(body ?? {}) }); setNotice("Action accepted. Refreshing workspace."); await loadOverview(); }
    catch (reason) {
      if (reason instanceof ApiError && reason.code === "APPROVAL_PENDING") setError("API access pending approval");
      else setError(reason instanceof Error ? reason.message : "The Toonies action could not be completed.");
    }
  }

  async function refreshFx() {
    setFxLoading(true); setError(""); setNotice("");
    try {
      const next = (await apiRequest<{ data: AnyRecord }>("/admin/suppliers/toonies/fx/refresh", { method: "POST", body: JSON.stringify({}) })).data;
      setFx(next); setNotice("FX snapshot refreshed. Catalogue normalization gates have been rechecked.");
      await loadOverview();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "FX snapshot could not be refreshed."); }
    finally { setFxLoading(false); }
  }

  return <div className="admin-page toonies-page">
    <AdminPageHeader eyebrow="Supplier integrations" title="Toonies supplier workspace" description="Review the Toonies connection, supplier context, and controlled catalogue workflow before anything reaches the catalogue." />
    <TooniesSupplierHeader supplier={overview?.supplier} />
    {error && <ErrorState title={error === "API access pending approval" ? "API access pending approval" : "Workspace action failed"} description={error} onRetry={() => void loadOverview()} />}
    {notice && <p className="catalog-notice" role="status"><Icon name="check" size={15} />{notice}</p>}
    {access === "approval_pending" && <div className="toonies-pending"><Icon name="mail-warning" size={19} /><div><strong>API access pending approval</strong><p>Catalogue calls are unavailable until Toonies approves API access. This is a pending state, not an integration failure. Existing review data remains available.</p></div></div>}
    <AdminTabs tabs={tabs} value={tab} onChange={(value) => setTab(value as Tab)} label="Toonies sections" className="toonies-tabs" />
    <div id={`admin-tabpanel-${tab}`} role="tabpanel" aria-labelledby={`admin-tab-${tab}`}>
      {tab === "overview" && <Overview overview={overview} loading={!overview} onAction={action} canSync={canSync} fx={fx} fxLoading={fxLoading} canRefresh={canPrice} onRefreshFx={refreshFx} />}
      {tab === "catalogue" && <Catalogue canSync={canSync} canImport={canImport} access={access} onAction={action} fx={fx} />}
      {tab === "categories" && <TooniesCategoryEditor canManage={canManage} />}
      {tab === "pricing" && <TooniesPricingEditor canPrice={canPrice} />}
      {tab === "shipping" && <TooniesShippingEditor canView={canShippingView} canManage={canShippingManage} />}
      {tab === "sync" && <Synchronization canSync={canSync} onAction={action} />}
      {tab === "procurement" && <ProcurementAttempts canSync={canSync} />}
    </div>
  </div>;
}

function ProcurementAttempts({ canSync }: { canSync: boolean }) {
  const [rows, setRows] = useState<AnyRecord[]>([]);
  const [settlements, setSettlements] = useState<AnyRecord[]>([]);
  const [selected, setSelected] = useState<AnyRecord | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [pollingId, setPollingId] = useState<string | null>(null);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      setRows((await apiRequest<{ data: AnyRecord[] }>("/admin/suppliers/toonies/procurement?limit=50")).data);
      setSettlements((await apiRequest<{ data: AnyRecord[] }>("/admin/suppliers/toonies/settlements?limit=50")).data);
      setError("");
    }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Precheck attempts could not be loaded."); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  async function open(id: string) {
    setDetailLoading(true);
    try { setSelected((await apiRequest<{ data: AnyRecord }>(`/admin/suppliers/toonies/procurement/${id}`)).data); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Precheck detail could not be loaded."); }
    finally { setDetailLoading(false); }
  }
  async function poll(id: string) {
    if (!canSync) return;
    setPollingId(id);
    try { await apiRequest(`/admin/suppliers/toonies/procurement/${id}/poll`, { method: "POST", body: JSON.stringify({ maxPolls: 5 }) }); await load(); await open(id); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Precheck polling failed."); }
    finally { setPollingId(null); }
  }
  async function settlementAction(id: string, action: "reconcile" | "replay" | "manual-review") {
    if (!canSync) return;
    try {
      await apiRequest(`/admin/suppliers/toonies/settlements/${id}/${action}`, { method: "POST", body: JSON.stringify(action === "manual-review" ? { reason: "Escalated by an authorized administrator for supplier settlement review." } : {}) });
      await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Settlement recovery failed."); }
  }
  const stateTone = (state: string) => state === "ready" || state === "completed" || state === "paid"
    ? "positive"
    : state === "cost_hold" || state === "retry_wait" || state === "processing" || state === "pending"
      ? "warning"
      : state === "failed" || state === "expired"
        ? "negative"
        : "neutral";
  const attempts = (row: AnyRecord) => `${row.pollCount ?? 0}/${row.maxPolls ?? "—"} polls`;
  const eventEvidence = (event: AnyRecord) => event.errorCode != null
    ? String(event.errorCode)
    : event.details == null
      ? ""
      : typeof event.details === "string"
        ? event.details
        : JSON.stringify(event.details);
  return <section className="admin-panel toonies-section toonies-procurement">
    <div className="admin-panel__heading"><div><span className="eyebrow">Stage 1 + 2 only</span><h2>Supplier precheck attempts</h2><p className="toonies-panel-note">Paid-order attempts are observation-only; manual attempts can be polled with permission. A precheck never creates, settles, retries, or fulfills a supplier order.</p></div><span className="section-note">{rows.length} of 50 loaded</span></div>
    <div className="toonies-procurement-legend" aria-label="Precheck safety legend"><span><i className="legend-swatch legend-swatch--paid" />Paid-order binding</span><span><i className="legend-swatch legend-swatch--hold" />Cost hold</span><span><i className="legend-swatch legend-swatch--handoff" />Command handoff</span></div>
    {error && <ErrorState description={error} onRetry={() => void load()} />}
     {loading ? <LoadingState label="Loading precheck attempts…" /> : rows.length ? <div className="toonies-procurement-table-wrap"><table className="admin-table toonies-procurement-table"><thead><tr><th>State / binding</th><th>Supplier task</th><th>Command handoff</th><th>Polling</th><th>Snapshot</th><th>Updated</th><th /></tr></thead><tbody>{rows.map((row) => <tr key={row.id}><td><div className="procurement-state"><StatusBadge status={label(row.state)} tone={stateTone(row.state)} /><strong>{row.orderNumber ? `Order ${row.orderNumber}` : "Manual precheck"}</strong><small>{row.paymentStatus ? `Payment ${label(row.paymentStatus)}` : "Not bound to payment"}</small></div></td><td><strong>{row.clientTaskNo ?? "No client task"}</strong><small>{row.taskId ?? "No supplier task yet"} · generation {row.generation ?? "—"}</small>{row.failureCode && <small className="run-error">{row.failureCode}: {row.failureMessage ?? "No failure message"}</small>}</td><td><StatusBadge status={label(row.commandState ?? "not_applicable")} tone={stateTone(row.commandState ?? "not_applicable")} /><small>{row.commandState ? `${row.commandAttempts ?? 0}/${row.commandMaxAttempts ?? "—"} command attempts` : "Manual attempts have no command"}</small></td><td><strong>{attempts(row)}</strong><small>{row.retryCount ?? 0} supplier retries</small></td><td><small>{row.snapshotExpiresAt ? `Expires ${new Date(row.snapshotExpiresAt).toLocaleString()}` : "No expiry recorded"}</small></td><td><small>{row.updatedAt ? new Date(row.updatedAt).toLocaleString() : "—"}</small></td><td><div className="procurement-row-actions"><button className="button button--small button--quiet" onClick={() => void open(row.id)}>Inspect</button><button className="button button--small button--quiet" disabled={!canSync || Boolean(row.orderId) || !row.taskId || pollingId === row.id || ["ready", "cost_hold", "failed", "expired"].includes(row.state)} onClick={() => void poll(row.id)}>{row.orderId ? "Worker managed" : pollingId === row.id ? "Polling…" : "Poll attempt"}</button></div></td></tr>)}</tbody></table></div> : <EmptyState icon="list-checks" title="No precheck attempts" description="Authoritative linked product attempts will appear here." />}
     <section className="admin-panel" aria-labelledby="toonies-settlement-heading">
       <div className="admin-panel__heading"><div><span className="eyebrow">Stage 3 financial journal</span><h3 id="toonies-settlement-heading">Settlement observability</h3><p className="toonies-panel-note">Recovery uses only bounded reconciliation or the exact stored request identity. There is no new-order retry action.</p></div><span className="section-note">{settlements.length} loaded</span></div>
       {settlements.length ? <div className="toonies-procurement-table-wrap"><table className="admin-table"><thead><tr><th>State</th><th>Identity</th><th>Supplier facts</th><th>Timeline</th><th>Safe recovery</th></tr></thead><tbody>{settlements.map((row) => <tr key={row.id}><td><StatusBadge status={label(row.state)} tone={stateTone(row.state)} /><small>{row.confirmationKind ? `Confirmation: ${label(row.confirmationKind)}` : "No confirmation"}</small></td><td><code>{row.apiOrderSn}</code><small>Task {row.taskId}</small><small>{row.orderSn ? `Order ${row.orderSn}` : "Supplier order unknown"}</small></td><td><small>{row.currency ?? "—"} product {row.productSum ?? "—"}</small><small>{row.payStatus ?? "Payment state unknown"}</small>{row.failureMessage && <small className="run-error">{row.failureMessage}</small>}</td><td><small>Submitted {row.firstSubmissionAt ? new Date(row.firstSubmissionAt).toLocaleString() : "—"}</small><small>Confirmed {row.confirmedAt ? new Date(row.confirmedAt).toLocaleString() : "—"}</small></td><td><div className="procurement-row-actions"><button className="button button--small button--quiet" disabled={!canSync || !["transmitted_unknown", "reconciling"].includes(row.state)} onClick={() => void settlementAction(row.id, "reconcile")}>Reconcile</button><button className="button button--small button--quiet" disabled={!canSync || !["transmitted_unknown", "reconciling"].includes(row.state)} onClick={() => void settlementAction(row.id, "replay")}>Replay exact request</button><button className="button button--small button--quiet" disabled={!canSync || !["transmitted_unknown", "reconciling"].includes(row.state)} onClick={() => void settlementAction(row.id, "manual-review")}>Manual review</button></div></td></tr>)}</tbody></table></div> : <EmptyState icon="list-checks" title="No Stage 3 settlements" description="Settlements remain disabled until the independent financial gate is enabled." />}
     </section>
    {selected && <div className="toonies-detail toonies-procurement-detail"><div className="admin-panel__heading"><div><span className="eyebrow">Attempt detail</span><h2>{selected.orderNumber ? `Order ${selected.orderNumber}` : "Manual precheck"}</h2><p className="toonies-panel-note">{selected.id} · created {selected.createdAt ? new Date(selected.createdAt).toLocaleString() : "—"}</p></div><button className="icon-button" aria-label="Close attempt detail" onClick={() => setSelected(null)}><Icon name="x" size={16} /></button></div>{detailLoading ? <LoadingState label="Loading attempt detail…" /> : <><div className="procurement-detail-summary"><ProcurementMetric label="State" value={label(selected.state)} /><ProcurementMetric label="Payment" value={label(selected.paymentStatus ?? "not applicable")} /><ProcurementMetric label="Settlement" value={label(selected.settlementStatus ?? "not started")} /><ProcurementMetric label="Command" value={label(selected.commandState ?? "not applicable")} /><ProcurementMetric label="Command attempts" value={selected.commandState ? `${selected.commandAttempts ?? 0}/${selected.commandMaxAttempts ?? "—"}` : "—"} /></div><div className="procurement-detail-grid"><section><div className="procurement-subheading"><h3>Expected versus returned</h3><span className="section-note">CNY · supplier truth</span></div>{(selected.lines ?? []).length ? <div className="procurement-lines"><div className="procurement-line procurement-line--head"><span>Line</span><span>Expected</span><span>Returned</span><span>Decision</span></div>{(selected.lines ?? []).map((line: AnyRecord, index: number) => <div className="procurement-line" key={line.id ?? index}><div><strong>{line.skuCode ?? line.productId ?? `Line ${index + 1}`}</strong><small>Requested {line.requestedQuantity ?? "—"} · threshold {line.costThresholdPercent ?? "—"}%</small></div><div><strong>CNY {line.expectedSubtotalCny ?? "—"}</strong><small>Unit CNY {line.expectedUnitCostCny ?? "—"}</small></div><div><strong>CNY {line.returnedSubtotalCny ?? "—"}</strong><small>Unit CNY {line.returnedChargeCny ?? "—"} · qty {line.returnedQuantity ?? "—"}</small></div><div><StatusBadge status={line.orderable === true ? "Orderable" : line.orderable === false ? "Rejected" : "Pending"} tone={line.orderable === true ? "positive" : line.orderable === false ? "warning" : "neutral"} /><small>MOQ {line.returnedMoq ?? "—"} · stock {line.returnedStock ?? "—"}</small>{line.returnedCostVarianceCny != null && <small>Variance CNY {line.returnedCostVarianceCny}</small>}{line.failureMessage && <small className="run-error">{line.failureMessage}</small>}</div></div>)}</div> : <EmptyState icon="boxes" title="No line results" description="The supplier has not returned line-level precheck data." />}</section><section className="procurement-history"><div className="procurement-subheading"><h3>State history</h3><span className="section-note">{(selected.events ?? []).length} events</span></div>{(selected.events ?? []).length ? <ol>{(selected.events ?? []).map((event: AnyRecord, index: number) => <li key={event.id ?? `${event.createdAt}-${index}`}><span className="history-marker" /><div><strong>{label(event.eventType ?? "state change")}</strong><small>{label(event.fromState ?? "start")} → {label(event.toState ?? "unknown")}</small>{eventEvidence(event) && <small className="run-error">{eventEvidence(event)}</small>}</div><time>{event.createdAt ? new Date(event.createdAt).toLocaleString() : "—"}</time></li>)}</ol> : <EmptyState icon="list-checks" title="No state history" description="Events will appear as the supplier precheck advances." />}</section></div></>}</div>}
  </section>;
}

function ProcurementMetric({ label: metricLabel, value }: { label: string; value: string }) {
  return <div><span>{metricLabel}</span><strong>{value}</strong></div>;
}

function TooniesSupplierHeader({ supplier }: { supplier?: AnyRecord }) {
  const access = supplier?.access;
  const documentationUrl = supplier?.documentationUrl ?? supplier?.documentation_url;
  return <section className="toonies-supplier-header" aria-labelledby="toonies-supplier-name">
    <div className="toonies-supplier-header__identity">
      <div className="toonies-supplier-header__mark" aria-hidden="true">TO</div>
      <div><span className="eyebrow">Supplier identity</span><h2 id="toonies-supplier-name">Toonies</h2><p>Official supplier integration</p></div>
    </div>
    <div className="toonies-supplier-header__status">
      <span className="section-note">Connection status</span>
      <StatusBadge status={access === "approval_pending" ? "API access pending approval" : access ? label(access) : "Checking access"} tone={access === "approval_pending" ? "warning" : access ? "positive" : "neutral"} />
    </div>
    <dl className="toonies-supplier-header__context">
      {supplier?.slug && <div><dt>Supplier key</dt><dd>{supplier.slug}</dd></div>}
      {supplier?.id && <div><dt>Connection record</dt><dd>{supplier.id}</dd></div>}
      {documentationUrl && <div><dt>Resources</dt><dd><a href={documentationUrl} target="_blank" rel="noreferrer">Documentation</a></dd></div>}
    </dl>
  </section>;
}

function Overview({ overview, loading, onAction, canSync, fx, fxLoading, canRefresh, onRefreshFx }: AnyRecord) {
  if (loading) return <LoadingState label="Loading Toonies overview…" />;
  const catalogue = overview.catalogue ?? {}, mappings = overview.mappings ?? {};
  return <><div className="toonies-fx-banner"><div><span className="eyebrow">Authoritative conversion</span><h2>EUR normalization control</h2><p>Supplier costs remain in CNY for audit. Storefront pricing uses only a fresh, provenanced ECB observation.</p></div><FxStatus fx={fx} /><button className="button button--small button--dark" disabled={!canRefresh || fxLoading} onClick={() => void onRefreshFx()}>{fxLoading ? "Refreshing…" : "Refresh FX snapshot"}</button></div><div className="admin-kpi-grid toonies-kpis"><Kpi label="Catalogue items" value={catalogue.total ?? 0} detail={`${catalogue.synced ?? 0} synced · ${catalogue.needs_review ?? 0} review`} /><Kpi label="Category mappings" value={mappings.total ?? 0} detail={`${mappings.mapped ?? 0} mapped`} tone="accent" /><Kpi label="Out of stock" value={catalogue.out_of_stock ?? 0} detail="Supplier feed state" /><Kpi label="Recent runs" value={(overview.syncRuns ?? []).length} detail="Latest 20 runs" /></div>
    <div className="toonies-overview-grid"><section className="admin-panel"><div className="admin-panel__heading"><div><span className="eyebrow">Control room</span><h2>Safe feed sequence</h2></div></div><ol className="toonies-checklist"><li><span>01</span><div><strong>Confirm API access</strong><small>Approval state is shown above; credentials are never requested here.</small></div><StatusBadge status={overview.supplier?.access === "approval_pending" ? "Pending approval" : "Checked"} tone={overview.supplier?.access === "approval_pending" ? "warning" : "positive"} /></li><li><span>02</span><div><strong>Sync a filtered catalogue page</strong><small>Enter an official supplier keyword in the Catalogue tab. Blank or invented “all” searches are never sent.</small></div><span className="section-note">Keyword required</span></li><li><span>03</span><div><strong>Map categories and set pricing</strong><small>Unmapped or unnormalized items cannot be published.</small></div><StatusBadge status="Review required" tone="warning" /></li></ol></section><section className="admin-panel"><div className="admin-panel__heading"><div><span className="eyebrow">Latest activity</span><h2>Synchronization history</h2></div></div>{overview.syncRuns?.length ? <div className="toonies-run-list">{overview.syncRuns.slice(0, 5).map((run: AnyRecord) => <div key={run.id}><span className={`run-dot run-dot--${run.status}`} /><div><strong>{label(run.operation)} · {label(run.status)}</strong><small>{run.itemCount ?? 0} items · {run.errorCount ?? 0} errors</small></div><time>{run.completedAt ? new Date(run.completedAt).toLocaleString() : "In progress"}</time></div>)}</div> : <EmptyState icon="list-checks" title="No synchronization runs" description="A run will appear here after the first catalogue or category sync." />}</section></div></>;
}

function Kpi({ label: text, value, detail, tone: cardTone = "default" }: { label: string; value: any; detail: string; tone?: "default" | "accent" }) { return <article className={`admin-kpi admin-kpi--${cardTone}`}><span className="admin-kpi__label">{text}</span><strong>{value}</strong><span className="admin-kpi__detail">{detail}</span></article>; }

function Catalogue({ canSync, canImport, canPrice, access, onAction, fx }: AnyRecord) {
  const [page, setPage] = useState(1), [search, setSearch] = useState(""), [result, setResult] = useState<AnyRecord | null>(null), [selected, setSelected] = useState<string[]>([]), [detail, setDetail] = useState<AnyRecord | null>(null), [loading, setLoading] = useState(true), [error, setError] = useState("");
  const [mappingFilter, setMappingFilter] = useState<"all" | "mapped" | "unmapped">("all");
  const [categoryId, setCategoryId] = useState("");
  const [syncKeyword, setSyncKeyword] = useState("");
  const [syncPending, setSyncPending] = useState(false);
  const syncPendingRef = useRef(false);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const q = new URLSearchParams({ page: String(page), pageSize: "25", mapping: mappingFilter });
      if (search) q.set("search", search);
      if (categoryId) q.set("categoryId", categoryId);
      setResult((await apiRequest<{ data: AnyRecord }>(`/admin/suppliers/toonies/catalogue?${q}`)).data);
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Catalogue could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, [page, search, mappingFilter, categoryId]);
  useEffect(() => { void load(); }, [load]);
  const rows = result?.items ?? [];
  const canImportRows = Boolean(fx?.fresh && fx?.rate && selected.length > 0 && selected.every((id) => {
    const row = rows.find((item: AnyRecord) => item.id === id);
    return row?.originalCurrency === "CNY" && row?.originalAmount != null;
  }));
  async function importSelected(ids: string[]) { if (!ids.length || !canImportRows) return; await onAction("/admin/suppliers/toonies/catalogue/import", { ids }); setSelected([]); void load(); }
  async function openDetail(id: string) { try { setDetail((await apiRequest<{ data: AnyRecord }>(`/admin/suppliers/toonies/catalogue/${id}`)).data); } catch (e) { setError(e instanceof Error ? e.message : "Catalogue detail could not be loaded."); } }
  async function syncFiltered() {
    if (syncPendingRef.current) return;
    const keyword = syncKeyword.trim();
    if (!keyword) return;
    syncPendingRef.current = true;
    setSyncPending(true);
    try {
      await onAction("/admin/suppliers/toonies/catalogue/sync", { keyword, pageSize: 20 });
      await load();
    } finally {
      syncPendingRef.current = false;
      setSyncPending(false);
    }
  }
  return <section className="admin-panel toonies-section"><div className="admin-panel__heading"><div><span className="eyebrow">Supplier feed</span><h2>Catalogue intake</h2></div><span className="section-note">{result?.meta?.total ?? 0} records</span></div><div className="toonies-discovery-control"><label><span>Product search keyword</span><input value={syncKeyword} placeholder="Enter a Toonies product keyword" onChange={(event) => setSyncKeyword(event.target.value)} /></label><button className="button button--small button--dark" disabled={!canSync || access === "approval_pending" || !syncKeyword.trim() || syncPending} onClick={() => void syncFiltered()}>{syncPending ? "Discovering…" : "Discover products"}</button></div><div className="catalog-toolbar toonies-catalogue-filters"><SearchInput value={search} onChange={(v) => { setSearch(v); setPage(1); }} placeholder="Search synchronized products" /><label><span>Category mapping</span><select aria-label="Category mapping" value={mappingFilter} onChange={(event) => { setMappingFilter(event.target.value as "all" | "mapped" | "unmapped"); setPage(1); }}><option value="all">All</option><option value="mapped">Mapped</option><option value="unmapped">Not mapped</option></select></label><label><span>Mapped Lizzor category</span><select aria-label="Mapped Lizzor category" value={categoryId} onChange={(event) => { setCategoryId(event.target.value); setPage(1); }}><option value="">All mapped categories</option>{(result?.filters?.mappedCategories ?? []).map((category: AnyRecord) => <option key={category.id} value={category.id}>{category.label}</option>)}</select></label></div>{selected.length > 0 && <div className="admin-bulk-bar"><strong>{selected.length} selected</strong><button className="button button--small button--dark" disabled={!canImport || !canImportRows} onClick={() => void importSelected(selected)}>Import selected as draft</button>{!canImportRows && <span className="currency-blocked">Import blocked: fresh provenanced FX is unavailable.</span>}<button className="button button--small button--quiet" onClick={() => setSelected([])}>Clear</button></div>}{error && <ErrorState description={error} onRetry={() => void load()} />}{loading ? <LoadingState label="Loading catalogue…" /> : rows.length ? <div className="admin-table-wrap toonies-catalogue-table-wrap"><table className="admin-table toonies-table"><thead><tr><th><input type="checkbox" aria-label="Select current page" checked={rows.length > 0 && rows.every((r: AnyRecord) => selected.includes(r.id))} onChange={(e) => setSelected(e.target.checked ? rows.map((r: AnyRecord) => r.id) : [])} /></th><th>Official product</th><th>Toonies category</th><th>EUR normalized</th><th>CNY supplier cost</th><th>FX audit</th><th>Review gate</th></tr></thead><tbody>{rows.map((row: AnyRecord) => <tr key={row.id}><td><input type="checkbox" aria-label={`Select ${row.title}`} checked={selected.includes(row.id)} onChange={(e) => setSelected(e.target.checked ? [...selected, row.id] : selected.filter((id) => id !== row.id))} /></td><td><button className="toonies-product-link" onClick={() => void openDetail(row.id)}>{row.title}</button><small>{row.externalProductId} · {row.variantCount ?? 0} variants</small></td><td><CatalogueCategory row={row} /></td><td>{row.normalizedEur == null ? <span className="currency-blocked">Automatic EUR normalization unavailable</span> : <><strong>{money(row.normalizedEur)}</strong>{row.manualCostOverrideEur != null && <small className="override-note">Manual cost override: {money(row.manualCostOverrideEur)}</small>}</>}</td><td>{money(row.originalAmount, row.originalCurrency ?? "CNY")}</td><td><FxAudit row={row} /></td><td>{row.needsReview ? <StatusBadge status={row.fxNormalizationError ? "FX blocked" : "Approval pending"} tone="warning" /> : <StatusBadge status="Ready" tone="positive" />}</td></tr>)}</tbody></table></div> : <EmptyState icon="boxes" title="No catalogue records" description={access === "approval_pending" ? "API access pending approval. No supplier records can be fetched yet." : "No synchronized products match the current catalogue filters."} />}{result?.meta && rows.length > 0 && <Pagination page={result.meta.page} hasNext={result.meta.hasNext} onChange={setPage} />}{detail && <div className="toonies-detail"><div className="admin-panel__heading"><div><span className="eyebrow">Official detail</span><h2>{detail.title}</h2></div><button className="icon-button" aria-label="Close catalogue detail" onClick={() => setDetail(null)}><Icon name="x" size={16} /></button></div><FxAudit row={detail} expanded /><p className="toonies-panel-note">CNY {detail.originalAmount} is the supplier source amount. Automatic EUR conversion is authoritative; only explicit cost overrides can differ.</p>{detail.manualCostOverrideEur != null && <p className="override-note">Manual cost override: {money(detail.manualCostOverrideEur)}. This is an explicit exception, not FX normalization.</p>}<div className="toonies-variant-list">{(detail.variants ?? []).map((variant: AnyRecord) => <div key={variant.id}><strong>{variant.skuCode}</strong><span>{money(variant.normalizedEur)} · {money(variant.originalAmount, "CNY")}</span>{variant.manualCostOverrideEur != null && <small className="override-note">Manual cost override: {money(variant.manualCostOverrideEur)}</small>}</div>)}</div></div>}</section>;
}

function CatalogueCategory({ row }: { row: AnyRecord }) {
  const supplierCategoryId = row.externalCategoryId || "Category ID unavailable";
  const mapped = row.categoryMappingStatus === "mapped" && Boolean(row.mappedCategoryPath);
  return <span className="toonies-catalogue-category">
    <code>{supplierCategoryId}</code>
    <span aria-hidden="true">→</span>
    {mapped
      ? <strong>{row.mappedCategoryPath}</strong>
      : <strong className="toonies-catalogue-category__unmapped">Not mapped</strong>}
  </span>;
}

function FxStatus({ fx }: { fx: AnyRecord | null }) {
  const fresh = Boolean(fx?.fresh && fx?.rate);
  return <div className={`toonies-fx-status ${fresh ? "is-fresh" : "is-blocked"}`}><strong>{fresh ? "Fresh snapshot" : "EUR normalization unavailable"}</strong><span>{fx?.source ?? "ECB"} · {fx?.series ?? "EUR/CNY"} · {fx?.rate ? `CNY ${fx.rate} / 1 EUR` : "No rate"}</span><small>{fx?.observedAt ? `Observed ${new Date(fx.observedAt).toLocaleString()}` : "No observation"}{fx?.expiresAt ? ` · Expires ${new Date(fx.expiresAt).toLocaleString()}` : ""}</small></div>;
}
function FxAudit({ row, expanded = false }: { row: AnyRecord; expanded?: boolean }) {
  if (!row.fxRateSnapshotId || !row.fxRateUsed) return <span className="currency-blocked">Automatic EUR normalization unavailable{expanded && row.fxNormalizationError ? ` · ${row.fxNormalizationError}` : ""}</span>;
  return <span className="fx-audit">{row.fxSource ?? "ECB"} · CNY {row.fxRateUsed}/EUR<small>{row.fxObservedAt ? new Date(row.fxObservedAt).toLocaleDateString() : "—"}{expanded && row.fxFetchedAt ? ` · fetched ${new Date(row.fxFetchedAt).toLocaleString()}` : ""}</small></span>;
}

function Pricing({ canPrice }: { canPrice: boolean }) {
  const [rules, setRules] = useState<AnyRecord[]>([]), [draft, setDraft] = useState({ name: "Toonies wholesale markup", ruleType: "markup_percent", minCostEur: 0, maxCostEur: null as number | null, value: 35, roundingMode: "99", priority: 10, active: true, significantCostIncreasePercent: 20 }), [cost, setCost] = useState("10"), [preview, setPreview] = useState<number | null>(null), [error, setError] = useState("");
  const load = useCallback(async () => { try { setRules((await apiRequest<{ data: AnyRecord[] }>("/admin/suppliers/toonies/pricing")).data); } catch (e) { setError(e instanceof Error ? e.message : "Pricing rules could not be loaded."); } }, []);
  useEffect(() => { void load(); }, [load]);
  async function save() { try { await apiRequest("/admin/suppliers/toonies/pricing", { method: "POST", body: JSON.stringify({ ...draft, minCostEur: Number(draft.minCostEur), maxCostEur: draft.maxCostEur === null ? null : Number(draft.maxCostEur), value: Number(draft.value), priority: Number(draft.priority), significantCostIncreasePercent: Number(draft.significantCostIncreasePercent) }) }); setError(""); void load(); } catch (e) { setError(e instanceof Error ? e.message : "Pricing rule could not be saved."); } }
  async function calculate() { try { setPreview((await apiRequest<{ data: { price: number } }>("/admin/suppliers/toonies/pricing/preview", { method: "POST", body: JSON.stringify({ cost: Number(cost), ruleType: draft.ruleType, value: Number(draft.value), roundingMode: draft.roundingMode }) })).data.price); } catch (e) { setError(e instanceof Error ? e.message : "Price preview failed."); } }
  return <div className="toonies-pricing-grid"><section className="admin-panel toonies-section"><div className="admin-panel__heading"><div><span className="eyebrow">Commercial guardrails</span><h2>Pricing rules</h2></div></div>{error && <ErrorState description={error} />}{rules.length ? <div className="toonies-rule-list">{rules.map((rule) => <div key={rule.id}><strong>{rule.name}</strong><span>{label(rule.ruleType)} · {rule.value}{rule.ruleType !== "markup_fixed" ? "%" : " EUR"} · round {rule.roundingMode}</span><StatusBadge status={rule.active ? "Active" : "Inactive"} tone={rule.active ? "positive" : "neutral"} /></div>)}</div> : <EmptyState icon="badge-percent" title="No pricing rules" description="Create the first controlled rule for normalized supplier costs." />}<div className="toonies-form-grid"><label>Rule name<input value={draft.name} disabled={!canPrice} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></label><label>Rule type<select value={draft.ruleType} disabled={!canPrice} onChange={(e) => setDraft({ ...draft, ruleType: e.target.value })}><option value="markup_percent">Markup percent</option><option value="markup_fixed">Markup fixed</option><option value="margin_percent">Margin percent</option></select></label><label>Value<input type="number" value={draft.value} disabled={!canPrice} onChange={(e) => setDraft({ ...draft, value: Number(e.target.value) })} /></label><label>Rounding<select value={draft.roundingMode} disabled={!canPrice} onChange={(e) => setDraft({ ...draft, roundingMode: e.target.value })}><option value="none">No rounding</option><option value="whole">Whole EUR</option><option value="99">.99 pricing</option></select></label><label>Cost increase review threshold %<input type="number" value={draft.significantCostIncreasePercent} disabled={!canPrice} onChange={(e) => setDraft({ ...draft, significantCostIncreasePercent: Number(e.target.value) })} /></label></div><button className="button button--small button--dark" disabled={!canPrice} onClick={() => void save()}>Save pricing rule</button></section><section className="admin-panel toonies-section"><div className="admin-panel__heading"><div><span className="eyebrow">Decision preview</span><h2>Calculated outcome</h2></div></div><p className="toonies-panel-note">Only normalized EUR costs should enter this calculation. CNY values require review and normalization first.</p><label>Normalized cost in EUR<input type="number" value={cost} onChange={(e) => setCost(e.target.value)} /></label><button className="button button--small button--dark" disabled={!canPrice} onClick={() => void calculate()}>Preview price</button>{preview != null && <div className="toonies-preview"><span>Effective price</span><strong>{money(preview)}</strong><small>Based on the unsaved rule above</small></div>}</section></div>;
}

function Synchronization({ canSync, onAction }: AnyRecord) {
  const [runs, setRuns] = useState<AnyRecord[]>([]), [loading, setLoading] = useState(true);
  const [keyword, setKeyword] = useState("");
  const load = useCallback(async () => { try { const history = await apiRequest<{ data: AnyRecord[] }>("/admin/suppliers/toonies/synchronization"); setRuns(history.data); } finally { setLoading(false); } }, []);
  useEffect(() => { void load(); }, [load]);
  async function resume(run: AnyRecord) { if (!canSync) return; await apiRequest(`/admin/suppliers/toonies/synchronization/${run.id}/resume`, { method: "POST", body: JSON.stringify({}) }); await load(); }
  return <div className="toonies-sync-grid"><section className="admin-panel toonies-section"><div className="admin-panel__heading"><div><span className="eyebrow">Feed operations</span><h2>Synchronization history</h2></div><div><input aria-label="Supplier keyword" placeholder="Official keyword required" value={keyword} onChange={(event) => setKeyword(event.target.value)} /><button className="button button--small button--dark" disabled={!canSync || !keyword.trim()} onClick={() => void onAction("/admin/suppliers/toonies/synchronization", { keyword: keyword.trim() })}>Run filtered sync</button></div></div>{loading ? <LoadingState label="Loading synchronization history…" /> : runs.length ? <div className="toonies-run-list toonies-run-list--large">{runs.map((run) => { const expected = Number(run.expectedCount ?? 0); const processed = Number(run.processedCount ?? 0); const progress = expected > 0 ? ` · ${Math.min(processed, expected)}/${expected} records` : ""; return <div key={run.id}><span className={`run-dot run-dot--${run.status}`} /><div><strong>{label(run.operation)} <StatusBadge status={label(run.status)} tone={tone(run.status)} /></strong><small>{run.pageCount ?? 0} pages · {run.itemCount ?? 0} items{progress} · {run.errorCount ?? 0} errors</small>{run.errorMessage && <small className="run-error">{run.errorMessage}</small>}{["partial", "failed"].includes(run.status) && <button className="button button--small button--quiet" disabled={!canSync} onClick={() => void resume(run)}>{run.status === "failed" ? "Retry" : "Resume"}</button>}</div><time>{run.startedAt ? new Date(run.startedAt).toLocaleString() : "Queued"}</time></div>; })}</div> : <EmptyState icon="list-checks" title="No runs yet" description="Enter an official supplier keyword to start a controlled sync." />}</section></div>;
}