import { useCallback, useEffect, useMemo, useState } from "react";
import { apiRequest } from "../../../auth/api";
import { useAuth } from "../../../auth/AuthContext";
import { AdminPageHeader, EmptyState, ErrorState, LoadingState, Pagination, SearchInput, StatusBadge } from "../../../components/admin/AdminPrimitives";
import { Icon } from "../../../components/ui/Icon";
import type { Category } from "./types";

type MappingStatus = "mapped" | "unmapped" | "needs_review" | "ignored" | string;

export interface SupplierCategoryMapping {
  id: string;
  supplierCategory?: string | null;
  supplierCategoryName?: string | null;
  supplierCategoryPath?: string | null;
  supplierPath?: string | null;
  externalCategoryName?: string | null;
  externalCategoryPath?: string | null;
  lizzorRoot?: string | null;
  lizzorSubcategory?: string | null;
  rootCategory?: string | null;
  subcategory?: string | null;
  rootCategoryId?: string | null;
  childCategoryId?: string | null;
  rootCategoryName?: string | null;
  childCategoryName?: string | null;
  status: MappingStatus;
  updatedAt?: string | null;
}

interface MappingResponse {
  items: SupplierCategoryMapping[];
  meta: { page: number; pageSize: number; total: number; hasNext: boolean };
}

interface MappingDraft {
  rootCategoryId: string;
  childCategoryId: string;
  status: string;
}

function unwrapMappings(response: { data: MappingResponse | SupplierCategoryMapping[] }): MappingResponse {
  if (Array.isArray(response.data)) return { items: response.data, meta: { page: 1, pageSize: response.data.length, total: response.data.length, hasNext: false } };
  return response.data;
}

function statusTone(status: string): "positive" | "warning" | "neutral" | "negative" {
  if (status === "mapped") return "positive";
  if (status === "needs_review") return "warning";
  if (status === "ignored" || status === "inactive") return "neutral";
  return "negative";
}

function statusLabel(status: string): string {
  return status === "needs_review" ? "Needs review" : status.charAt(0).toUpperCase() + status.slice(1);
}

export function SupplierCategoryMappingsPage() {
  const { permissions } = useAuth();
  const canManage = permissions.includes("supplier_category_mappings.manage");
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<MappingResponse | null>(null);
  const [categories, setCategories] = useState<Category[]>([]);
  const [drafts, setDrafts] = useState<Record<string, MappingDraft>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [bulkRootCategoryId, setBulkRootCategoryId] = useState("");
  const [bulkChildCategoryId, setBulkChildCategoryId] = useState("");
  const [bulkStatus, setBulkStatus] = useState("mapped");
  const [savingId, setSavingId] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [validationError, setValidationError] = useState("");

  const roots = useMemo(() => categories.filter((category) => !category.parentId && category.active), [categories]);
  const childrenFor = useCallback((rootId: string) => categories.filter((category) => category.parentId === rootId && category.active), [categories]);

  const endpoint = useMemo(() => {
    const query = new URLSearchParams({ page: String(page), pageSize: "25" });
    if (search.trim()) query.set("search", search.trim());
    if (status !== "all") query.set("status", status);
    return `/admin/supplier-category-mappings?${query.toString()}`;
  }, [page, search, status]);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await apiRequest<{ data: MappingResponse | SupplierCategoryMapping[] }>(endpoint);
      const next = unwrapMappings(response);
      setResult(next);
      setSelected((current) => current.filter((id) => next.items.some((item) => item.id === id)));
      setDrafts((current) => Object.fromEntries(next.items.map((item) => [item.id, current[item.id] ?? {
        rootCategoryId: item.rootCategoryId ?? "",
        childCategoryId: item.childCategoryId ?? "",
        status: item.status,
      }])));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Supplier category mappings could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, [endpoint]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    apiRequest<{ data: Category[] }>("/admin/catalog/supplier-category-mappings/categories")
      .then((response) => setCategories(response.data))
      .catch((reason) => setError(reason instanceof Error ? reason.message : "Canonical categories could not be loaded."));
  }, []);

  function draftFor(row: SupplierCategoryMapping): MappingDraft {
    return drafts[row.id] ?? {
      rootCategoryId: row.rootCategoryId ?? "",
      childCategoryId: row.childCategoryId ?? "",
      status: row.status,
    };
  }

  function updateDraft(id: string, patch: Partial<MappingDraft>) {
    setDrafts((current) => ({ ...current, [id]: { ...current[id], ...patch } }));
    setValidationError("");
  }

  function isValidDraft(draft: MappingDraft) {
    return draft.status !== "mapped" || Boolean(draft.rootCategoryId);
  }

  async function saveMapping(id: string) {
    const draft = drafts[id];
    if (!draft || !isValidDraft(draft)) {
      setValidationError("A mapped supplier category must have a Lizzor root category.");
      return;
    }
    setSavingId(id);
    setError("");
    try {
      await apiRequest(`/admin/supplier-category-mappings/${id}`, {
        method: "PATCH",
        body: JSON.stringify({
          rootCategoryId: draft.rootCategoryId || null,
          childCategoryId: draft.childCategoryId || null,
          status: draft.status,
        }),
      });
      setNotice("Mapping updated.");
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The mapping could not be updated.");
    } finally {
      setSavingId(null);
    }
  }

  async function updateSelected() {
    if (!selected.length) return;
    if (bulkStatus === "mapped" && !bulkRootCategoryId) {
      setValidationError("Choose a Lizzor root before applying the mapped status.");
      return;
    }
    setSavingId("bulk");
    setError("");
    try {
      await apiRequest("/admin/supplier-category-mappings/bulk", {
        method: "POST",
        body: JSON.stringify({
          ids: selected,
          rootCategoryId: bulkRootCategoryId || null,
          childCategoryId: bulkChildCategoryId || null,
          status: bulkStatus,
        }),
      });
      setNotice(`${selected.length} mapping${selected.length === 1 ? "" : "s"} updated.`);
      setSelected([]);
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The selected mappings could not be updated.");
    } finally {
      setSavingId(null);
    }
  }

  const rows = result?.items ?? [];
  const allSelected = rows.length > 0 && rows.every((row) => selected.includes(row.id));
  const bulkChildren = childrenFor(bulkRootCategoryId);

  return <div className="admin-page catalog-page supplier-mappings-page">
    <AdminPageHeader eyebrow="Catalog integration" title="Supplier category mapping" description="Review how supplier categories resolve into the Lizzor hierarchy before products are published." actions={<span className="foundation-chip"><span className="status-dot" /> Feed-ready workspace</span>} />
    {error && <ErrorState title="Mapping action failed" description={error} onRetry={() => void load()} />}
    {validationError && <p className="catalog-resolution-warning" role="alert">{validationError}</p>}
    {notice && <p className="catalog-notice" role="status">{notice}</p>}
    <section className="admin-panel">
      <div className="admin-panel__heading"><div><span className="eyebrow">Mappings</span><h2>Supplier categories</h2></div>{result && <span className="section-note">{result.meta.total} total</span>}</div>
      <div className="catalog-toolbar supplier-mappings-toolbar">
        <SearchInput value={search} onChange={(value) => { setSearch(value); setPage(1); }} placeholder="Search supplier category or path" />
        <label>Status<select aria-label="Filter mapping status" value={status} onChange={(event) => { setStatus(event.target.value); setPage(1); }}><option value="all">All statuses</option><option value="mapped">Mapped</option><option value="needs_review">Needs review</option><option value="unmapped">Unmapped</option><option value="ignored">Ignored</option></select></label>
      </div>
      {canManage && selected.length > 0 && <div className="admin-bulk-bar supplier-mappings-bulk"><strong>{selected.length} selected</strong><label>Lizzor root<select aria-label="Bulk Lizzor root" value={bulkRootCategoryId} onChange={(event) => { setBulkRootCategoryId(event.target.value); setBulkChildCategoryId(""); }}><option value="">No root</option>{roots.map((root) => <option value={root.id} key={root.id}>{root.name}</option>)}</select></label><label>Child<select aria-label="Bulk Lizzor child" value={bulkChildCategoryId} disabled={!bulkRootCategoryId} onChange={(event) => setBulkChildCategoryId(event.target.value)}><option value="">No child</option>{bulkChildren.map((child) => <option value={child.id} key={child.id}>{child.name}</option>)}</select></label><label>Status<select aria-label="Bulk mapping status" value={bulkStatus} onChange={(event) => setBulkStatus(event.target.value)}><option value="mapped">Mapped</option><option value="needs_review">Needs review</option><option value="unmapped">Unmapped</option><option value="ignored">Ignored</option></select></label><button className="button button--small button--dark" disabled={savingId === "bulk" || (bulkStatus === "mapped" && !bulkRootCategoryId)} onClick={() => void updateSelected()}>{savingId === "bulk" ? "Saving…" : "Apply mapping"}</button></div>}
      {loading ? <LoadingState label="Loading supplier mappings…" /> : error && !result ? null : rows.length ? <div className="admin-table-wrap supplier-mappings-table-wrap"><table className="admin-table supplier-mappings-table"><thead><tr><th scope="col">{canManage && <input type="checkbox" aria-label="Select all mappings" checked={allSelected} onChange={(event) => setSelected(event.target.checked ? rows.map((row) => row.id) : [])} />}</th><th scope="col">Supplier category / path</th><th scope="col">Lizzor root</th><th scope="col">Lizzor subcategory</th><th scope="col">Mapping status</th>{canManage && <th scope="col">Action</th>}</tr></thead><tbody>{rows.map((row) => {
        const supplierName = row.supplierCategoryName ?? row.externalCategoryName ?? row.supplierCategory ?? "Unnamed supplier category";
        const path = row.supplierCategoryPath ?? row.externalCategoryPath ?? row.supplierPath;
        const draft = draftFor(row);
        const childOptions = childrenFor(draft.rootCategoryId);
        const root = row.lizzorRoot ?? row.rootCategoryName ?? row.rootCategory ?? "—";
        const child = row.lizzorSubcategory ?? row.childCategoryName ?? row.subcategory ?? "—";
        return <tr key={row.id}><td>{canManage && <input type="checkbox" aria-label={`Select ${supplierName}`} checked={selected.includes(row.id)} onChange={(event) => setSelected((current) => event.target.checked ? [...current, row.id] : current.filter((id) => id !== row.id))} />}</td><td><strong>{supplierName}</strong>{path && <small className="supplier-mappings-path">{path}</small>}</td><td>{canManage ? <select aria-label={`Lizzor root for ${supplierName}`} value={draft.rootCategoryId} disabled={savingId === row.id} onChange={(event) => updateDraft(row.id, { rootCategoryId: event.target.value, childCategoryId: "" })}><option value="">No root</option>{roots.map((category) => <option value={category.id} key={category.id}>{category.name}</option>)}</select> : root}</td><td>{canManage ? <select aria-label={`Lizzor subcategory for ${supplierName}`} value={draft.childCategoryId} disabled={savingId === row.id || !draft.rootCategoryId} onChange={(event) => updateDraft(row.id, { childCategoryId: event.target.value })}><option value="">No child</option>{childOptions.map((category) => <option value={category.id} key={category.id}>{category.name}</option>)}</select> : child}</td><td><div className="supplier-mappings-status">{canManage ? <select aria-label={`Mapping status for ${supplierName}`} value={draft.status} disabled={savingId === row.id} onChange={(event) => updateDraft(row.id, { status: event.target.value })}><option value="mapped">Mapped</option><option value="needs_review">Needs review</option><option value="unmapped">Unmapped</option><option value="ignored">Ignored</option></select> : <StatusBadge status={statusLabel(row.status)} tone={statusTone(row.status)} />}</div></td>{canManage && <td><button className="button button--small button--dark" disabled={savingId === row.id || !isValidDraft(draft)} onClick={() => void saveMapping(row.id)}>Save</button>{draft.status === "mapped" && !draft.rootCategoryId && <small className="supplier-mappings-invalid">Choose a root</small>}</td>}</tr>;
      })}</tbody></table></div> : <EmptyState icon="layers-3" title={result?.meta.total ? "No mappings match those filters" : "Supplier category mappings are ready"} description={result?.meta.total ? "Try a different search or status filter." : "No supplier feed is connected yet. Mappings will appear here when the first supplier category import is available."} />}
      {result && rows.length > 0 && <Pagination page={result.meta.page} hasNext={result.meta.hasNext} onChange={setPage} />}
    </section>
    <p className="supplier-mappings-note"><Icon name="circle-help" size={14} /> Mapping changes affect future supplier imports only; the server remains authoritative for product category scope.</p>
  </div>;
}