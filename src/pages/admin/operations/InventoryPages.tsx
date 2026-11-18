import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { apiRequest } from "../../../auth/api";
import { useAuth } from "../../../auth/AuthContext";
import { AdminPageHeader, BulkActionBar, ConfirmationDialog, EmptyState, ErrorState, FilterBar, KpiCard, LoadingState, Pagination, SearchInput, StatusBadge } from "../../../components/admin/AdminPrimitives";

type Warehouse = { id: string; name: string; code: string; countryCode: string; active: boolean };
type InventoryItem = { id: string; warehouseId: string; warehouseName: string; warehouseCode: string; productId: string | null; variantId: string | null; sku: string; barcode: string | null; itemName: string; brandName: string | null; categoryName: string; quantityOnHand: number; quantityReserved: number; available: number; lowStockThreshold: number; active: boolean; productStatus: "draft" | "active" | "inactive" | "archived"; lifecycleActive: boolean; status: "out" | "low" | "in_stock" | "inactive"; updatedAt: string };
type Lookup = { id: string; name: string };
type InventoryScope = { productId: string; variantId: string | null; sku: string; name: string };
type Movement = { id: string; warehouseName: string; warehouseCode: string; sku: string; itemName: string; movementType: string; quantity: number; note: string | null; createdAt: string };
type PageResult<T> = { items: T[]; meta: { page: number; pageSize: number; total: number; hasNext: boolean } };
type Summary = { skus: number; onHand: number; reserved: number; available: number; lowStock: number; outOfStock: number };

function OperationsNav() {
  return <nav className="operations-tabs" aria-label="Inventory workspaces">
    <Link to="/admin/inventory">Inventory</Link><Link to="/admin/inventory/movements">Movements</Link><Link to="/admin/inventory/warehouses">Warehouses</Link>
  </nav>;
}

export function InventoryPage() {
  const [urlParams] = useSearchParams();
  const scopedProductId = urlParams.get("productId") ?? "";
  const { permissions } = useAuth();
  const [result, setResult] = useState<PageResult<InventoryItem> | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [warehouseId, setWarehouseId] = useState("");
  const [lifecycle, setLifecycle] = useState<"active" | "inactive" | "all">("active");
  const [status, setStatus] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [brandId, setBrandId] = useState("");
  const [sort, setSort] = useState("updated");
  const [categories, setCategories] = useState<Lookup[]>([]);
  const [brands, setBrands] = useState<Lookup[]>([]);
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<InventoryItem | null>(null);
  const [delta, setDelta] = useState("0");
  const [movementType, setMovementType] = useState<"purchase" | "return" | "damage" | "adjustment">("adjustment");
  const [threshold, setThreshold] = useState("0");
  const [note, setNote] = useState("");
  const [toWarehouseId, setToWarehouseId] = useState("");
  const [transferQuantity, setTransferQuantity] = useState("1");
  const [confirmAction, setConfirmAction] = useState<"adjust" | "transfer">("adjust");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [zeroOpen, setZeroOpen] = useState(false);
  const [statusOpen, setStatusOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteInput, setDeleteInput] = useState("");
  const [deletionEligibility, setDeletionEligibility] = useState<{ eligible: boolean; blockers: string[] } | null>(null);
  const [actionBusy, setActionBusy] = useState("");
  const [receiveOpen, setReceiveOpen] = useState(false);
  const [scopes, setScopes] = useState<InventoryScope[]>([]);
  const [receiveScope, setReceiveScope] = useState("");
  const [receiveScopeSearch, setReceiveScopeSearch] = useState("");
  const [receiveWarehouse, setReceiveWarehouse] = useState("");
  const [receiveDelta, setReceiveDelta] = useState("1");
  const [receiveMovementType, setReceiveMovementType] = useState<"purchase" | "return" | "damage" | "adjustment">("purchase");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkThreshold, setBulkThreshold] = useState("0");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [loading, setLoading] = useState(true);
  const query = useMemo(() => { const params = new URLSearchParams({ page: String(page), pageSize: "25", sort, lifecycle }); if (search) params.set("search", search); if (warehouseId) params.set("warehouseId", warehouseId); if (status) params.set("status", status); if (categoryId) params.set("categoryId", categoryId); if (brandId) params.set("brandId", brandId); if (scopedProductId) params.set("productId", scopedProductId); return params.toString(); }, [page, search, lifecycle, status, warehouseId, scopedProductId, categoryId, brandId, sort]);
  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const [inventory, lookupResponse] = await Promise.all([
        apiRequest<{ data: PageResult<InventoryItem> & { summary: Summary } }>(`/admin/inventory?${query}`),
        apiRequest<{ data: { warehouses: Warehouse[]; categories: Lookup[]; brands: Lookup[] } }>("/admin/inventory/lookups"),
      ]);
      setResult(inventory.data); setSummary(inventory.data.summary); setWarehouses(lookupResponse.data.warehouses); setCategories(lookupResponse.data.categories); setBrands(lookupResponse.data.brands); setSelectedIds(new Set());
    } catch (requestError) { setError(requestError instanceof Error ? requestError.message : "Inventory could not be loaded."); } finally { setLoading(false); }
  }, [query]);
  useEffect(() => { void load(); }, [load]);
  async function adjust() {
    if (!selected) return;
    try {
      const entered = Number(delta);
      const signedDelta = movementType === "damage" ? -Math.abs(entered) : movementType === "adjustment" ? entered : Math.abs(entered);
      await apiRequest("/admin/inventory/adjust", { method: "POST", body: JSON.stringify({ warehouseId: selected.warehouseId, productId: selected.productId, variantId: selected.variantId, delta: signedDelta, movementType, note }) });
      setConfirmOpen(false); setSelected(null); setDelta("0"); setNote(""); await load();
    } catch (requestError) { setError(requestError instanceof Error ? requestError.message : "Stock could not be adjusted."); setConfirmOpen(false); }
  }
  async function saveThreshold() {
    if (!selected) return;
    try { await apiRequest(`/admin/inventory/${selected.id}`, { method: "PATCH", body: JSON.stringify({ lowStockThreshold: Number(threshold) }) }); setSelected(null); await load(); }
    catch (requestError) { setError(requestError instanceof Error ? requestError.message : "Threshold could not be saved."); }
  }
  async function transfer() {
    if (!selected || !toWarehouseId) return;
    try {
      await apiRequest("/admin/inventory/transfer", { method: "POST", body: JSON.stringify({ fromWarehouseId: selected.warehouseId, toWarehouseId, productId: selected.productId, variantId: selected.variantId, quantity: Number(transferQuantity), note }) });
      setConfirmOpen(false); setSelected(null); setToWarehouseId(""); setTransferQuantity("1"); setNote(""); await load();
    } catch (requestError) { setError(requestError instanceof Error ? requestError.message : "Stock could not be transferred."); setConfirmOpen(false); }
  }
  async function setStockZero() {
    if (!selected) return;
    setActionBusy("zero");
    try { await apiRequest(`/admin/inventory/${selected.id}/zero`, { method: "POST" }); setSuccess("Stock was set to zero and the movement was recorded."); setZeroOpen(false); setSelected(null); await load(); }
    catch (requestError) { setError(requestError instanceof Error ? requestError.message : "Stock could not be set to zero."); setZeroOpen(false); }
    finally { setActionBusy(""); }
  }
  async function toggleActive() {
    if (!selected) return;
    setActionBusy("status");
    try { await apiRequest(`/admin/inventory/${selected.id}/status`, { method: "PATCH", body: JSON.stringify({ active: !selected.active }) }); setSuccess(selected.active ? "Inventory was deactivated." : "Inventory was reactivated."); setStatusOpen(false); setSelected(null); await load(); }
    catch (requestError) { setError(requestError instanceof Error ? requestError.message : "Inventory status could not be changed."); setStatusOpen(false); }
    finally { setActionBusy(""); }
  }
  async function checkDeletion() {
    if (!selected) return;
    setActionBusy("eligibility"); setDeletionEligibility(null); setDeleteInput("");
    try {
      const response = await apiRequest<{ data: { eligible: boolean; blockers: string[] } }>(`/admin/inventory/${selected.id}/deletion-eligibility`);
      setDeletionEligibility(response.data); setDeleteOpen(true);
    } catch (requestError) { setError(requestError instanceof Error ? requestError.message : "Deletion eligibility could not be checked."); }
    finally { setActionBusy(""); }
  }
  async function deleteInventory() {
    if (!selected || deleteInput !== "DELETE") return;
    setActionBusy("delete");
    try { await apiRequest(`/admin/inventory/${selected.id}`, { method: "DELETE", body: JSON.stringify({ confirmation: "DELETE" }) }); setSuccess("Inventory record permanently deleted."); setDeleteOpen(false); setSelected(null); setDeletionEligibility(null); await load(); }
    catch (requestError) { setError(requestError instanceof Error ? requestError.message : "Inventory record could not be deleted."); }
    finally { setActionBusy(""); }
  }
  async function importInventory(file: File) {
    const body = new FormData(); body.append("file", file);
    try { await apiRequest("/admin/inventory/import", { method: "POST", body }); await load(); }
    catch (requestError) { setError(requestError instanceof Error ? requestError.message : "Inventory could not be imported."); }
  }
  async function openReceive() {
    try { setScopes((await apiRequest<{ data: InventoryScope[] }>("/admin/inventory/scopes")).data); setReceiveOpen(true); }
    catch (requestError) { setError(requestError instanceof Error ? requestError.message : "SKU choices could not be loaded."); }
  }
  async function searchReceiveScopes() {
    try { setScopes((await apiRequest<{ data: InventoryScope[] }>(`/admin/inventory/scopes?search=${encodeURIComponent(receiveScopeSearch.trim())}`)).data); }
    catch (requestError) { setError(requestError instanceof Error ? requestError.message : "SKU choices could not be loaded."); }
  }
  async function receiveStock() {
    const scope = scopes.find((item) => `${item.variantId ? "variant" : "product"}:${item.variantId ?? item.productId}` === receiveScope);
    if (!scope || !receiveWarehouse) return;
    try {
      const entered = Number(receiveDelta);
      const signedDelta = receiveMovementType === "damage" ? -Math.abs(entered) : receiveMovementType === "adjustment" ? entered : Math.abs(entered);
      await apiRequest("/admin/inventory/adjust", { method: "POST", body: JSON.stringify({ warehouseId: receiveWarehouse, productId: scope.variantId ? null : scope.productId, variantId: scope.variantId, delta: signedDelta, movementType: receiveMovementType, note }) });
      setReceiveOpen(false); setReceiveScope(""); setReceiveWarehouse(""); setReceiveDelta("1"); setNote(""); await load();
    } catch (requestError) { setError(requestError instanceof Error ? requestError.message : "Initial stock could not be received."); }
  }
  async function applyBulkThreshold() {
    try { await apiRequest("/admin/inventory/bulk-threshold", { method: "POST", body: JSON.stringify({ ids: [...selectedIds], lowStockThreshold: Number(bulkThreshold) }) }); await load(); }
    catch (requestError) { setError(requestError instanceof Error ? requestError.message : "Bulk thresholds could not be saved."); }
  }
  return <div className="admin-page catalog-page">
    <AdminPageHeader eyebrow="Stock control" title="Inventory" description="Live stock by SKU and warehouse. Available stock always excludes reserved units." actions={<div className="catalog-header-actions">{permissions.includes("inventory.adjust") && <button className="button button--dark button--small" onClick={() => void openReceive()}>Receive / adjust SKU</button>}{permissions.includes("inventory.import") && <label className="button button--quiet button--small">Import CSV<input hidden type="file" accept=".csv,text/csv" onChange={(event) => { const file = event.target.files?.[0]; if (file) void importInventory(file); event.target.value = ""; }} /></label>}{permissions.includes("inventory.export") && <a className="button button--quiet button--small" href={`/api/v1/admin/inventory/export?${query}`}>Export CSV</a>}<Link className="button button--quiet button--small" to="/admin/inventory/movements">Movement history</Link></div>} />
    <OperationsNav />
    {summary && <section className="admin-kpi-grid"><KpiCard label="Tracked SKUs" value={summary.skus.toLocaleString()} /><KpiCard label="On hand" value={summary.onHand.toLocaleString()} /><KpiCard label="Reserved" value={summary.reserved.toLocaleString()} /><KpiCard label="Available" value={summary.available.toLocaleString()} tone="accent" /><KpiCard label="Low stock" value={summary.lowStock.toLocaleString()} /><KpiCard label="Out of stock" value={summary.outOfStock.toLocaleString()} /></section>}
    <section className="catalog-toolbar"><SearchInput value={searchInput} onChange={setSearchInput} onSubmit={() => { setSearch(searchInput.trim()); setPage(1); }} placeholder="Search SKU, barcode, product, variant, or warehouse…" /><FilterBar><label className="admin-filter">Lifecycle<select value={lifecycle} onChange={(event) => { setLifecycle(event.target.value as typeof lifecycle); setPage(1); }}><option value="active">Active</option><option value="inactive">Inactive</option><option value="all">All</option></select></label><select value={warehouseId} onChange={(event) => { setWarehouseId(event.target.value); setPage(1); }}><option value="">All warehouses</option>{warehouses.map((warehouse) => <option key={warehouse.id} value={warehouse.id}>{warehouse.name} ({warehouse.code})</option>)}</select><select value={categoryId} onChange={(event) => { setCategoryId(event.target.value); setPage(1); }}><option value="">All categories</option>{categories.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select><select value={brandId} onChange={(event) => { setBrandId(event.target.value); setPage(1); }}><option value="">All brands</option>{brands.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select><select value={status} onChange={(event) => { setStatus(event.target.value); setPage(1); }}><option value="">All stock states</option><option value="in_stock">In stock</option><option value="low">Low stock</option><option value="out">Out of stock</option></select><select value={sort} onChange={(event) => { setSort(event.target.value); setPage(1); }}><option value="updated">Recently updated</option><option value="sku">SKU</option><option value="available">Available stock</option><option value="on_hand">On-hand stock</option></select></FilterBar></section>
     {success && <div className="catalog-notice inventory-action-notice" role="status">{success}<button className="button button--quiet button--small" onClick={() => setSuccess("")}>Dismiss</button></div>}{error && <ErrorState title="Inventory action failed" description={error} onRetry={() => void load()} />}
    {receiveOpen && <section className="operations-action-panel"><div><strong>Receive or adjust stock</strong><small>This works even when the SKU has no existing inventory row.</small></div><label>Find SKU<input value={receiveScopeSearch} onChange={(event) => setReceiveScopeSearch(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void searchReceiveScopes(); }} placeholder="SKU, barcode, or name" /></label><button className="button button--quiet button--small" onClick={() => void searchReceiveScopes()}>Search</button><label>SKU<select value={receiveScope} onChange={(event) => setReceiveScope(event.target.value)}><option value="">Choose product or variant</option>{scopes.map((scope) => <option key={scope.variantId ?? scope.productId} value={`${scope.variantId ? "variant" : "product"}:${scope.variantId ?? scope.productId}`}>{scope.sku} · {scope.name}</option>)}</select></label><label>Warehouse<select value={receiveWarehouse} onChange={(event) => setReceiveWarehouse(event.target.value)}><option value="">Choose warehouse</option>{warehouses.filter((warehouse) => warehouse.active).map((warehouse) => <option key={warehouse.id} value={warehouse.id}>{warehouse.name}</option>)}</select></label><label>Movement type<select value={receiveMovementType} onChange={(event) => setReceiveMovementType(event.target.value as typeof receiveMovementType)}><option value="purchase">Purchase / receipt (+)</option><option value="return">Customer return (+)</option><option value="damage">Damage (-)</option><option value="adjustment">Manual adjustment (+/-)</option></select></label><label>Quantity change<input type="number" step="1" value={receiveDelta} onChange={(event) => setReceiveDelta(event.target.value)} /></label><label>Note<input value={note} onChange={(event) => setNote(event.target.value)} /></label><button className="button button--dark button--small" disabled={!receiveScope || !receiveWarehouse} onClick={() => void receiveStock()}>Post stock movement</button><button className="button button--quiet button--small" onClick={() => setReceiveOpen(false)}>Cancel</button></section>}
    <BulkActionBar selectedCount={selectedIds.size}><div className="catalog-bulk-controls"><label>Low-stock threshold<input type="number" min="0" step="1" value={bulkThreshold} onChange={(event) => setBulkThreshold(event.target.value)} /></label><button className="button button--dark button--small" onClick={() => void applyBulkThreshold()}>Apply to selected</button></div></BulkActionBar>
     {selected && <section className="operations-action-panel"><div><strong>{selected.itemName}</strong><small>{selected.sku} · {selected.warehouseName} · {selected.available} available</small><StatusBadge status={selected.active ? "Active" : "Inactive"} tone={selected.active ? "positive" : "neutral"} /></div>{permissions.includes("inventory.adjust") && <><label>Movement type<select value={movementType} onChange={(event) => setMovementType(event.target.value as typeof movementType)}><option value="purchase">Purchase / receipt (+)</option><option value="return">Customer return (+)</option><option value="damage">Damage (-)</option><option value="adjustment">Manual adjustment (+/-)</option></select></label><label>Quantity<input type="number" step="1" value={delta} onChange={(event) => setDelta(event.target.value)} /></label></>}<label>Low-stock threshold<input type="number" min="0" step="1" value={threshold} onChange={(event) => setThreshold(event.target.value)} /></label>{permissions.includes("inventory.transfer") && <><label>Transfer to<select value={toWarehouseId} onChange={(event) => setToWarehouseId(event.target.value)}><option value="">Choose warehouse</option>{warehouses.filter((warehouse) => warehouse.active && warehouse.id !== selected.warehouseId).map((warehouse) => <option key={warehouse.id} value={warehouse.id}>{warehouse.name}</option>)}</select></label><label>Transfer units<input type="number" min="1" step="1" value={transferQuantity} onChange={(event) => setTransferQuantity(event.target.value)} /></label></>}<label>Note<input value={note} onChange={(event) => setNote(event.target.value)} placeholder="Reason or reference" /></label><div className="catalog-inline-actions">{permissions.includes("inventory.adjust") && <button className="button button--dark button--small" onClick={() => { setConfirmAction("adjust"); setConfirmOpen(true); }}>Review stock adjustment</button>}{permissions.includes("inventory.transfer") && <button disabled={!toWarehouseId} className="button button--dark button--small" onClick={() => { setConfirmAction("transfer"); setConfirmOpen(true); }}>Review warehouse transfer</button>}{permissions.includes("inventory.adjust") && <button className="button button--quiet button--small" onClick={() => setZeroOpen(true)}>Set stock to zero</button>}{permissions.includes("inventory.edit") && <><button className="button button--quiet button--small" onClick={() => void saveThreshold()}>Save threshold</button><button className="button button--quiet button--small" onClick={() => setStatusOpen(true)}>{selected.active ? "Deactivate inventory" : "Reactivate inventory"}</button></>}{permissions.includes("inventory.delete") && <button className="button button--danger button--small" onClick={() => void checkDeletion()} disabled={actionBusy === "eligibility"}>{actionBusy === "eligibility" ? "Checking deletion…" : "Permanently delete"}</button>}<button className="button button--quiet button--small" onClick={() => setSelected(null)}>Close manage panel</button></div></section>}
     {loading ? <LoadingState label="Loading live inventory…" /> : result?.items.length ? <><div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>Select</th><th>SKU / barcode</th><th>Item</th><th>Category / brand</th><th>Warehouse</th><th>On hand</th><th>Reserved</th><th>Available</th><th>Threshold</th><th>Status</th><th>Updated</th><th /></tr></thead><tbody>{result.items.map((item) => <tr key={item.id}><td><input type="checkbox" checked={selectedIds.has(item.id)} onChange={() => setSelectedIds((current) => { const next = new Set(current); next.has(item.id) ? next.delete(item.id) : next.add(item.id); return next; })} /></td><td><code>{item.sku}</code><small className="table-subline">{item.barcode || "No barcode"}</small></td><td>{item.itemName}</td><td>{item.categoryName}<small className="table-subline">{item.brandName || "No brand"}</small></td><td>{item.warehouseName} <small>({item.warehouseCode})</small></td><td>{item.quantityOnHand}</td><td>{item.quantityReserved}</td><td><strong>{item.available}</strong></td><td>{item.lowStockThreshold}</td><td><StatusBadge status={item.active ? item.status.replace("_", " ") : "inactive"} tone={!item.active ? "neutral" : item.status === "out" ? "negative" : item.status === "low" ? "warning" : "positive"} /></td><td>{new Date(item.updatedAt).toLocaleString()}</td><td><button className="button button--quiet button--small" onClick={() => { setSelected(item); setThreshold(String(item.lowStockThreshold)); setDelta("0"); }}>Manage</button></td></tr>)}</tbody></table></div><Pagination page={result.meta.page} hasNext={result.meta.hasNext} onChange={setPage} /><p className="catalog-result-count">{result.meta.total.toLocaleString()} inventory records</p></> : <EmptyState title="No inventory records" description="Create a warehouse, then use Receive / adjust SKU to post the first real stock receipt. No sample stock has been added." icon="warehouse" />}
     <ConfirmationDialog open={confirmOpen} title={confirmAction === "transfer" ? "Confirm warehouse transfer" : "Confirm stock adjustment"} description={confirmAction === "transfer" ? `${transferQuantity} units of ${selected?.sku ?? "this SKU"} will move atomically to the selected warehouse. Transfer-out and transfer-in movements will both be recorded.` : `${delta} units will be applied to ${selected?.sku ?? "this SKU"} at ${selected?.warehouseName ?? "the warehouse"}. This creates an immutable movement record and cannot make available stock negative.`} confirmLabel={confirmAction === "transfer" ? "Transfer stock" : "Post adjustment"} onCancel={() => setConfirmOpen(false)} onConfirm={() => void (confirmAction === "transfer" ? transfer() : adjust())} />
     <ConfirmationDialog open={zeroOpen} title="Set stock to zero" description={`On hand: ${selected?.quantityOnHand ?? 0} · Reserved: ${selected?.quantityReserved ?? 0} · Available: ${selected?.available ?? 0}. This will record a stock adjustment and cannot be undone automatically.`} confirmLabel={actionBusy === "zero" ? "Setting stock…" : "Set stock to zero"} confirmDisabled={actionBusy === "zero"} onCancel={() => setZeroOpen(false)} onConfirm={() => void setStockZero()} />
      <ConfirmationDialog open={statusOpen} title={selected?.active ? "Deactivate inventory" : "Reactivate inventory"} description={selected?.active ? "This inventory row will be excluded from sellable availability and all new reservations. Existing stock, reservations, and movement history remain intact." : "This inventory row will become eligible for sellable availability and new reservations when stock is available."} confirmLabel={selected?.active ? "Deactivate inventory" : "Reactivate inventory"} confirmDisabled={actionBusy === "status"} onCancel={() => setStatusOpen(false)} onConfirm={() => void toggleActive()} />
      {deleteOpen && <div className="admin-dialog-backdrop" role="presentation"><div className="admin-dialog inventory-delete-dialog" role="dialog" aria-modal="true" aria-labelledby="inventory-delete-title"><span className="eyebrow">Destructive action</span><h2 id="inventory-delete-title">Delete inventory record permanently?</h2><p><strong>{selected?.itemName}</strong><br />SKU: {selected?.sku}<br />Warehouse: {selected?.warehouseName} ({selected?.warehouseCode})</p>{deletionEligibility?.eligible ? <><p>This inventory record is eligible for permanent deletion. This cannot be undone.</p><label className="catalog-delete-dialog__label">Type DELETE to confirm<input autoFocus value={deleteInput} onChange={(event) => setDeleteInput(event.target.value)} placeholder="DELETE" /></label></> : <><p>This record cannot be deleted because:</p><ul className="catalog-error-list">{deletionEligibility?.blockers.map((blocker) => <li key={blocker}>{blocker}</li>)}</ul></>}<div className="admin-dialog__actions"><button className="button button--quiet" onClick={() => setDeleteOpen(false)}>Close</button>{deletionEligibility?.eligible && <button className="button catalog-delete-dialog__confirm" disabled={deleteInput !== "DELETE" || actionBusy === "delete"} onClick={() => void deleteInventory()}>{actionBusy === "delete" ? "Deleting…" : "Permanently delete"}</button>}</div></div></div>}
  </div>;
}

export function MovementsPage() {
  const [result, setResult] = useState<PageResult<Movement> | null>(null);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [page, setPage] = useState(1);
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [warehouseId, setWarehouseId] = useState("");
  const [movementType, setMovementType] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: "25" });
      if (search) params.set("search", search);
      if (warehouseId) params.set("warehouseId", warehouseId);
      if (movementType) params.set("movementType", movementType);
      const [movements, lookups] = await Promise.all([
        apiRequest<{ data: PageResult<Movement> }>(`/admin/inventory/movements?${params}`),
        apiRequest<{ data: { warehouses: Warehouse[] } }>("/admin/inventory/lookups"),
      ]);
      setResult(movements.data);
      setWarehouses(lookups.data.warehouses);
      setError("");
    } catch (requestError) { setError(requestError instanceof Error ? requestError.message : "Movements could not be loaded."); } finally { setLoading(false); }
  }, [page, search, warehouseId, movementType]);
  useEffect(() => { void load(); }, [load]);
  return <div className="admin-page catalog-page"><AdminPageHeader eyebrow="Stock control" title="Movement history" description="An auditable ledger of every adjustment, import, return, damage event, and warehouse transfer." /><OperationsNav /><section className="catalog-toolbar"><SearchInput value={searchInput} onChange={setSearchInput} onSubmit={() => { setSearch(searchInput.trim()); setPage(1); }} placeholder="Search movements by SKU, item, or warehouse…" /><FilterBar><select value={warehouseId} onChange={(event) => { setWarehouseId(event.target.value); setPage(1); }}><option value="">All warehouses</option>{warehouses.map((warehouse) => <option key={warehouse.id} value={warehouse.id}>{warehouse.name} ({warehouse.code})</option>)}</select><select value={movementType} onChange={(event) => { setMovementType(event.target.value); setPage(1); }}><option value="">All movement types</option><option value="purchase">Purchase / receipt</option><option value="return">Customer return</option><option value="damage">Damage</option><option value="adjustment">Manual adjustment</option><option value="transfer_in">Transfer in</option><option value="transfer_out">Transfer out</option><option value="sale">Sale</option></select></FilterBar></section>{error && <ErrorState description={error} onRetry={() => void load()} />}{loading ? <LoadingState /> : result?.items.length ? <><div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>Date</th><th>SKU</th><th>Item</th><th>Warehouse</th><th>Type</th><th>Quantity change</th><th>Note</th></tr></thead><tbody>{result.items.map((movement) => <tr key={movement.id}><td>{new Date(movement.createdAt).toLocaleString()}</td><td><code>{movement.sku}</code></td><td>{movement.itemName}</td><td>{movement.warehouseName} ({movement.warehouseCode})</td><td><StatusBadge status={movement.movementType.replace("_", " ")} /></td><td><strong>{movement.quantity > 0 ? `+${movement.quantity}` : movement.quantity}</strong></td><td>{movement.note || "—"}</td></tr>)}</tbody></table></div><Pagination page={result.meta.page} hasNext={result.meta.hasNext} onChange={setPage} /></> : <EmptyState title="No movements match these filters" description="Stock adjustments, imports, returns, damage, and transfers will appear here." icon="receipt-text" />}</div>;
}

export function WarehousesPage() {
  const { permissions } = useAuth(); const [rows, setRows] = useState<Warehouse[]>([]); const [editing, setEditing] = useState<Warehouse | null>(null); const [form, setForm] = useState({ name: "", code: "", countryCode: "CY", active: true }); const [error, setError] = useState("");
  const load = useCallback(async () => { try { setRows((await apiRequest<{ data: Warehouse[] }>("/admin/warehouses")).data); setError(""); } catch (requestError) { setError(requestError instanceof Error ? requestError.message : "Warehouses could not be loaded."); } }, []);
  useEffect(() => { void load(); }, [load]);
  async function save() { try { await apiRequest(editing ? `/admin/warehouses/${editing.id}` : "/admin/warehouses", { method: editing ? "PATCH" : "POST", body: JSON.stringify(form) }); setEditing(null); setForm({ name: "", code: "", countryCode: "CY", active: true }); await load(); } catch (requestError) { setError(requestError instanceof Error ? requestError.message : "Warehouse could not be saved."); } }
  return <div className="admin-page catalog-page"><AdminPageHeader eyebrow="Stock control" title="Warehouses" description="Manage the active locations used for inventory availability and atomic transfers." /><OperationsNav />{error && <ErrorState description={error} onRetry={() => void load()} />}{permissions.includes("warehouse.manage") && <section className="operations-action-panel"><label>Name<input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></label><label>Code<input value={form.code} onChange={(event) => setForm({ ...form, code: event.target.value })} /></label><label>Country<input value={form.countryCode} maxLength={2} onChange={(event) => setForm({ ...form, countryCode: event.target.value.toUpperCase() })} /></label><label className="catalog-check"><input type="checkbox" checked={form.active} onChange={(event) => setForm({ ...form, active: event.target.checked })} /> Active</label><button className="button button--dark button--small" onClick={() => void save()}>{editing ? "Save warehouse" : "Add warehouse"}</button></section>}<div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>Name</th><th>Code</th><th>Country</th><th>Status</th><th /></tr></thead><tbody>{rows.map((warehouse) => <tr key={warehouse.id}><td>{warehouse.name}</td><td><code>{warehouse.code}</code></td><td>{warehouse.countryCode}</td><td><StatusBadge status={warehouse.active ? "Active" : "Inactive"} tone={warehouse.active ? "positive" : "neutral"} /></td><td>{permissions.includes("warehouse.manage") && <button className="button button--quiet button--small" onClick={() => { setEditing(warehouse); setForm({ name: warehouse.name, code: warehouse.code, countryCode: warehouse.countryCode, active: warehouse.active }); }}>Edit</button>}</td></tr>)}</tbody></table></div>{!rows.length && <EmptyState title="No warehouses yet" description="Add the first real stock location to begin tracking inventory." icon="warehouse" />}</div>;
}