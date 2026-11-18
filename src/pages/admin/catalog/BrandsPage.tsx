import { useCallback, useEffect, useState } from "react";
import { apiRequest } from "../../../auth/api";
import { useAuth } from "../../../auth/AuthContext";
import { AdminPageHeader, EmptyState, ErrorState, LoadingState, Pagination, SearchInput, StatusBadge } from "../../../components/admin/AdminPrimitives";
import type { Brand } from "./types";
import { slugify } from "./types";

interface BrandForm { name: string; slug: string; logoUrl: string; description: string; seoTitle: string; seoDescription: string; active: boolean }
const emptyForm: BrandForm = { name: "", slug: "", logoUrl: "", description: "", seoTitle: "", seoDescription: "", active: true };

export function BrandsPage() {
  const { permissions } = useAuth();
  const [items, setItems] = useState<Brand[]>([]);
  const [meta, setMeta] = useState({ page: 1, pageSize: 25, total: 0, hasNext: false });
  const [page, setPage] = useState(1);
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [form, setForm] = useState<BrandForm>(emptyForm);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const canCreate = permissions.includes("brands.create");
  const canEdit = permissions.includes("brands.edit");

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const response = await apiRequest<{ data: { items: Brand[]; meta: typeof meta } }>(`/admin/brands?page=${page}&pageSize=25&search=${encodeURIComponent(search)}`);
      setItems(response.data.items); setMeta(response.data.meta);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Brands could not be loaded.");
    } finally { setLoading(false); }
  }, [page, search]);
  useEffect(() => { void load(); }, [load]);

  function edit(brand: Brand) {
    setEditingId(brand.id);
    setForm({ name: brand.name, slug: brand.slug, logoUrl: brand.logoUrl ?? "", description: brand.description ?? "", seoTitle: brand.seoTitle ?? "", seoDescription: brand.seoDescription ?? "", active: brand.active });
  }
  async function save() {
    try {
      await apiRequest(editingId ? `/admin/brands/${editingId}` : "/admin/brands", {
        method: editingId ? "PATCH" : "POST",
        body: JSON.stringify({ ...form, logoUrl: form.logoUrl || null, description: form.description || null, seoTitle: form.seoTitle || null, seoDescription: form.seoDescription || null }),
      });
      setEditingId(null); setForm(emptyForm); await load();
    } catch (requestError) { setError(requestError instanceof Error ? requestError.message : "The brand could not be saved."); }
  }
  async function toggle(brand: Brand) {
    try {
      await apiRequest(`/admin/brands/${brand.id}/archive`, { method: "POST", body: JSON.stringify({ active: !brand.active }) });
      await load();
    } catch (requestError) { setError(requestError instanceof Error ? requestError.message : "The brand status could not be changed."); }
  }

  return <div className="admin-page catalog-page">
    <AdminPageHeader eyebrow="Catalog organization" title="Brands" description="Maintain unique brand identities, logos, descriptions, and active status." actions={<span className="foundation-chip"><span className="status-dot" /> Live brand directory</span>} />
    {error && <ErrorState title="Brand action failed" description={error} onRetry={() => void load()} />}
    <div className="catalog-split">
      <section className="admin-panel">
        <div className="admin-panel__heading"><div><span className="eyebrow">Directory</span><h2>Brands</h2></div><span className="section-note">{meta.total} total</span></div>
        <SearchInput value={searchInput} onChange={setSearchInput} onSubmit={() => { setSearch(searchInput.trim()); setPage(1); }} placeholder="Search brands…" />
        {loading ? <LoadingState label="Loading brands…" /> : items.length ? <div className="catalog-brand-list">{items.map((brand) => <button type="button" key={brand.id} className={editingId === brand.id ? "is-active" : ""} onClick={() => edit(brand)}>
          <span className="catalog-brand-logo">{brand.logoUrl ? <img src={brand.logoUrl} alt="" /> : brand.name.slice(0, 1).toUpperCase()}</span>
          <span><strong>{brand.name}</strong><small>/{brand.slug}</small></span><StatusBadge status={brand.active ? "Active" : "Inactive"} tone={brand.active ? "positive" : "neutral"} />
        </button>)}</div> : <EmptyState title="No brands yet" description="Create a brand or leave products unbranded. No sample brands have been added." />}
        <Pagination page={meta.page} hasNext={meta.hasNext} onChange={setPage} />
      </section>
      {(canCreate || (editingId && canEdit)) && <section className="admin-panel catalog-side-form">
        <div className="admin-panel__heading"><div><span className="eyebrow">{editingId ? "Edit" : "Create"}</span><h2>{editingId ? "Brand details" : "New brand"}</h2></div></div>
        <form className="catalog-stack" onSubmit={(event) => { event.preventDefault(); void save(); }}>
          <label className="catalog-field">Name<input required value={form.name} onChange={(event) => setForm((current) => ({ ...current, name: event.target.value, slug: editingId ? current.slug : slugify(event.target.value) }))} /></label>
          <label className="catalog-field">Slug<input required pattern="[a-z0-9]+(?:-[a-z0-9]+)*" value={form.slug} onChange={(event) => setForm((current) => ({ ...current, slug: slugify(event.target.value) }))} /></label>
          <label className="catalog-field">Logo URL<input type="url" value={form.logoUrl} onChange={(event) => setForm((current) => ({ ...current, logoUrl: event.target.value }))} /></label>
          <label className="catalog-field">Description<textarea rows={5} value={form.description} onChange={(event) => setForm((current) => ({ ...current, description: event.target.value }))} /></label>
           <label className="catalog-field">SEO title <span>{form.seoTitle.length}/70 · falls back to name</span><input maxLength={70} value={form.seoTitle} onChange={(event) => setForm((current) => ({ ...current, seoTitle: event.target.value }))} /></label>
           <label className="catalog-field">SEO description <span>{form.seoDescription.length}/170 · falls back to description</span><textarea rows={3} maxLength={170} value={form.seoDescription} onChange={(event) => setForm((current) => ({ ...current, seoDescription: event.target.value }))} /></label>
           <p className="catalog-help">Preview: <strong>{form.seoTitle || form.name || "Brand name"}</strong> — {form.seoDescription || form.description || "Brand description"}</p>
          <label className="catalog-check"><input type="checkbox" checked={form.active} onChange={(event) => setForm((current) => ({ ...current, active: event.target.checked }))} /><span><strong>Active</strong><small>Available for product assignment</small></span></label>
          <div className="catalog-inline-actions"><button className="button button--dark button--small" type="submit">{editingId ? "Save brand" : "Create brand"}</button>{editingId && <><button className="button button--quiet button--small" type="button" onClick={() => { setEditingId(null); setForm(emptyForm); }}>Cancel</button><button className="button button--quiet button--small catalog-danger" type="button" onClick={() => void toggle(items.find((item) => item.id === editingId)!)}>{form.active ? "Deactivate" : "Restore"}</button></>}</div>
        </form>
      </section>}
    </div>
  </div>;
}