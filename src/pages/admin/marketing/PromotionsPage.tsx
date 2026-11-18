import { useCallback, useEffect, useState } from "react";
import { apiRequest } from "../../../auth/api";
import { useAuth } from "../../../auth/AuthContext";
import { AdminPageHeader, EmptyState, ErrorState, LoadingState, StatusBadge } from "../../../components/admin/AdminPrimitives";

type Lookup = { id: string; name: string };
type Promotion = {
  id: string; name: string; description?: string | null; promotionType: "product" | "category" | "brand" | "order";
  discountType: "percentage" | "fixed" | null; discountValue: number | null; minimumOrderValue: number | null;
  freeShipping: boolean; automatic: boolean; couponCode: string | null; usageLimit: number | null;
  usageLimitPerCustomer: number | null; allowStacking: boolean; priority: number; startAt: string; endAt: string | null;
  active: boolean; status: string; usageCount: number; productIds: string[]; categoryIds: string[]; brandIds: string[];
};
type Form = Omit<Promotion, "id" | "status" | "usageCount">;

const localDate = (value?: string | null) => value ? new Date(value).toISOString().slice(0, 16) : "";
const blank = (): Form => ({
  name: "", description: "", promotionType: "order", discountType: "percentage", discountValue: 10,
  minimumOrderValue: null, freeShipping: false, automatic: true, couponCode: null, usageLimit: null,
  usageLimitPerCustomer: null, allowStacking: false, priority: 0, startAt: localDate(new Date().toISOString()),
  endAt: null, active: false, productIds: [], categoryIds: [], brandIds: [],
});

export function PromotionsPage({ couponsOnly = false }: { couponsOnly?: boolean }) {
  const { permissions } = useAuth();
  const [items, setItems] = useState<Promotion[] | null>(null);
  const [lookups, setLookups] = useState<{ products: Lookup[]; categories: Lookup[]; brands: Lookup[] }>({ products: [], categories: [], brands: [] });
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<Form>(blank());
  const [error, setError] = useState("");
  const canCreate = permissions.includes("promotions.create");
  const canEdit = permissions.includes("promotions.edit");
  const canArchive = permissions.includes("promotions.archive");
  const load = useCallback(async () => {
    try {
      const [promotions, refs] = await Promise.all([
        apiRequest<{ data: Promotion[] }>("/admin/promotions"),
        apiRequest<{ data: typeof lookups }>("/admin/promotions/lookups"),
      ]);
      setItems(promotions.data); setLookups(refs.data); setError("");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Promotions could not be loaded."); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const visible = (items ?? []).filter((item) => couponsOnly ? Boolean(item.couponCode) : true);
  function edit(item: Promotion) {
    setEditingId(item.id);
    setForm({ ...item, startAt: localDate(item.startAt), endAt: localDate(item.endAt) || null });
  }
  async function save() {
    const payload = { ...form, couponCode: form.automatic ? null : form.couponCode, startAt: new Date(form.startAt).toISOString(), endAt: form.endAt ? new Date(form.endAt).toISOString() : null };
    try {
      await apiRequest(editingId ? `/admin/promotions/${editingId}` : "/admin/promotions", { method: editingId ? "PUT" : "POST", body: JSON.stringify(payload) });
      setEditingId(null); setForm(blank()); await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Promotion could not be saved."); }
  }
  async function archive(id: string) {
    if (!confirm("Archive this promotion? It will stop applying immediately.")) return;
    try { await apiRequest(`/admin/promotions/${id}/archive`, { method: "POST" }); await load(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Promotion could not be archived."); }
  }
  const targetOptions = form.promotionType === "product" ? lookups.products : form.promotionType === "category" ? lookups.categories : form.promotionType === "brand" ? lookups.brands : [];
  const targetKey = form.promotionType === "product" ? "productIds" : form.promotionType === "category" ? "categoryIds" : "brandIds";
  return <div className="admin-page">
    <AdminPageHeader eyebrow="Marketing" title={couponsOnly ? "Coupons" : "Promotions"} description="Create real, scheduled offers that apply after authoritative wholesale quantity pricing." actions={(canCreate || canEdit) && <button className="button button--dark button--small" onClick={() => { setEditingId(null); setForm({ ...blank(), automatic: couponsOnly ? false : true }); }}>{couponsOnly ? "New coupon" : "New promotion"}</button>} />
    {error && <ErrorState title="Promotion action failed" description={error} onRetry={() => void load()} />}
    {(canCreate || (editingId && canEdit)) && <section className="pricing-editor promotion-editor">
      <div className="pricing-editor__heading"><div><span className="eyebrow">{editingId ? "Edit offer" : "New offer"}</span><h2>{form.name || "Promotion details"}</h2></div></div>
      <div className="commerce-fields commerce-fields--two">
        <label className="commerce-field">Name<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
        <label className="commerce-field">Scope<select value={form.promotionType} onChange={(e) => setForm({ ...form, promotionType: e.target.value as Form["promotionType"], productIds: [], categoryIds: [], brandIds: [] })}><option value="order">Whole order</option><option value="product">Products</option><option value="category">Categories</option><option value="brand">Brands</option></select></label>
        <label className="commerce-field">Discount<select value={form.freeShipping ? "shipping" : form.discountType ?? "percentage"} onChange={(e) => setForm({ ...form, freeShipping: e.target.value === "shipping", discountType: e.target.value === "shipping" ? null : e.target.value as Form["discountType"] })}><option value="percentage">Percentage</option><option value="fixed">Fixed amount</option><option value="shipping">Free shipping</option></select></label>
        {!form.freeShipping && <label className="commerce-field">Value<input type="number" min="0" step="0.01" value={form.discountValue ?? ""} onChange={(e) => setForm({ ...form, discountValue: Number(e.target.value) })} /></label>}
        <label className="commerce-field">Minimum order value<input type="number" min="0" step="0.01" value={form.minimumOrderValue ?? ""} onChange={(e) => setForm({ ...form, minimumOrderValue: e.target.value ? Number(e.target.value) : null })} /></label>
        <label className="commerce-field">Priority<input type="number" value={form.priority} onChange={(e) => setForm({ ...form, priority: Number(e.target.value) })} /></label>
        <label className="commerce-field">Starts<input type="datetime-local" value={form.startAt} onChange={(e) => setForm({ ...form, startAt: e.target.value })} /></label>
        <label className="commerce-field">Ends<input type="datetime-local" value={form.endAt ?? ""} onChange={(e) => setForm({ ...form, endAt: e.target.value || null })} /></label>
        <label className="commerce-field">Global usage limit<input type="number" min="1" value={form.usageLimit ?? ""} onChange={(e) => setForm({ ...form, usageLimit: e.target.value ? Number(e.target.value) : null })} /></label>
        <label className="commerce-field">Per-customer limit<input type="number" min="1" value={form.usageLimitPerCustomer ?? ""} onChange={(e) => setForm({ ...form, usageLimitPerCustomer: e.target.value ? Number(e.target.value) : null })} /></label>
      </div>
      {form.promotionType !== "order" && <label className="commerce-field">Eligible {form.promotionType}s<select multiple value={form[targetKey]} onChange={(e) => setForm({ ...form, [targetKey]: Array.from(e.target.selectedOptions).map((option) => option.value) })}>{targetOptions.map((option) => <option value={option.id} key={option.id}>{option.name}</option>)}</select></label>}
      <div className="catalog-inline-actions"><label className="check-line"><input type="checkbox" checked={form.automatic} onChange={(e) => setForm({ ...form, automatic: e.target.checked })} /> Apply automatically</label>{!form.automatic && <label className="commerce-field">Coupon code<input value={form.couponCode ?? ""} onChange={(e) => setForm({ ...form, couponCode: e.target.value.toUpperCase() })} /></label>}<label className="check-line"><input type="checkbox" checked={form.allowStacking} onChange={(e) => setForm({ ...form, allowStacking: e.target.checked })} /> Allow stacking</label><label className="check-line"><input type="checkbox" checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} /> Enabled</label></div>
      <div className="catalog-inline-actions"><button className="button button--dark" onClick={() => void save()}>Save offer</button><button className="button button--quiet" onClick={() => { setEditingId(null); setForm(blank()); }}>Cancel</button></div>
    </section>}
    {!items ? <LoadingState label="Loading promotions…" /> : visible.length ? <div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>Name</th><th>Type</th><th>Value</th><th>Schedule</th><th>Usage</th><th>Status</th><th /></tr></thead><tbody>{visible.map((item) => <tr key={item.id}><td><strong>{item.name}</strong>{item.couponCode && <small className="table-subline"><code>{item.couponCode}</code></small>}</td><td>{item.promotionType}</td><td>{item.freeShipping ? "Free shipping" : item.discountType === "percentage" ? `${item.discountValue}%` : `€${item.discountValue}`}</td><td>{new Date(item.startAt).toLocaleString()}<small className="table-subline">{item.endAt ? `to ${new Date(item.endAt).toLocaleString()}` : "No end date"}</small></td><td>{item.usageCount}{item.usageLimit ? ` / ${item.usageLimit}` : ""}</td><td><StatusBadge status={item.status} tone={item.status === "active" ? "positive" : item.status === "expired" ? "negative" : "neutral"} /></td><td><button className="button button--quiet button--small" disabled={!canEdit} onClick={() => edit(item)}>Edit</button>{canArchive && item.status !== "disabled" && <button className="remove-link" onClick={() => void archive(item.id)}>Archive</button>}</td></tr>)}</tbody></table></div> : <EmptyState title="No offers yet" description="Create a promotion or coupon when a real campaign is ready." icon="receipt-text" />}
  </div>;
}