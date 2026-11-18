import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { apiRequest } from "../../../auth/api";
import { useAuth } from "../../../auth/AuthContext";
import {
  AdminPageHeader,
  BulkActionBar,
  ConfirmationDialog,
  EmptyState,
  ErrorState,
  FilterBar,
  LoadingState,
  Pagination,
  SearchInput,
  StatusBadge,
} from "../../../components/admin/AdminPrimitives";
import { Icon } from "../../../components/ui/Icon";
import type { CatalogLookups, ProductSummary } from "./types";

interface ProductListResponse {
  items: ProductSummary[];
  meta: { page: number; pageSize: number; total: number; hasNext: boolean };
}

type DeletionEligibility = {
  eligible: boolean;
  product: { id: string; name: string; parentSku: string; status: ProductSummary["status"] };
  blockers: {
    cartItems: number;
    orderItems: number;
    inventoryReservations: number;
    inventoryMovements: number;
    promotionUsages: number;
  };
  removable: unknown;
};

function deletionBlockerSummary(blockers: DeletionEligibility["blockers"]): string {
  const labels: Array<[keyof typeof blockers, string]> = [
    ["orderItems", "order history"],
    ["cartItems", "customer carts"],
    ["inventoryReservations", "inventory reservations"],
    ["inventoryMovements", "inventory movement history"],
    ["promotionUsages", "historical promotion usage"],
  ];
  const present = labels.filter(([key]) => blockers[key] > 0).map(([, label]) => label);
  return present.length ? ` Protected references found: ${present.join(", ")}.` : "";
}

type FilterState = {
  status: string;
  categoryId: string;
  brandId: string;
  published: string;
  featured: string;
  hasVariants: string;
  sort: string;
};

const defaultFilters: FilterState = {
  status: "active",
  categoryId: "",
  brandId: "",
  published: "",
  featured: "",
  hasVariants: "",
  sort: "updated",
};

function money(value: number): string {
  return new Intl.NumberFormat("en", { style: "currency", currency: "EUR" }).format(value);
}

function statusTone(status: ProductSummary["status"]): "neutral" | "positive" | "warning" | "negative" {
  if (status === "active") return "positive";
  if (status === "draft") return "warning";
  if (status === "archived") return "negative";
  return "neutral";
}

export function ProductListPage() {
  const { permissions } = useAuth();
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [filters, setFilters] = useState(defaultFilters);
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<ProductListResponse | null>(null);
  const [lookups, setLookups] = useState<CatalogLookups>({ categories: [], brands: [] });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkAction, setBulkAction] = useState("publish");
  const [bulkTarget, setBulkTarget] = useState("");
  const [loading, setLoading] = useState(true);
  const [archivingId, setArchivingId] = useState("");
  const [availabilityId, setAvailabilityId] = useState("");
  const [archiveTarget, setArchiveTarget] = useState<ProductSummary | null>(null);
  const [activeActionsId, setActiveActionsId] = useState("");
  const [eligibilityTarget, setEligibilityTarget] = useState<DeletionEligibility | null>(null);
  const [checkingDeletionId, setCheckingDeletionId] = useState("");
  const [deletingId, setDeletingId] = useState("");
  const [confirmationName, setConfirmationName] = useState("");
  const deleteNameInput = useRef<HTMLInputElement>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const canCreate = permissions.includes("products.create");
  const canEdit = permissions.includes("products.edit");
  const canArchive = permissions.includes("products.archive");
  const canDelete = permissions.includes("products.delete");
  const canImport = permissions.includes("products.import");
  const canExport = permissions.includes("products.export");

  const query = useMemo(() => {
    const params = new URLSearchParams({ page: String(page), pageSize: "25", sort: filters.sort });
    if (search) params.set("search", search);
    for (const [key, value] of Object.entries(filters)) if (value && key !== "sort") params.set(key, value);
    return params.toString();
  }, [filters, page, search]);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [products, lookupResult] = await Promise.all([
        apiRequest<{ data: ProductListResponse }>(`/admin/products?${query}`),
        apiRequest<{ data: CatalogLookups }>("/admin/catalog/lookups"),
      ]);
      setResult(products.data);
      setLookups(lookupResult.data);
      setSelected(new Set());
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "The product catalog could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, [query]);

  useEffect(() => { void load(); }, [load]);

  function updateFilter(key: keyof FilterState, value: string) {
    setFilters((current) => ({ ...current, [key]: value }));
    setPage(1);
  }

  async function applyBulk() {
    if (!selected.size) return;
    const body: Record<string, unknown> = { ids: [...selected], action: bulkAction };
    if (bulkAction === "assign_category") body.categoryId = bulkTarget;
    if (bulkAction === "assign_brand") body.brandId = bulkTarget || null;
    if ((bulkAction === "assign_category" || bulkAction === "assign_brand") && !bulkTarget) {
      setError("Choose a destination before applying this bulk action.");
      return;
    }
    try {
      await apiRequest("/admin/products/bulk", { method: "POST", body: JSON.stringify(body) });
      setNotice(`${selected.size} product${selected.size === 1 ? "" : "s"} updated.`);
      await load();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "The bulk action could not be completed.");
    }
  }

  async function archiveProduct() {
    if (!archiveTarget || archivingId) return;
    setArchivingId(archiveTarget.id);
    setError("");
    try {
      const restoring = archiveTarget.status === "archived";
      await apiRequest(`/admin/products/${archiveTarget.id}/archive`, { method: "POST", body: JSON.stringify({ restore: restoring }) });
      setNotice(restoring ? `${archiveTarget.name} restored.` : `${archiveTarget.name} archived. Historical orders and records remain unchanged.`);
      setArchiveTarget(null);
      await load();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "The product could not be archived.");
    } finally {
      setArchivingId("");
    }
  }

  async function setProductAvailability(product: ProductSummary) {
    if (availabilityId) return;
    setAvailabilityId(product.id);
    setActiveActionsId("");
    setError("");
    try {
      const status = product.status === "active" ? "inactive" : "active";
      await apiRequest(`/admin/products/${product.id}/lifecycle`, { method: "POST", body: JSON.stringify({ status }) });
      setNotice(product.status === "active" ? `${product.name} deactivated. It is unavailable on the storefront; historical records remain unchanged.` : `${product.name} reactivated.`);
      await load();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "The product availability could not be changed.");
    } finally {
      setAvailabilityId("");
    }
  }

  async function checkDeletionEligibility(product: ProductSummary) {
    setActiveActionsId("");
    setCheckingDeletionId(product.id);
    setError("");
    try {
      const response = await apiRequest<{ data: DeletionEligibility }>(`/admin/products/${product.id}/deletion-eligibility`);
      setEligibilityTarget(response.data);
      setConfirmationName("");
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Deletion eligibility could not be checked.");
    } finally {
      setCheckingDeletionId("");
    }
  }

  async function deleteProduct() {
    if (!eligibilityTarget || !eligibilityTarget.eligible || confirmationName !== eligibilityTarget.product.name || deletingId) return;
    setDeletingId(eligibilityTarget.product.id);
    setError("");
    try {
      await apiRequest(`/admin/products/${eligibilityTarget.product.id}`, { method: "DELETE", body: JSON.stringify({ confirmationName }) });
      setNotice(`${eligibilityTarget.product.name} was permanently deleted.`);
      setEligibilityTarget(null);
      setConfirmationName("");
      await load();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "The product could not be permanently deleted.");
    } finally {
      setDeletingId("");
    }
  }

  useEffect(() => {
    if (eligibilityTarget?.eligible) deleteNameInput.current?.focus();
  }, [eligibilityTarget]);

  useEffect(() => {
    if (!eligibilityTarget || deletingId) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setEligibilityTarget(null);
        setConfirmationName("");
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [deletingId, eligibilityTarget]);

  const allSelected = Boolean(result?.items.length) && result!.items.every((product) => selected.has(product.id));
  const exportQuery = selected.size ? `?ids=${encodeURIComponent([...selected].join(","))}` : `?${query}`;

  return <div className="admin-page catalog-page">
    <AdminPageHeader
      eyebrow="Catalog management"
      title="Products"
      description="Manage parent products, variants, publishing, and catalog organization from the live database."
      actions={<div className="catalog-header-actions">
        {canExport && <a className="button button--quiet button--small" href={`/api/v1/admin/products/export${exportQuery}`}><Icon name="arrow-up-right" size={15} /> Export CSV</a>}
        {canImport && <Link className="button button--quiet button--small" to="/admin/products/import">Import</Link>}
        {canCreate && <Link className="button button--dark button--small" to="/admin/products/new"><Icon name="plus" size={15} /> Add product</Link>}
      </div>}
    />

    <section className="catalog-toolbar">
      <SearchInput value={searchInput} onChange={setSearchInput} onSubmit={() => { setSearch(searchInput.trim()); setPage(1); }} placeholder="Search products, SKUs, barcodes, brands, categories…" />
      <FilterBar>
        <select value={filters.status} onChange={(event) => updateFilter("status", event.target.value)} aria-label="Filter by status">
          <option value="active">Active</option><option value="inactive">Inactive</option><option value="all">All</option>
        </select>
        <select value={filters.categoryId} onChange={(event) => updateFilter("categoryId", event.target.value)} aria-label="Filter by category">
          <option value="">All categories</option>{lookups.categories.map((category) => <option key={category.id} value={category.id}>{category.name}{category.active ? "" : " (inactive)"}</option>)}
        </select>
        <select value={filters.brandId} onChange={(event) => updateFilter("brandId", event.target.value)} aria-label="Filter by brand">
          <option value="">All brands</option>{lookups.brands.map((brand) => <option key={brand.id} value={brand.id}>{brand.name}{brand.active ? "" : " (inactive)"}</option>)}
        </select>
        <select value={filters.published} onChange={(event) => updateFilter("published", event.target.value)} aria-label="Filter by publishing">
          <option value="">Published or unpublished</option><option value="true">Published</option><option value="false">Unpublished</option>
        </select>
        <select value={filters.featured} onChange={(event) => updateFilter("featured", event.target.value)} aria-label="Filter Best Sellers">
          <option value="">Best Sellers or standard</option><option value="true">Best Sellers</option><option value="false">Not in Best Sellers</option>
        </select>
        <select value={filters.hasVariants} onChange={(event) => updateFilter("hasVariants", event.target.value)} aria-label="Filter products with variants">
          <option value="">Simple or variant products</option><option value="true">Has variants</option><option value="false">No variants</option>
        </select>
        <select value={filters.sort} onChange={(event) => updateFilter("sort", event.target.value)} aria-label="Sort products">
          <option value="updated">Recently updated</option><option value="name">Name</option><option value="price">Base price</option><option value="status">Status</option><option value="created">Recently created</option>
        </select>
        <button className="button button--quiet button--small" type="button" onClick={() => { setFilters(defaultFilters); setSearch(""); setSearchInput(""); setPage(1); }}>Clear</button>
      </FilterBar>
    </section>

    {error && <ErrorState title="Catalog action failed" description={error} onRetry={() => void load()} />}
    {notice && <p className="catalog-notice" role="status">{notice}</p>}
    <BulkActionBar selectedCount={selected.size}>
      <div className="catalog-bulk-controls">
        <select value={bulkAction} onChange={(event) => { setBulkAction(event.target.value); setBulkTarget(""); }} aria-label="Choose bulk action">
          {canEdit && <><option value="publish">Publish / activate</option><option value="unpublish">Unpublish / deactivate</option><option value="feature">Add to Best Sellers</option><option value="unfeature">Remove from Best Sellers</option><option value="new_arrival">Mark new arrival</option><option value="not_new_arrival">Remove new arrival</option><option value="assign_category">Assign category</option><option value="assign_brand">Assign brand</option></>}
          {canArchive && <option value="archive">Archive</option>}
        </select>
        {bulkAction === "assign_category" && <select value={bulkTarget} onChange={(event) => setBulkTarget(event.target.value)} aria-label="Bulk category"><option value="">Choose category</option>{lookups.categories.filter((item) => item.active).map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select>}
        {bulkAction === "assign_brand" && <select value={bulkTarget} onChange={(event) => setBulkTarget(event.target.value)} aria-label="Bulk brand"><option value="">Choose brand</option>{lookups.brands.filter((item) => item.active).map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select>}
        <button className="button button--dark button--small" onClick={() => void applyBulk()}>Apply</button>
      </div>
    </BulkActionBar>

    {loading ? <LoadingState label="Loading catalog products…" /> : result && result.items.length ? <>
      <div className="admin-table-wrap admin-table-wrap--scroll catalog-table-wrap" role="region" tabIndex={0} aria-label="Catalog products">
        <table className="admin-table catalog-table">
          <thead><tr>
            <th><input type="checkbox" checked={allSelected} onChange={() => setSelected(allSelected ? new Set() : new Set(result.items.map((product) => product.id)))} aria-label="Select all products on this page" /></th>
             <th>Product</th><th>Homepage placement</th><th>SKU</th><th>Brand</th><th>Category</th><th>Base price</th><th>Variants</th><th>Status</th><th>Published</th><th>Updated</th><th>Actions</th>
          </tr></thead>
          <tbody>{result.items.map((product) => <tr key={product.id}>
            <td><input type="checkbox" checked={selected.has(product.id)} onChange={() => setSelected((current) => { const next = new Set(current); next.has(product.id) ? next.delete(product.id) : next.add(product.id); return next; })} aria-label={`Select ${product.name}`} /></td>
            <td><Link className="catalog-product-cell" to={`/admin/products/${product.id}`}>
              {product.thumbnailUrl ? <img src={product.thumbnailUrl} alt="" loading="lazy" /> : <span className="catalog-thumbnail"><Icon name="package" size={17} /></span>}
               <span><strong>{product.name}</strong><small>{product.newArrival ? "New arrival" : "Standard product"}</small></span>
            </Link></td>
             <td><div className="catalog-placement-badges" aria-label={`Homepage placement: ${product.featured || product.homepageWholesale ? [product.featured && "Best Sellers", product.homepageWholesale && "Live wholesale pricing"].filter(Boolean).join(", ") : "None"}`}>{product.featured && <span className="catalog-placement-badge">Best Sellers</span>}{product.homepageWholesale && <span className="catalog-placement-badge">Live wholesale pricing</span>}{!product.featured && !product.homepageWholesale && <span className="catalog-placement-badge catalog-placement-badge--muted">None</span>}</div></td>
            <td><code>{product.parentSku}</code></td>
            <td>{product.brand?.name ?? "—"}</td><td>{product.category.name}</td><td>{money(product.basePrice)}</td><td>{product.variantCount}</td>
             <td><StatusBadge status={product.status} tone={statusTone(product.status)} /></td>
            <td><StatusBadge status={product.published ? "Published" : "Unpublished"} tone={product.published ? "positive" : "neutral"} /></td>
            <td><time dateTime={product.updatedAt}>{new Date(product.updatedAt).toLocaleDateString()}</time></td>
            <td><div className="catalog-row-actions">
              <div className="catalog-actions-menu">
                <button className="button button--quiet button--small" type="button" aria-haspopup="menu" aria-expanded={activeActionsId === product.id} onClick={() => setActiveActionsId((current) => current === product.id ? "" : product.id)}>
                  Actions <span aria-hidden="true">▾</span>
                </button>
                {activeActionsId === product.id && <div className="catalog-actions-menu__items" role="menu" aria-label={`Actions for ${product.name}`}>
                  {canEdit && <Link role="menuitem" to={`/admin/products/${product.id}`} onClick={() => setActiveActionsId("")}>Edit</Link>}
                   {canEdit && (product.status === "active" || product.status === "inactive") && <button role="menuitem" type="button" disabled={availabilityId === product.id} onClick={() => void setProductAvailability(product)}>
                     {availabilityId === product.id ? "Updating…" : product.status === "active" ? "Deactivate" : "Reactivate"}
                   </button>}
                  {canArchive && <button role="menuitem" type="button" disabled={archivingId === product.id} onClick={() => { setActiveActionsId(""); setArchiveTarget(product); }}>
                    {product.status === "archived" ? "Restore" : "Archive"}
                  </button>}
                  {canDelete && product.status === "archived" && <button role="menuitem" className="catalog-actions-menu__delete" type="button" disabled={checkingDeletionId === product.id} onClick={() => void checkDeletionEligibility(product)}>
                    {checkingDeletionId === product.id ? "Checking eligibility…" : "Delete permanently"}
                  </button>}
                </div>}
              </div>
            </div></td>
          </tr>)}</tbody>
        </table>
      </div>
      <Pagination page={result.meta.page} hasNext={result.meta.hasNext} onChange={setPage} />
      <p className="catalog-result-count">{result.meta.total.toLocaleString()} products · {result.meta.pageSize} per page</p>
    </> : <EmptyState title="No products yet" description="Add your first product or import a validated catalog file. No sample products have been created." icon="package" />}
    <ConfirmationDialog
      open={Boolean(archiveTarget)}
       title={archiveTarget?.status === "archived" ? "Restore product?" : "Archive product?"}
       description={archiveTarget ? archiveTarget.status === "archived" ? `${archiveTarget.name} · SKU ${archiveTarget.parentSku}. This product will be available in the catalog again.` : `${archiveTarget.name} · SKU ${archiveTarget.parentSku}. This product will be removed from the active storefront. Historical orders and records will remain unchanged.` : ""}
       confirmLabel={archivingId ? (archiveTarget?.status === "archived" ? "Restoring…" : "Archiving…") : (archiveTarget?.status === "archived" ? "Restore product" : "Archive product")}
      confirmDisabled={Boolean(archivingId)}
      onConfirm={() => void archiveProduct()}
      onCancel={() => { if (!archivingId) setArchiveTarget(null); }}
    />
    {eligibilityTarget && <div className="admin-dialog-backdrop" role="presentation" onMouseDown={deletingId ? undefined : () => { setEligibilityTarget(null); setConfirmationName(""); }}>
      <div className="admin-dialog catalog-delete-dialog" role="dialog" aria-modal="true" aria-labelledby="permanent-delete-title" aria-describedby="permanent-delete-description" onMouseDown={(event) => event.stopPropagation()}>
        <span className="eyebrow">Permanent deletion</span>
        <h2 id="permanent-delete-title">{eligibilityTarget.eligible ? "Delete product permanently?" : "This product cannot be deleted"}</h2>
        {eligibilityTarget.eligible ? <>
          <p id="permanent-delete-description"><strong>{eligibilityTarget.product.name}</strong> will be permanently deleted. This action is irreversible and cannot be undone.</p>
          <label className="catalog-delete-dialog__label" htmlFor="permanent-delete-name">Type <strong>{eligibilityTarget.product.name}</strong> exactly to confirm.
            <input ref={deleteNameInput} id="permanent-delete-name" value={confirmationName} onChange={(event) => setConfirmationName(event.target.value)} autoComplete="off" disabled={Boolean(deletingId)} />
          </label>
        </> : <p id="permanent-delete-description">This product must remain archived to preserve order, accounting, reservation, or inventory history.{deletionBlockerSummary(eligibilityTarget.blockers)}</p>}
        <div className="admin-dialog__actions">
          <button className="button button--quiet" disabled={Boolean(deletingId)} onClick={() => { setEligibilityTarget(null); setConfirmationName(""); }}>{eligibilityTarget.eligible ? "Cancel" : "Close"}</button>
          {eligibilityTarget.eligible && <button className="button button--dark catalog-delete-dialog__confirm" disabled={confirmationName !== eligibilityTarget.product.name || Boolean(deletingId)} onClick={() => void deleteProduct()}>{deletingId ? "Deleting…" : "Delete permanently"}</button>}
        </div>
      </div>
    </div>}
  </div>;
}