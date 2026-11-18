import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { apiRequest } from "../../../auth/api";
import { useAuth } from "../../../auth/AuthContext";
import { AdminPageHeader, BulkActionBar, ConfirmationDialog, EmptyState, ErrorState, LoadingState, Pagination, SearchInput, StatusBadge } from "../../../components/admin/AdminPrimitives";

type PricingItem = {
  productId: string; productName: string; parentSku: string; productBasePrice: number; productCostPrice?: number;
  variantId: string | null; variantSku: string | null; variantTitle: string | null; variantBasePrice: number | null; variantCostPrice?: number | null; tierCount: number;
  lowestTierPrice: number | null; lowestTierMargin?: number | null;
};
type Tier = { id?: string; minQuantity: number; maxQuantity: number | null; unitPrice: number; active: boolean };
type Quote = { quantity: number; unitPrice: number; totalPrice: number; source: string; costPrice?: number; margin?: number; marginPercent?: number | null };

const euro = (value: number) => new Intl.NumberFormat("en", { style: "currency", currency: "EUR" }).format(value);

export function PricingPage() {
  const [urlParams] = useSearchParams();
  const scopedProductId = urlParams.get("productId") ?? "";
  const { permissions } = useAuth();
  const [items, setItems] = useState<PricingItem[]>([]);
  const [meta, setMeta] = useState({ page: 1, hasNext: false, total: 0 });
  const [page, setPage] = useState(1);
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<PricingItem | null>(null);
  const [tiers, setTiers] = useState<Tier[]>([]);
  const [quantity, setQuantity] = useState("1");
  const [quote, setQuote] = useState<Quote | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selectedScopes, setSelectedScopes] = useState<Set<string>>(new Set());
  const [bulkType, setBulkType] = useState<"percent" | "amount">("percent");
  const [bulkValue, setBulkValue] = useState("0");
  const [copySource, setCopySource] = useState("");
  const [pending, setPending] = useState<{ kind: "bulk" | "import"; previewId: string; description: string } | null>(null);
  const [removeAllOpen, setRemoveAllOpen] = useState(false);
  const canEdit = permissions.includes("pricing.edit");
  const canCost = permissions.includes("product_cost.view");
  const query = useMemo(() => { const params = new URLSearchParams({ page: String(page), pageSize: "25" }); if (search) params.set("search", search); if (scopedProductId) params.set("productId", scopedProductId); return params.toString(); }, [page, search, scopedProductId]);
  const load = useCallback(async () => {
    setLoading(true);
    try { const response = await apiRequest<{ data: { items: PricingItem[]; meta: { page: number; hasNext: boolean; total: number } } }>(`/admin/pricing?${query}`); setItems(response.data.items); setMeta(response.data.meta); setSelectedScopes(new Set()); setError(""); }
    catch (requestError) { setError(requestError instanceof Error ? requestError.message : "Pricing could not be loaded."); } finally { setLoading(false); }
  }, [query]);
  useEffect(() => { void load(); }, [load]);
  async function select(item: PricingItem) {
    try {
      const path = item.variantId ? `/admin/pricing/variant/${item.variantId}/tiers` : `/admin/pricing/product/${item.productId}/tiers`;
      setTiers((await apiRequest<{ data: Tier[] }>(path)).data); setSelected(item); setQuote(null); setError("");
    } catch (requestError) { setError(requestError instanceof Error ? requestError.message : "Pricing tiers could not be loaded."); }
  }
  async function save() {
    if (!selected) return;
    try {
      await apiRequest("/admin/pricing/tiers", { method: "PUT", body: JSON.stringify({ productId: selected.variantId ? null : selected.productId, variantId: selected.variantId, tiers }) });
      await select(selected); await load();
    } catch (requestError) { setError(requestError instanceof Error ? requestError.message : "Pricing tiers could not be saved."); }
  }
  async function removeAllTiers() {
    if (!selected) return;
    try {
      await apiRequest("/admin/pricing/tiers", { method: "PUT", body: JSON.stringify({ ...scopeBody(selected), tiers: [] }) });
      setTiers([]);
      setItems((current) => current.map((item) => scopeKey(item) === scopeKey(selected) ? { ...item, tierCount: 0, lowestTierPrice: null, lowestTierMargin: null } : item));
      setSelected((current) => current ? { ...current, tierCount: 0, lowestTierPrice: null, lowestTierMargin: null } : null);
      setRemoveAllOpen(false);
      await load();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Pricing tiers could not be removed.");
      setRemoveAllOpen(false);
    }
  }
  async function preview() {
    if (!selected) return;
    try {
      const params = new URLSearchParams({ productId: selected.productId, quantity });
      if (selected.variantId) params.set("variantId", selected.variantId);
      setQuote((await apiRequest<{ data: Quote }>(`/admin/pricing/quote?${params}`)).data); setError("");
    } catch (requestError) { setError(requestError instanceof Error ? requestError.message : "The price could not be calculated."); }
  }
  async function importPricing(file: File) {
    const body = new FormData(); body.append("file", file);
    try { const response = await apiRequest<{ data: { previewId: string; scopes: number; rows: number } }>("/admin/pricing/import/preview", { method: "POST", body }); setPending({ kind: "import", previewId: response.data.previewId, description: `${response.data.rows} rows across ${response.data.scopes} pricing scopes passed validation. Confirm to replace those scopes atomically.` }); }
    catch (requestError) { setError(requestError instanceof Error ? requestError.message : "Pricing could not be imported."); }
  }
  const scopeKey = (item: PricingItem) => item.variantId ? `variant:${item.variantId}` : `product:${item.productId}`;
  const scopeBody = (item: PricingItem) => ({ productId: item.variantId ? null : item.productId, variantId: item.variantId });
  async function previewBulk() {
    const targets = items.filter((item) => selectedScopes.has(scopeKey(item))).map(scopeBody);
    try {
      const response = await apiRequest<{ data: { previewId: string; targetCount: number; affectedTiers: number } }>("/admin/pricing/bulk/preview", { method: "POST", body: JSON.stringify({ targets, adjustmentType: bulkType, value: Number(bulkValue) }) });
      setPending({ kind: "bulk", previewId: response.data.previewId, description: `${response.data.affectedTiers} tiers across ${response.data.targetCount} scopes will be adjusted. Confirm to apply all validated changes.` });
    } catch (requestError) { setError(requestError instanceof Error ? requestError.message : "Bulk pricing could not be previewed."); }
  }
  async function confirmPending() {
    if (!pending) return;
    try { await apiRequest(`/admin/pricing/${pending.kind === "bulk" ? "bulk" : "import"}/commit`, { method: "POST", body: JSON.stringify({ previewId: pending.previewId }) }); setPending(null); await load(); }
    catch (requestError) { setError(requestError instanceof Error ? requestError.message : "Pricing changes could not be committed."); setPending(null); }
  }
  async function copySelected() {
    const source = items.find((item) => scopeKey(item) === copySource);
    if (!source) return;
    const targets = items.filter((item) => selectedScopes.has(scopeKey(item)) && scopeKey(item) !== copySource).map(scopeBody);
    try { await apiRequest("/admin/pricing/copy", { method: "POST", body: JSON.stringify({ sourceProductId: source.variantId ? null : source.productId, sourceVariantId: source.variantId, targets }) }); await load(); }
    catch (requestError) { setError(requestError instanceof Error ? requestError.message : "Pricing tiers could not be copied."); }
  }
  return <div className="admin-page catalog-page">
    <AdminPageHeader eyebrow="Wholesale operations" title="Quantity pricing" description="Manage deterministic product and variant quantity tiers. Quantity 1 is always allowed; a base price fills any uncovered range." actions={<div className="catalog-header-actions">{permissions.includes("pricing.import") && <label className="button button--quiet button--small">Import CSV<input hidden type="file" accept=".csv,text/csv" onChange={(event) => { const file = event.target.files?.[0]; if (file) void importPricing(file); event.target.value = ""; }} /></label>}{permissions.includes("pricing.export") && <a className="button button--quiet button--small" href={`/api/v1/admin/pricing/export?${query}`}>Export CSV</a>}</div>} />
    <section className="pricing-precedence"><strong>Pricing precedence</strong><span>Variant tier</span><i>→</i><span>Variant base price</span><i>→</i><span>Product tier</span><i>→</i><span>Product base price</span></section>
    <SearchInput value={searchInput} onChange={setSearchInput} onSubmit={() => { setSearch(searchInput.trim()); setPage(1); }} placeholder="Search product or SKU…" />
    {error && <ErrorState title="Pricing action failed" description={error} onRetry={() => void load()} />}
    <BulkActionBar selectedCount={selectedScopes.size}><div className="catalog-bulk-controls"><select value={bulkType} onChange={(event) => setBulkType(event.target.value as "percent" | "amount")}><option value="percent">Adjust tier prices by %</option><option value="amount">Adjust tier prices by amount</option></select><input type="number" step="0.01" value={bulkValue} onChange={(event) => setBulkValue(event.target.value)} /><button className="button button--dark button--small" disabled={!permissions.includes("pricing.bulk")} onClick={() => void previewBulk()}>Preview adjustment</button><select value={copySource} onChange={(event) => setCopySource(event.target.value)}><option value="">Choose copy source</option>{items.map((item) => <option key={scopeKey(item)} value={scopeKey(item)}>{item.variantSku || item.parentSku}</option>)}</select><button className="button button--quiet button--small" disabled={!canEdit || !copySource || selectedScopes.size < 1} onClick={() => void copySelected()}>Copy tiers to selected</button></div></BulkActionBar>
    {selected && <section className="pricing-editor">
      <div className="pricing-editor__heading"><div><span className="eyebrow">{selected.variantId ? "Variant pricing" : "Product pricing"}</span><h2>{selected.variantTitle || selected.productName}</h2><p><code>{selected.variantSku || selected.parentSku}</code> · Base {euro(selected.variantBasePrice ?? selected.productBasePrice)}</p></div><button className="button button--quiet button--small" onClick={() => setSelected(null)}>Close</button></div>
      <div className="pricing-tier-list">{tiers.map((tier, index) => <div className="pricing-tier-row" key={tier.id ?? index}>
        <label>Minimum<input type="number" min="1" step="1" value={tier.minQuantity} disabled={!canEdit} onChange={(event) => setTiers((current) => current.map((row, position) => position === index ? { ...row, minQuantity: Number(event.target.value) } : row))} /></label>
        <label>Maximum<input type="number" min={tier.minQuantity} step="1" value={tier.maxQuantity ?? ""} placeholder="Open ended" disabled={!canEdit} onChange={(event) => setTiers((current) => current.map((row, position) => position === index ? { ...row, maxQuantity: event.target.value ? Number(event.target.value) : null } : row))} /></label>
        <label>Unit price<input type="number" min="0" step="0.01" value={tier.unitPrice} disabled={!canEdit} onChange={(event) => setTiers((current) => current.map((row, position) => position === index ? { ...row, unitPrice: Number(event.target.value) } : row))} /></label>
        <label className="catalog-check"><input type="checkbox" checked={tier.active} disabled={!canEdit} onChange={(event) => setTiers((current) => current.map((row, position) => position === index ? { ...row, active: event.target.checked } : row))} /> Active</label>
        {canEdit && <button className="button button--quiet button--small" onClick={() => setTiers((current) => current.filter((_, position) => position !== index))}>Remove</button>}
      </div>)}</div>
      {canEdit && <div className="catalog-inline-actions"><button className="button button--quiet button--small" onClick={() => setTiers((current) => [...current, { minQuantity: current.length ? (current[current.length - 1]?.maxQuantity ?? current[current.length - 1]!.minQuantity) + 1 : 1, maxQuantity: null, unitPrice: selected.variantBasePrice ?? selected.productBasePrice, active: true }])}>Add tier</button>{tiers.length > 0 && <button className="button button--quiet button--small pricing-remove-all" onClick={() => setRemoveAllOpen(true)}>Remove all tiers</button>}<button className="button button--dark button--small" onClick={() => void save()}>Save tiers</button></div>}
      <div className="pricing-preview"><label>Preview quantity<input type="number" min="1" step="1" value={quantity} onChange={(event) => setQuantity(event.target.value)} /></label><button className="button button--quiet button--small" onClick={() => void preview()}>Calculate</button>{quote && <div><strong>{euro(quote.unitPrice)} each</strong><span>{euro(quote.totalPrice)} total · {quote.source.replace("_", " ")}</span>{canCost && quote.margin !== undefined && <span>{euro(quote.margin)} margin per unit{quote.marginPercent !== null && quote.marginPercent !== undefined ? ` · ${quote.marginPercent}%` : ""}</span>}</div>}</div>
    </section>}
    {loading ? <LoadingState label="Loading wholesale pricing…" /> : items.length ? <><div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>Select</th><th>Product</th><th>SKU</th><th>Scope</th><th>Base price</th><th>Lowest tier</th>{canCost && <><th>Cost</th><th>Tier margin</th></>}<th>Tiers</th><th /></tr></thead><tbody>{items.map((item) => <tr key={scopeKey(item)}><td><input type="checkbox" checked={selectedScopes.has(scopeKey(item))} onChange={() => setSelectedScopes((current) => { const next = new Set(current); next.has(scopeKey(item)) ? next.delete(scopeKey(item)) : next.add(scopeKey(item)); return next; })} aria-label={`Select ${item.variantSku || item.parentSku}`} /></td><td><strong>{item.productName}</strong>{item.variantTitle && <small className="table-subline">{item.variantTitle}</small>}</td><td><code>{item.variantSku || item.parentSku}</code></td><td><StatusBadge status={item.variantId ? "Variant" : "Product"} /></td><td>{euro(item.variantBasePrice ?? item.productBasePrice)}</td><td>{item.lowestTierPrice === null ? "—" : euro(item.lowestTierPrice)}</td>{canCost && <><td>{euro(item.variantCostPrice ?? item.productCostPrice ?? 0)}</td><td>{item.lowestTierMargin === null || item.lowestTierMargin === undefined ? "—" : euro(item.lowestTierMargin)}</td></>}<td>{item.tierCount}</td><td><button className="button button--quiet button--small" onClick={() => void select(item)}>Manage tiers</button></td></tr>)}</tbody></table></div><Pagination page={meta.page} hasNext={meta.hasNext} onChange={setPage} /><p className="catalog-result-count">{meta.total.toLocaleString()} pricing scopes</p></> : <EmptyState title="No pricing scopes" description="Products and variants appear here as soon as they are added to the catalog." />}
    <ConfirmationDialog open={Boolean(pending)} title={pending?.kind === "import" ? "Confirm pricing import" : "Confirm bulk pricing adjustment"} description={pending?.description ?? ""} confirmLabel={pending?.kind === "import" ? "Apply import" : "Apply adjustment"} onCancel={() => setPending(null)} onConfirm={() => void confirmPending()} />
    <ConfirmationDialog open={removeAllOpen} title="Remove all quantity tiers?" description={`This will remove every quantity tier for ${selected?.variantTitle || selected?.productName || "this scope"} (${selected?.variantSku || selected?.parentSku || "no SKU"}).`} confirmLabel="Remove all tiers" onCancel={() => setRemoveAllOpen(false)} onConfirm={() => void removeAllTiers()} />
  </div>;
}