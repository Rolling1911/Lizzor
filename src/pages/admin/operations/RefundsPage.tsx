import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { apiRequest, ApiError } from "../../../auth/api";
import { useAuth } from "../../../auth/AuthContext";
import { AdminPageHeader, EmptyState, ErrorState, FilterBar, FormSection, KpiCard, LoadingState, Pagination, SearchInput, StatusBadge } from "../../../components/admin/AdminPrimitives";

type Refund = {
  id: string;
  orderId: string;
  orderNumber: string;
  paymentId: string | null;
  returnRequestId: string | null;
  customerName: string | null;
  customerEmail: string | null;
  companyName: string | null;
  provider: string | null;
  providerPaymentId: string | null;
  providerReference: string | null;
  requestedAmount: number;
  refundedAmount: number;
  currency: string;
  status: string;
  reason: string | null;
  failureReason: string | null;
  createdAt: string;
  updatedAt: string;
};
type RefundList = { items: Refund[]; meta: { page: number; pageSize: number; total: number; hasNext: boolean }; provider: { name: string; configured: boolean } };
type RefundDetail = {
  refund: Refund;
  payment: { id: string; provider: string | null; providerPaymentId: string | null } | null;
  order: { id: string; orderNumber: string };
  customer: { name: string | null; email: string | null } | null;
  company: { name: string } | null;
  returnRequest: { id: string; reason: string; description: string | null; status: string; reviewedAt: string | null; receivedAt: string | null } | null;
  recoveryJobs: Array<{ id: string; operation: string; status: string; attempts: number; retryable: boolean; lastError: string | null; nextAttemptAt: string; lastAttemptAt: string | null }>;
  provider: { name: string; configured: boolean };
};

const money = (amount: number, currency: string) => new Intl.NumberFormat("en-IE", { style: "currency", currency }).format(amount);
const titleCase = (value: string) => value.replaceAll("_", " ").replace(/\b\w/g, (character) => character.toUpperCase());
const tone = (status: string): "neutral" | "positive" | "warning" | "negative" => status === "completed" ? "positive" : status === "failed" || status === "cancelled" ? "negative" : status === "processing" ? "warning" : "neutral";

export function RefundsPage() {
  const { permissions } = useAuth();
  const canManage = permissions.includes("refunds.manage");
  const canReconcile = canManage && permissions.includes("payments.recovery.manage") && permissions.includes("payments.reconcile");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<RefundList | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<RefundDetail | null>(null);
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const query = useMemo(() => {
    const params = new URLSearchParams({ page: String(page), pageSize: "20" });
    if (search) params.set("search", search);
    if (status !== "all") params.set("status", status);
    return params.toString();
  }, [page, search, status]);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setData((await apiRequest<{ data: RefundList }>(`/admin/refunds?${query}`)).data);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Refunds could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, [query]);

  const loadDetail = useCallback(async (id: string) => {
    setDetailLoading(true);
    try {
      setDetail((await apiRequest<{ data: RefundDetail }>(`/admin/refunds/${id}`)).data);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "The refund detail could not be loaded.");
    } finally {
      setDetailLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (selectedId) void loadDetail(selectedId);
    else setDetail(null);
  }, [loadDetail, selectedId]);

  function select(refund: Refund) {
    setSelectedId(refund.id);
    setNotice("");
    setAmount("");
    setReason("");
  }

  async function reconcile() {
    if (!detail || !canReconcile) return;
    setBusy(true);
    setError("");
    try {
      await apiRequest(`/admin/refunds/${detail.refund.id}/reconcile`, { method: "POST", body: JSON.stringify({}) });
      setNotice("Refund reconciliation was queued. The provider result will update this record.");
      await Promise.all([load(), loadDetail(detail.refund.id)]);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Refund reconciliation could not be queued.");
    } finally {
      setBusy(false);
    }
  }

  async function create() {
    if (!detail?.payment?.id || !canManage || !data?.provider.configured) return;
    const numericAmount = Number(amount);
    if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
      setError("Enter a refund amount greater than zero.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await apiRequest(`/admin/payments/${detail.payment.id}/refunds`, {
        method: "POST",
        body: JSON.stringify({ amount: numericAmount, reason: reason.trim() || undefined, idempotencyKey: `admin-refund-${crypto.randomUUID()}` }),
      });
      setNotice("Refund request submitted through the configured payment provider.");
      setAmount("");
      setReason("");
      await Promise.all([load(), loadDetail(detail.refund.id)]);
    } catch (requestError) {
      setError(requestError instanceof ApiError && requestError.code === "PAYMENT_PROVIDER_NOT_CONFIGURED"
        ? "Online refunds are not configured yet. No provider request was made."
        : requestError instanceof Error ? requestError.message : "The refund could not be submitted.");
    } finally {
      setBusy(false);
    }
  }

  return <div className="admin-page operations-page">
    <AdminPageHeader eyebrow="Payments & operations" title="Refunds" description="Review provider-backed refund records without changing immutable payment history." actions={<StatusBadge status={data?.provider.configured ? `${data.provider.name} ready` : "Provider not configured"} tone={data?.provider.configured ? "positive" : "warning"} />} />
    {notice && <p className="catalog-notice" role="status">{notice}</p>}
    {error && <ErrorState title="Refund action failed" description={error} onRetry={() => void load()} />}
    {data && <section className="admin-kpi-grid">
      <KpiCard label="Refund records" value={String(data.meta.total)} detail="Current filtered view" />
      <KpiCard label="Provider" value={data.provider.configured ? titleCase(data.provider.name) : "Not ready"} detail={data.provider.configured ? "Actions can reach the provider" : "Review only"} tone={data.provider.configured ? "accent" : "quiet"} />
      <KpiCard label="Page" value={String(data.meta.page)} detail="Server-filtered records" />
    </section>}
    <section className="admin-panel">
      <div className="admin-panel__heading"><div><span className="eyebrow">Financial records</span><h2>Refund activity</h2></div><span className="section-note">Provider-driven status</span></div>
      <FilterBar>
        <SearchInput value={searchInput} onChange={setSearchInput} onSubmit={() => { setSearch(searchInput.trim()); setPage(1); }} placeholder="Search order, customer, company, reference…" />
        <label className="admin-filter">Status<select value={status} onChange={(event) => { setStatus(event.target.value); setPage(1); }}><option value="all">All statuses</option><option value="pending">Pending</option><option value="processing">Processing</option><option value="completed">Completed</option><option value="failed">Failed</option><option value="cancelled">Cancelled</option></select></label>
      </FilterBar>
      {loading ? <LoadingState label="Loading refund records…" /> : data?.items.length ? <div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>Refund</th><th>Customer / company</th><th>Requested</th><th>Settled</th><th>Status</th><th>Created</th><th /></tr></thead><tbody>{data.items.map((refund) => <tr key={refund.id} className={selectedId === refund.id ? "is-selected" : undefined}>
        <td><strong>{refund.orderNumber}</strong><small className="table-subline">{refund.providerReference ?? refund.id.slice(0, 8)}</small></td>
        <td><strong>{refund.customerName ?? refund.customerEmail ?? "Guest checkout"}</strong><small className="table-subline">{refund.companyName ?? refund.customerEmail ?? "No company"}</small></td>
        <td>{money(refund.requestedAmount, refund.currency)}</td>
        <td>{refund.refundedAmount ? money(refund.refundedAmount, refund.currency) : "—"}</td>
        <td><StatusBadge status={titleCase(refund.status)} tone={tone(refund.status)} /></td>
        <td>{new Date(refund.createdAt).toLocaleDateString()}</td>
        <td><button className="button button--quiet button--small" onClick={() => select(refund)}>Inspect</button></td>
      </tr>)}</tbody></table></div> : <EmptyState title="No refunds found" description="Refund records will appear here when the payment system records them. No sample financial records have been added." icon="receipt-text" />}
      {data?.items.length ? <Pagination page={data.meta.page} hasNext={data.meta.hasNext} onChange={setPage} /> : null}
    </section>
    <section className="admin-detail-grid">
      <section className="admin-panel">
        {detailLoading ? <LoadingState label="Loading refund detail…" /> : detail ? <><div className="admin-panel__heading"><div><span className="eyebrow">Refund detail</span><h2>{detail.order.orderNumber}</h2></div><button className="button button--quiet button--small" onClick={() => setSelectedId(null)}>Close</button></div>
          <div className="operations-detail-summary"><StatusBadge status={titleCase(detail.refund.status)} tone={tone(detail.refund.status)} /><span>{detail.refund.reason ?? detail.refund.failureReason ?? "No operator reason recorded."}</span><Link className="text-link" to={`/admin/orders/${detail.order.id}`}>Open order</Link></div>
          <dl className="admin-detail-list">
            <div><dt>Requested amount</dt><dd>{money(detail.refund.requestedAmount, detail.refund.currency)}</dd></div>
            <div><dt>Refunded amount</dt><dd>{detail.refund.refundedAmount ? money(detail.refund.refundedAmount, detail.refund.currency) : "Not settled"}</dd></div>
            <div><dt>Customer</dt><dd>{detail.customer?.name ?? detail.customer?.email ?? "Guest checkout"}</dd></div>
            <div><dt>Company</dt><dd>{detail.company?.name ?? "—"}</dd></div>
            <div><dt>Payment provider</dt><dd>{detail.payment?.provider ?? "—"}{detail.payment?.providerPaymentId ? ` · ${detail.payment.providerPaymentId}` : ""}</dd></div>
            <div><dt>Refund reference</dt><dd>{detail.refund.providerReference ?? "Not assigned"}</dd></div>
            <div><dt>Created</dt><dd>{new Date(detail.refund.createdAt).toLocaleString()}</dd></div>
            <div><dt>Updated</dt><dd>{new Date(detail.refund.updatedAt).toLocaleString()}</dd></div>
          </dl>
          {detail.returnRequest && <FormSection title="Related return" description={`${detail.returnRequest.reason} · ${titleCase(detail.returnRequest.status)}`}><p className="section-note">{detail.returnRequest.description ?? "No return description recorded."}</p></FormSection>}
          {detail.recoveryJobs.length > 0 && <FormSection title="Recovery history"><div className="admin-mini-list">{detail.recoveryJobs.map((job) => <div key={job.id}><span>{titleCase(job.operation)} · {titleCase(job.status)}</span><small>{job.attempts} attempt{job.attempts === 1 ? "" : "s"}{job.lastError ? ` · ${job.lastError}` : ""}</small></div>)}</div></FormSection>}
          <div className="admin-form-actions">{["pending", "processing"].includes(detail.refund.status) && canReconcile && <button className="button button--quiet button--small" disabled={busy || !detail.provider.configured} onClick={() => void reconcile()}>Queue reconciliation</button>}</div>
        </> : <EmptyState title="Inspect a refund" description="Choose a refund record to review its payment, order, customer, return, and recovery context." icon="receipt-text" />}
      </section>
      <section className="admin-panel">
        {detail ? <><div className="admin-panel__heading"><div><span className="eyebrow">Provider action</span><h2>Start a refund</h2></div></div>{!detail.provider.configured && <p className="admin-callout admin-callout--warning">Online refunds are not configured. This workspace is review-only until a payment provider is ready.</p>}{detail.provider.configured && !canManage && <p className="admin-callout admin-callout--warning">You can review refunds, but your role cannot initiate provider actions.</p>}{detail.provider.configured && canManage && detail.payment?.id && <form className="catalog-stack" onSubmit={(event) => { event.preventDefault(); void create(); }}><label className="catalog-field">Amount<input type="number" min="0.01" step="0.01" value={amount} onChange={(event) => setAmount(event.target.value)} required /></label><label className="catalog-field">Reason <span>Optional</span><textarea maxLength={500} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Why is this refund being requested?" /></label><button className="button button--dark button--small" disabled={busy}>{busy ? "Submitting…" : "Submit refund request"}</button><p className="section-note">The payment service validates remaining refundable amount, idempotency, and provider facts.</p></form>}{!detail.payment?.id && <p className="section-note">This record has no linked payment, so no provider action is available.</p>}</> : <EmptyState title="Provider actions" description="Select a refund to see whether review or reconciliation actions are available." icon="receipt-text" />}
      </section>
    </section>
  </div>;
}