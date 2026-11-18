import { useCallback, useEffect, useState } from "react";
import { apiRequest } from "../../../auth/api";
import { EmptyState, ErrorState, Pagination, SearchInput, StatusBadge } from "../../../components/admin/AdminPrimitives";
import { EUROPEAN_COUNTRIES } from "../../../../shared/europeanCountries";
type R = Record<string, any>;
const money = (value: any) => value == null ? "—" : `EUR ${Number(value).toFixed(2)}`;
const overrideSource = (source: unknown) => source === "link" ? "Linked product or variant" : source === "variant" ? "Catalogue variant" : source === "item" ? "Catalogue item" : "Unknown";
const supplierCategoryName = (name: unknown, id: unknown) => {
  const normalizedName = typeof name === "string" ? name.trim() : "";
  const normalizedId = typeof id === "string" ? id.trim() : "";
  return normalizedName && normalizedName !== normalizedId ? normalizedName : null;
};

export function TooniesCategoryEditor({ canManage }: { canManage: boolean }) {
  const [rows, setRows] = useState<R[]>([]), [options, setOptions] = useState<R[]>([]), [drafts, setDrafts] = useState<R>({}), [meta, setMeta] = useState<R>({ page: 1, total: 0, hasNext: false }), [page, setPage] = useState(1), [search, setSearch] = useState(""), [status, setStatus] = useState(""), [error, setError] = useState("");
  const load = useCallback(async () => { try { const q = new URLSearchParams({ page: String(page), pageSize: "20" }); if (search.trim()) q.set("search", search.trim()); if (status) q.set("status", status); const [m, c] = await Promise.all([apiRequest<{ data: { items: R[]; meta: R } }>(`/admin/suppliers/toonies/categories?${q}`), apiRequest<{ data: R[] }>("/admin/catalog/supplier-category-mappings/categories")]); setRows(m.data.items); setMeta(m.data.meta); setOptions(c.data); setDrafts(Object.fromEntries(m.data.items.map((x) => [x.id, { rootCategoryId: x.rootCategoryId ?? "", childCategoryId: x.childCategoryId ?? "", status: x.status }]))); setError(""); } catch (e) { setError(e instanceof Error ? e.message : "Mappings could not be loaded."); } }, [page, search, status]);
  useEffect(() => { void load(); }, [load]);
  const roots = options.filter((x) => !x.parentId);
  async function save(row: R) { const d = drafts[row.id]; try { await apiRequest(`/admin/suppliers/toonies/categories/${row.id}`, { method: "PATCH", body: JSON.stringify({ rootCategoryId: d.rootCategoryId || null, childCategoryId: d.childCategoryId || null, status: d.status }) }); void load(); } catch (e) { setError(e instanceof Error ? e.message : "Mapping could not be saved."); } }
  return <TooniesCategoryMappingSurface canManage={canManage} error={error} onRetry={() => void load()} rows={rows} roots={roots} options={options} drafts={drafts} setDrafts={setDrafts} save={save} meta={meta} page={page} setPage={setPage} search={search} setSearch={setSearch} status={status} setStatus={setStatus} />;
}

function TooniesCategoryMappingSurface({ canManage, error, onRetry, rows, roots, options, drafts, setDrafts, save, meta, page, setPage, search, setSearch, status, setStatus }: R) {
  const [preview, setPreview] = useState<R | null>(null);
  useEffect(() => {
    if (!preview) return;
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") setPreview(null); };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [preview]);
  const discoveredLabel = `${meta.total} discovered ${meta.total === 1 ? "category" : "categories"}`;
  return <section className="admin-panel toonies-section toonies-category-mapping">
    <div className="admin-panel__heading">
      <div><span className="eyebrow">Compliance boundary</span><h2>Category mapping</h2></div>
      <span className="section-note">{discoveredLabel}</span>
    </div>
    <p className="toonies-panel-note">Use synchronized product samples as evidence, then map each supplier category manually. Mapping never enables publication automatically.</p>
    <div className="toonies-category-filters"><SearchInput value={search} onChange={(value) => { setSearch(value); setPage(1); }} placeholder="Search ID, name, or path" /><label><span>Status</span><select value={status} onChange={(event) => { setStatus(event.target.value); setPage(1); }}><option value="">All statuses</option><option value="needs_review">Needs review</option><option value="mapped">Mapped</option><option value="unmapped">Unmapped</option><option value="ignored">Ignored</option></select></label></div>
    {error && <ErrorState description={error} onRetry={onRetry} />}
    {rows.length ? <div className="toonies-category-mapping-list" role="list" aria-label="Toonies category mappings">{rows.map((row: R) => {
      const d = drafts[row.id] ?? {};
      const children = options.filter((x: R) => x.parentId === d.rootCategoryId);
       const complianceExcluded = Boolean(row.complianceExcluded);
      const publicationEnabled = Boolean(row.publicationEnabled);
       const categoryName = supplierCategoryName(row.externalCategoryName, row.externalCategoryId);
      return <article className="toonies-category-mapping-card" role="listitem" key={row.id} aria-labelledby={`toonies-category-${row.id}`}>
        <header className="toonies-category-mapping-card__header"><div><span className="eyebrow">Toonies category</span><h3 id={`toonies-category-${row.id}`}>Category ID <code>{row.externalCategoryId}</code></h3><p>{categoryName || "Name unavailable from Toonies API"}</p>{row.externalCategoryPath && <small>{row.externalCategoryPath}</small>}</div></header>
        <section className="toonies-category-samples" aria-label={`Sample products for category ${row.externalCategoryId}`}><span className="toonies-category-samples__label">Sample products</span>{row.sampleProducts?.length ? <div className="toonies-category-samples__grid">{row.sampleProducts.map((product: R) => <article key={product.id}>{product.thumbnailUrl ? <button type="button" className="toonies-category-samples__image" aria-label={`Preview image for ${product.title}`} onClick={() => setPreview(product)}><img src={product.thumbnailUrl} alt="" loading="lazy" /></button> : <div className="toonies-category-samples__image"><span aria-hidden="true">TO</span></div>}<div><strong title={product.title}>{product.title}</strong><small>{product.productCode}</small></div></article>)}</div> : <p>No product samples available yet.</p>}</section>
        <span className="toonies-category-map-label">Map to Lizzor</span>
        <div className="toonies-category-mapping-flow">
          <label><span>Lizzor root category</span><select disabled={!canManage} value={d.rootCategoryId} aria-label={`Root for category ${row.externalCategoryId}`} onChange={(e) => setDrafts({ ...drafts, [row.id]: { ...d, rootCategoryId: e.target.value, childCategoryId: "" } })}><option value="">Not mapped</option>{roots.map((x: R) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></label>
          <span className="toonies-category-mapping-flow__arrow" aria-hidden="true">→</span>
          <label><span>Lizzor child category</span><select disabled={!canManage || !d.rootCategoryId} value={d.childCategoryId} aria-label={`Child for category ${row.externalCategoryId}`} onChange={(e) => setDrafts({ ...drafts, [row.id]: { ...d, childCategoryId: e.target.value } })}><option value="">No child</option>{children.map((x: R) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></label>
        </div>
        <div className="toonies-category-mapping-card__meta">
          <label><span>Mapping status</span><select disabled={!canManage} value={d.status} aria-label={`Status for category ${row.externalCategoryId}`} onChange={(e) => setDrafts({ ...drafts, [row.id]: { ...d, status: e.target.value } })}><option value="needs_review">Needs review</option><option value="mapped">Mapped</option><option value="unmapped">Unmapped</option><option value="ignored">Ignored</option></select></label>
          <div><span>Compliance</span><StatusBadge status={complianceExcluded ? "Excluded" : "Eligible"} tone={complianceExcluded ? "warning" : "positive"} /></div>
          <div><span>Publication</span><StatusBadge status={publicationEnabled ? "Enabled" : "Excluded"} tone={publicationEnabled ? "positive" : "warning"} /></div>
          <button type="button" className="button button--small button--dark" disabled={!canManage} onClick={() => void save(row)}>Save mapping</button>
        </div>
      </article>;
    })}</div> : <EmptyState icon="layers-3" title="No category mappings" description="No synchronized supplier categories match these filters." />}
    {rows.length > 0 && <Pagination page={page} hasNext={Boolean(meta.hasNext)} onChange={setPage} />}
    {preview && <div className="toonies-image-preview" role="dialog" aria-modal="true" aria-labelledby="toonies-image-preview-title" onMouseDown={(event) => { if (event.target === event.currentTarget) setPreview(null); }}><div className="toonies-image-preview__dialog"><div className="toonies-image-preview__header"><div><span className="eyebrow">Synchronized sample</span><h3 id="toonies-image-preview-title">{preview.title}</h3><small>{preview.productCode}</small></div><button type="button" className="icon-button" aria-label="Close image preview" onClick={() => setPreview(null)}>×</button></div><img src={preview.thumbnailUrl} alt={preview.title} /></div></div>}
  </section>;
}

export function TooniesPricingEditor({ canPrice }: { canPrice: boolean }) {
  const [rules, setRules] = useState<R[]>([]), [reviews, setReviews] = useState<R[]>([]), [pending, setPending] = useState<string | null>(null), [editing, setEditing] = useState<string | null>(null), [error, setError] = useState(""), [draft, setDraft] = useState<R>({ name: "Toonies band", ruleType: "markup_percent", minCostEur: 0, maxCostEur: null, value: 35, roundingMode: "99", priority: 10, active: false, significantCostIncreasePercent: 20 });
  const load = useCallback(async () => { try { const [pricing, held] = await Promise.all([apiRequest<{ data: R[] }>("/admin/suppliers/toonies/pricing"), apiRequest<{ data: R[] }>("/admin/suppliers/toonies/pricing/reviews")]); setRules(pricing.data); setReviews(held.data); setError(""); } catch (e) { setError(e instanceof Error ? e.message : "Pricing information could not be loaded."); } }, []);
  useEffect(() => { void load(); }, [load]);
  function edit(x: R) { setEditing(x.id); setDraft({ name: x.name, ruleType: x.ruleType, minCostEur: Number(x.minCostEur ?? 0), maxCostEur: x.maxCostEur == null ? null : Number(x.maxCostEur), value: Number(x.value), roundingMode: x.roundingMode, priority: Number(x.priority ?? 0), active: Boolean(x.active), significantCostIncreasePercent: Number(x.significantCostIncreasePercent ?? 20) }); }
  async function save() { setError(""); if (draft.maxCostEur !== null && draft.maxCostEur <= draft.minCostEur) { setError("Cost band maximum must be greater than its minimum."); return; } try { await apiRequest(editing ? `/admin/suppliers/toonies/pricing/${editing}` : "/admin/suppliers/toonies/pricing", { method: editing ? "PATCH" : "POST", body: JSON.stringify(draft) }); setEditing(null); void load(); } catch (e) { setError(e instanceof Error ? e.message : "Pricing rule could not be saved."); } }
  async function decide(id: string, decision: "accept" | "reject") { setPending(id); setError(""); try { await apiRequest(`/admin/suppliers/toonies/pricing/reviews/${id}/decision`, { method: "POST", body: JSON.stringify({ decision }) }); await load(); } catch (e) { setError(e instanceof Error ? e.message : "The price review could not be resolved."); } finally { setPending(null); } }
  return <><section className="admin-panel toonies-section toonies-price-reviews"><div className="admin-panel__heading"><div><span className="eyebrow">Items held offline</span><h2>Price-change review</h2></div><span className="section-note">{reviews.length} pending</span></div><p className="toonies-panel-note">Significant supplier cost increases stay unavailable until an administrator accepts the latest authoritative proposal.</p>{error && <p className="catalog-resolution-warning" role="alert">{error}</p>}{reviews.length ? <div className="toonies-price-review-list">{reviews.map((review) => <article key={review.id}><header><div><span className="eyebrow">{review.variantId ? "Variant hold" : "Product hold"}</span><h3>{review.productName}{review.variantName ? ` — ${review.variantName}` : ""}</h3><small>{review.skuCode || review.productCode || "No SKU"}</small></div><StatusBadge status={`+${Number(review.increasePercent).toFixed(1)}%`} tone="warning" /></header><div className="toonies-price-review-values"><div><span>Cost</span><strong>{money(review.previousCostEur)} <b aria-hidden="true">→</b> {money(review.proposedCostEur)}</strong></div><div><span>Previous commerce price</span><strong>{money(review.previousPriceEur)}</strong></div><div><span>Formula price</span><strong>{money(review.formulaPriceEur)}</strong></div>{review.manualOverrideEur != null && <div className="toonies-price-review-override"><span>Manual selling-price override active</span><strong>Manual price: {money(review.manualOverrideEur)}</strong><small>Override source: {overrideSource(review.manualOverrideSource)}</small></div>}<div><span>Final proposed price</span><strong>{money(review.proposedPriceEur)}</strong></div><div><span>Pricing band</span><strong>{review.pricingRuleName || String(review.pricingRuleType || "Stored policy").replaceAll("_", " ")}</strong><small>{review.pricingMinCostEur ?? 0}–{review.pricingMaxCostEur ?? "∞"} EUR · threshold {Number(review.thresholdPercent)}%</small>{review.pricingRuleValue != null && <small>Snapshot value {Number(review.pricingRuleValue)} · {review.pricingRoundingMode || "none"} rounding</small>}</div></div><footer><small>Detected {new Date(review.detectedAt).toLocaleString()} · {review.reason || "Significant supplier cost increase"}</small><div><button className="button button--small button--quiet" disabled={!canPrice || pending === review.id} onClick={() => void decide(review.id, "reject")}>Reject / keep offline</button><button className="button button--small button--dark" disabled={!canPrice || pending === review.id} onClick={() => void decide(review.id, "accept")}>{pending === review.id ? "Working…" : "Accept latest price"}</button></div></footer></article>)}</div> : <EmptyState icon="badge-check" title="No held price changes" description="New significant supplier increases will appear here before affected merchandise can return online." />}</section><section className="admin-panel toonies-section"><div className="admin-panel__heading"><div><span className="eyebrow">Commercial guardrails</span><h2>Pricing bands</h2></div></div><div className="toonies-form-grid"><label>Name<input disabled={!canPrice} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></label><label>Rule<select disabled={!canPrice} value={draft.ruleType} onChange={(e) => setDraft({ ...draft, ruleType: e.target.value })}><option value="markup_percent">Markup percent</option><option value="markup_fixed">Markup fixed</option><option value="margin_percent">Margin percent</option></select></label><label>Minimum cost EUR<input disabled={!canPrice} type="number" min="0" value={draft.minCostEur} onChange={(e) => setDraft({ ...draft, minCostEur: Number(e.target.value) })} /></label><label>Maximum cost EUR<input disabled={!canPrice} type="number" min="0" placeholder="No maximum" value={draft.maxCostEur ?? ""} onChange={(e) => setDraft({ ...draft, maxCostEur: e.target.value === "" ? null : Number(e.target.value) })} /></label><label>Value<input disabled={!canPrice} type="number" min="0" value={draft.value} onChange={(e) => setDraft({ ...draft, value: Number(e.target.value) })} /></label><label>Rounding<select disabled={!canPrice} value={draft.roundingMode} onChange={(e) => setDraft({ ...draft, roundingMode: e.target.value })}><option value="none">No rounding</option><option value="whole">Whole EUR</option><option value="99">.99 pricing</option></select></label><label>Significant increase threshold %<input disabled={!canPrice} type="number" min="0" value={draft.significantCostIncreasePercent} onChange={(e) => setDraft({ ...draft, significantCostIncreasePercent: Number(e.target.value) })} /></label><label>Active<select disabled={!canPrice} value={String(draft.active)} onChange={(e) => setDraft({ ...draft, active: e.target.value === "true" })}><option value="false">Inactive</option><option value="true">Active</option></select></label></div><button className="button button--small button--dark" disabled={!canPrice} onClick={() => void save()}>{editing ? "Update pricing band" : "Save pricing band"}</button>{rules.length ? <div className="toonies-rule-list">{rules.map((x) => <div key={x.id}><strong>{x.name}</strong><span>{x.minCostEur ?? 0}–{x.maxCostEur ?? "∞"} EUR · {x.value} · {x.roundingMode} · threshold {x.significantCostIncreasePercent}%</span><StatusBadge status={x.active ? "Active" : "Inactive"} tone={x.active ? "positive" : "neutral"} /><button className="button button--small button--quiet" disabled={!canPrice} onClick={() => edit(x)}>Edit</button></div>)}</div> : <EmptyState icon="badge-percent" title="No pricing bands" description="Create an inactive band first, then activate it after checking overlap." />}</section></>;
}

type ShippingDraft = {
  countryCode: string;
  destinationType: "country" | "zone";
  destinationZoneId: string;
  minWeightKg: string;
  maxWeightKg: string;
  amountEur: string;
  minDeliveryDays: string;
  maxDeliveryDays: string;
  active: boolean;
};

const emptyShippingDraft = (): ShippingDraft => ({
  countryCode: "",
  destinationType: "country",
  destinationZoneId: "",
  minWeightKg: "0",
  maxWeightKg: "",
  amountEur: "",
  minDeliveryDays: "",
  maxDeliveryDays: "",
  active: true,
});

export function TooniesShippingEditor({ canView, canManage }: { canView: boolean; canManage: boolean }) {
  const [rules, setRules] = useState<R[]>([]);
  const [zones, setZones] = useState<R[]>([]);
  const [draft, setDraft] = useState<ShippingDraft>(emptyShippingDraft);
  const [editing, setEditing] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const activeRules = rules.filter((rule) => rule.active);
  const destinations = new Set(activeRules.map((rule) => rule.countryCode || rule.destinationZoneId).filter(Boolean));
  const maxWeight = activeRules.reduce((max, rule) => Math.max(max, Number(rule.maxWeightKg ?? rule.minWeightKg ?? 0)), 0);
  const deliveryValues = activeRules.flatMap((rule) => [Number(rule.minDeliveryDays), Number(rule.maxDeliveryDays)]).filter((value) => Number.isFinite(value) && value > 0);

  const load = useCallback(async () => {
    if (!canView) return;
    setLoading(true);
    try {
      const [ruleResponse, zoneResponse] = await Promise.all([
        apiRequest<{ data: R[] }>("/admin/suppliers/toonies/shipping"),
        apiRequest<{ data: R[] }>("/admin/suppliers/toonies/shipping/zones"),
      ]);
      setRules(ruleResponse.data);
      setZones(Array.isArray(zoneResponse.data) ? zoneResponse.data : []);
      setError("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Shipping rules could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, [canView]);
  useEffect(() => { void load(); }, [load]);

  function edit(rule: R) {
    setEditing(rule.id);
    setDraft({
      countryCode: rule.countryCode ?? "",
      destinationType: rule.destinationZoneId ? "zone" : "country",
      destinationZoneId: rule.destinationZoneId ?? "",
      minWeightKg: String(rule.minWeightKg ?? 0),
      maxWeightKg: rule.maxWeightKg == null ? "" : String(rule.maxWeightKg),
      amountEur: String(rule.amountEur ?? ""),
      minDeliveryDays: rule.minDeliveryDays == null ? "" : String(rule.minDeliveryDays),
      maxDeliveryDays: rule.maxDeliveryDays == null ? "" : String(rule.maxDeliveryDays),
      active: Boolean(rule.active),
    });
  }
  function cancel() { setEditing(null); setDraft(emptyShippingDraft()); setError(""); }
  async function save() {
    setError("");
    const numeric = (value: string) => value === "" ? null : Number(value);
    const payload = {
      countryCode: draft.destinationType === "country" ? draft.countryCode.trim().toUpperCase() || null : null,
      destinationZoneId: draft.destinationType === "zone" ? draft.destinationZoneId || null : null,
      minWeightKg: numeric(draft.minWeightKg) ?? 0,
      maxWeightKg: numeric(draft.maxWeightKg),
      amountEur: numeric(draft.amountEur),
      minDeliveryDays: numeric(draft.minDeliveryDays),
      maxDeliveryDays: numeric(draft.maxDeliveryDays),
      temporary: true,
      active: draft.active,
      expiresAt: null,
    };
    if (payload.amountEur === null) { setError("Enter a EUR amount."); return; }
    try {
      const isExistingRule = Boolean(editing && editing !== "new");
      await apiRequest(isExistingRule ? `/admin/suppliers/toonies/shipping/${editing}` : "/admin/suppliers/toonies/shipping", {
        method: isExistingRule ? "PATCH" : "POST",
        body: JSON.stringify(payload),
      });
      cancel();
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Shipping rule could not be saved.");
    }
  }

  if (!canView) return null;
  return <section className="admin-panel toonies-section toonies-shipping-manager">
    <div className="admin-panel__heading">
      <div><span className="eyebrow">Toonies supplier</span><h2>Shipping rules</h2></div>
      {canManage && !editing && <button className="button button--small button--dark" onClick={() => { setEditing("new"); setDraft(emptyShippingDraft()); }}>Add rule</button>}
    </div>
     <p className="toonies-panel-note">Temporary manual rules are matched by destination and contiguous weight bands. Adjacent bands are allowed; overlapping active bands are rejected. No supplier rates are fabricated here.</p>
    {error && <p className="catalog-resolution-warning" role="alert">{error}</p>}
     {!loading && <div className="toonies-shipping-summary" aria-label="Shipping summary">
       <div><strong>{activeRules.length}</strong><span>Active rules</span><small>Available for checkout matching</small></div>
       <div><strong>{destinations.size}</strong><span>Countries / zones</span><small>With an active destination</small></div>
       <div><strong>{maxWeight ? `${maxWeight} kg` : "—"}</strong><span>Weight coverage</span><small>Highest configured band</small></div>
       <div><strong>{deliveryValues.length ? `${Math.min(...deliveryValues)}–${Math.max(...deliveryValues)}` : "—"}</strong><span>Delivery days</span><small>Configured estimates</small></div>
     </div>}
    {editing && canManage && <div className="toonies-shipping-form">
       <label>Destination<select aria-label="Shipping destination type" value={draft.destinationType} onChange={(event) => setDraft({ ...draft, destinationType: event.target.value as "country" | "zone" })}><option value="country">Country</option><option value="zone">Shipping zone</option></select></label>
       {draft.destinationType === "country" ? <label>Country<select aria-label="Shipping country code" value={draft.countryCode} onChange={(event) => setDraft({ ...draft, countryCode: event.target.value })}><option value="">Select country</option>{EUROPEAN_COUNTRIES.map((country) => <option key={country.code} value={country.code}>{country.name} ({country.code})</option>)}</select></label> : <label>Shipping zone<select aria-label="Shipping zone" value={draft.destinationZoneId} onChange={(event) => setDraft({ ...draft, destinationZoneId: event.target.value })}><option value="">Select active zone</option>{zones.map((zone) => <option key={zone.id} value={zone.id}>{zone.name}</option>)}</select></label>}
      <label>Minimum kg<input type="number" min="0" step="0.001" value={draft.minWeightKg} onChange={(event) => setDraft({ ...draft, minWeightKg: event.target.value })} /></label>
      <label>Maximum kg <span className="field-optional">(optional)</span><input type="number" min="0" step="0.001" value={draft.maxWeightKg} onChange={(event) => setDraft({ ...draft, maxWeightKg: event.target.value })} /></label>
      <label>Amount EUR<input type="number" min="0" step="0.01" value={draft.amountEur} onChange={(event) => setDraft({ ...draft, amountEur: event.target.value })} /></label>
      <label>Minimum days <span className="field-optional">(optional)</span><input type="number" min="0" step="1" value={draft.minDeliveryDays} onChange={(event) => setDraft({ ...draft, minDeliveryDays: event.target.value })} /></label>
      <label>Maximum days <span className="field-optional">(optional)</span><input type="number" min="0" step="1" value={draft.maxDeliveryDays} onChange={(event) => setDraft({ ...draft, maxDeliveryDays: event.target.value })} /></label>
      <label className="check-line"><input type="checkbox" checked={draft.active} onChange={(event) => setDraft({ ...draft, active: event.target.checked })} /> Active</label>
      <div className="toonies-shipping-form__actions"><button className="button button--small button--dark" onClick={() => void save()}>{editing === "new" ? "Save rule" : "Save changes"}</button><button className="button button--small button--quiet" onClick={cancel}>Cancel</button></div>
    </div>}
     {loading ? <div className="toonies-panel-note">Loading shipping rules…</div> : rules.length ? <div className="toonies-shipping-table-wrap"><table className="admin-table toonies-shipping-table"><thead><tr><th>Destination</th><th>Weight band</th><th>Amount</th><th>Delivery</th><th>Status</th><th /></tr></thead><tbody>{rules.map((rule) => <tr key={rule.id}><td><strong>{rule.countryCode ? EUROPEAN_COUNTRIES.find((country) => country.code === rule.countryCode)?.name ?? rule.countryCode : zones.find((zone) => zone.id === rule.destinationZoneId)?.name || "Zone"}</strong></td><td>{rule.minWeightKg ?? 0}–{rule.maxWeightKg ?? "∞"} kg</td><td>{money(rule.amountEur)}</td><td>{rule.minDeliveryDays ?? "—"}–{rule.maxDeliveryDays ?? "—"} days</td><td><StatusBadge status={rule.active ? "Active" : "Inactive"} tone={rule.active ? "positive" : "neutral"} /></td><td>{canManage && <button className="button button--small button--quiet" onClick={() => edit(rule)}>Edit</button>}</td></tr>)}</tbody></table><div className="toonies-shipping-cards">{rules.map((rule) => <article key={rule.id}><div><strong>{rule.countryCode ? EUROPEAN_COUNTRIES.find((country) => country.code === rule.countryCode)?.name ?? rule.countryCode : zones.find((zone) => zone.id === rule.destinationZoneId)?.name || "Zone"}</strong><StatusBadge status={rule.active ? "Active" : "Inactive"} tone={rule.active ? "positive" : "neutral"} /></div><span>{rule.minWeightKg ?? 0}–{rule.maxWeightKg ?? "∞"} kg · {money(rule.amountEur)}</span><small>{rule.minDeliveryDays ?? "—"}–{rule.maxDeliveryDays ?? "—"} delivery days</small>{canManage && <button className="button button--small button--quiet" onClick={() => edit(rule)}>Edit shipping rule</button>}</article>)}</div></div> : <EmptyState icon="truck" title="No shipping rules" description="No default prices or rules exist. Add a controlled temporary rule when a supplier rate is approved." />}
  </section>;
}