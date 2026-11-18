import { useCallback, useEffect, useMemo, useState } from "react";
import { apiRequest } from "../../../auth/api";
import { useAuth } from "../../../auth/AuthContext";
import { AdminPageHeader, EmptyState, ErrorState, LoadingState, SearchInput, StatusBadge } from "../../../components/admin/AdminPrimitives";
import { Icon } from "../../../components/ui/Icon";
import type { Category } from "./types";
import { slugify } from "./types";

interface CategoryForm {
  name: string;
  slug: string;
  canonicalKey: string;
  parentId: string;
  description: string;
  seoTitle: string;
  seoDescription: string;
  imageUrl: string;
  sortOrder: number;
  active: boolean;
}

const emptyForm: CategoryForm = { name: "", slug: "", canonicalKey: "", parentId: "", description: "", seoTitle: "", seoDescription: "", imageUrl: "", sortOrder: 0, active: true };

function flattenTree(categories: Category[]): Array<Category & { depth: number }> {
  const children = new Map<string | null, Category[]>();
  for (const category of categories) {
    const list = children.get(category.parentId) ?? [];
    list.push(category);
    children.set(category.parentId, list);
  }
  for (const list of children.values()) list.sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
  const output: Array<Category & { depth: number }> = [];
  const visited = new Set<string>();
  const walk = (parentId: string | null, depth: number) => {
    for (const category of children.get(parentId) ?? []) {
      if (visited.has(category.id)) continue;
      visited.add(category.id);
      output.push({ ...category, depth });
      walk(category.id, depth + 1);
    }
  };
  walk(null, 0);
  for (const category of categories) if (!visited.has(category.id)) output.push({ ...category, depth: 0 });
  return output;
}

function descendantIds(categories: Category[], categoryId: string): Set<string> {
  const ids = new Set<string>();
  const visit = (parentId: string) => {
    for (const child of categories.filter((category) => category.parentId === parentId)) {
      if (ids.has(child.id)) continue;
      ids.add(child.id);
      visit(child.id);
    }
  };
  visit(categoryId);
  return ids;
}

function directCount(category: Category): number {
  return category.directProductCount ?? category.productCount ?? 0;
}

function descendantCount(category: Category, categories?: Category[]): number {
  if (category.descendantProductCount !== undefined) return category.descendantProductCount;
  if (!categories) return category.productCount ?? directCount(category);
  return directCount(category) + categories
    .filter((child) => child.parentId === category.id)
    .reduce((sum, child) => sum + descendantCount(child, categories), 0);
}

export function CategoriesPage() {
  const { permissions } = useAuth();
  const [categories, setCategories] = useState<Category[]>([]);
  const [form, setForm] = useState<CategoryForm>(emptyForm);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [removalTarget, setRemovalTarget] = useState<Category | null>(null);
  const [destinationId, setDestinationId] = useState("");
  const [removalBusy, setRemovalBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "active" | "inactive">("all");
  const [order, setOrder] = useState<"tree" | "name" | "order">("tree");
  const canCreate = permissions.includes("categories.create");
  const canEdit = permissions.includes("categories.edit");
  const flattened = useMemo(() => flattenTree(categories), [categories]);
  const visibleCategories = useMemo(() => {
    const query = search.trim().toLowerCase();
    const matching = categories.filter((category) => {
      const matchesStatus = statusFilter === "all" || (statusFilter === "active" ? category.active : !category.active);
      return matchesStatus && (!query || `${category.name} ${category.slug}`.toLowerCase().includes(query));
    });
    if (!query && statusFilter === "all") {
      if (order === "tree") return flattened;
      return [...flattened].sort((a, b) => order === "name"
        ? a.name.localeCompare(b.name)
        : a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
    }
    // Keep matching ancestors visible so filtered results still communicate hierarchy.
    const keep = new Set(matching.map((category) => category.id));
    for (const category of matching) {
      let parentId = category.parentId;
      while (parentId) {
        keep.add(parentId);
        parentId = categories.find((item) => item.id === parentId)?.parentId ?? null;
      }
    }
    const filtered = flattened.filter((category) => keep.has(category.id));
    return order === "tree" ? filtered : [...filtered].sort((a, b) => order === "name"
      ? a.name.localeCompare(b.name)
      : a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
  }, [categories, flattened, order, search, statusFilter]);
  useEffect(() => {
    if (!removalTarget) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !removalBusy) {
        setRemovalTarget(null);
        setDestinationId("");
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [removalBusy, removalTarget]);

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const response = await apiRequest<{ data: Category[] }>("/admin/categories");
      setCategories(response.data);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Categories could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  function edit(category: Category) {
    setEditingId(category.id);
    setForm({
      name: category.name, slug: category.slug, canonicalKey: category.canonicalKey ?? "", parentId: category.parentId ?? "",
      description: category.description ?? "", imageUrl: category.imageUrl ?? "",
      seoTitle: category.seoTitle ?? "", seoDescription: category.seoDescription ?? "",
      sortOrder: category.sortOrder, active: category.active,
    });
  }

  async function save() {
    if (form.parentId && editingId && descendantIds(categories, editingId).has(form.parentId)) {
      setError("A category cannot be moved inside one of its own descendants.");
      return;
    }
    const payload = { ...form, canonicalKey: form.canonicalKey || null, parentId: form.parentId || null, description: form.description || null, seoTitle: form.seoTitle || null, seoDescription: form.seoDescription || null, imageUrl: form.imageUrl || null };
    try {
      await apiRequest(editingId ? `/admin/categories/${editingId}` : "/admin/categories", {
        method: editingId ? "PATCH" : "POST",
        body: JSON.stringify(payload),
      });
      setEditingId(null); setForm(emptyForm); await load();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "The category could not be saved.");
    }
  }

  async function toggle(category: Category) {
    try {
      await apiRequest(`/admin/categories/${category.id}/archive`, { method: "POST", body: JSON.stringify({ active: !category.active }) });
      await load();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "The category status could not be changed.");
    }
  }

  async function archiveFromDialog() {
    if (!removalTarget) return;
    setRemovalBusy(true);
    setError("");
    try {
      await apiRequest(`/admin/categories/${removalTarget.id}/archive`, { method: "POST", body: JSON.stringify({ active: false }) });
      setNotice(`${removalTarget.name} archived. Products and historical records remain unchanged.`);
      setRemovalTarget(null);
      setDestinationId("");
      if (editingId === removalTarget.id) { setEditingId(null); setForm(emptyForm); }
      await load();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "The category could not be archived.");
    } finally {
      setRemovalBusy(false);
    }
  }

  async function deleteSelectedCategory() {
    if (!removalTarget) return;
    if (descendantCount(removalTarget, categories) > 0 && !destinationId) {
      setError("Choose a destination category before deleting this populated category.");
      return;
    }
    setRemovalBusy(true);
    setError("");
    try {
      await apiRequest(`/admin/categories/${removalTarget.id}`, {
        method: "DELETE",
        body: JSON.stringify(destinationId ? { reassignToCategoryId: destinationId } : {}),
      });
      setNotice(destinationId
        ? `${descendantCount(removalTarget, categories)} product${descendantCount(removalTarget, categories) === 1 ? "" : "s"} reassigned and ${removalTarget.name} deleted.`
        : `${removalTarget.name} deleted.`);
      if (editingId === removalTarget.id) { setEditingId(null); setForm(emptyForm); }
      setRemovalTarget(null);
      setDestinationId("");
      await load();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "The category could not be deleted.");
    } finally {
      setRemovalBusy(false);
    }
  }

  return <div className="admin-page catalog-page">
    <AdminPageHeader eyebrow="Catalog organization" title="Categories" description="Manage an unlimited nested hierarchy with explicit ordering and cycle-safe parent assignment." actions={<span className="foundation-chip"><span className="status-dot" /> Live category tree</span>} />
    {error && <ErrorState title="Category action failed" description={error} onRetry={() => void load()} />}
    {notice && <p className="catalog-notice" role="status">{notice}</p>}
    <div className="catalog-split">
      <section className="admin-panel">
        <div className="admin-panel__heading"><div><span className="eyebrow">Hierarchy</span><h2>Category tree</h2></div><span className="section-note">{categories.length} categories</span></div>
        {!loading && <div className="catalog-toolbar catalog-category-toolbar">
          <SearchInput value={search} onChange={setSearch} placeholder="Search categories or slugs" />
          <div className="catalog-category-toolbar__filters">
            <label>Status<select aria-label="Filter category status" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as typeof statusFilter)}><option value="all">All statuses</option><option value="active">Active only</option><option value="inactive">Inactive only</option></select></label>
            <label>Order<select aria-label="Order categories" value={order} onChange={(event) => setOrder(event.target.value as typeof order)}><option value="tree">Hierarchy</option><option value="order">Sort order</option><option value="name">Name</option></select></label>
          </div>
        </div>}
        {loading ? <LoadingState label="Loading categories…" /> : visibleCategories.length ? <div className="catalog-tree" aria-label="Category hierarchy">{visibleCategories.map((category) => <div className={`catalog-tree__row catalog-tree__row--depth-${Math.min(category.depth, 3)}${category.depth === 0 ? " catalog-tree__row--root" : ""}`} key={category.id}>
          <button type="button" className={`catalog-tree__main ${editingId === category.id ? "is-active" : ""}`} style={{ paddingLeft: `${14 + category.depth * 24}px` }} onClick={() => edit(category)}>
            <span className="catalog-tree__guide" aria-hidden="true" /><Icon name="layers-3" size={15} /><span><strong>{category.name}</strong><small>/{category.slug} · {directCount(category)} direct · {descendantCount(category, categories)} in branch · order {category.sortOrder}</small></span><StatusBadge status={category.active ? "Active" : "Inactive"} tone={category.active ? "positive" : "neutral"} />
          </button>
          {canEdit && <button className="icon-button catalog-delete-action" type="button" onClick={() => { setRemovalTarget(category); setDestinationId(""); }} aria-label={`Delete or archive ${category.name}`} title="Delete or archive category"><Icon name="trash-2" size={16} /></button>}
        </div>)}</div> : <EmptyState title={categories.length ? "No categories match" : "No categories yet"} description={categories.length ? "Try another search or status filter." : "Create the first category before adding products. No categories are hard-coded."} />}
      </section>
      {(canCreate || (Boolean(editingId) && canEdit)) && <section className="admin-panel catalog-side-form">
        <div className="admin-panel__heading"><div><span className="eyebrow">{editingId ? "Edit" : "Create"}</span><h2>{editingId ? "Category details" : "New category"}</h2></div></div>
        <form onSubmit={(event) => { event.preventDefault(); void save(); }} className="catalog-stack">
          <label className="catalog-field">Name<input required value={form.name} onChange={(event) => setForm((current) => ({ ...current, name: event.target.value, slug: editingId ? current.slug : slugify(event.target.value) }))} /></label>
          <label className="catalog-field">Slug<input required pattern="[a-z0-9]+(?:-[a-z0-9]+)*" value={form.slug} onChange={(event) => setForm((current) => ({ ...current, slug: slugify(event.target.value) }))} /></label>
          <label className="catalog-field" htmlFor="category-parent-id">Parent category<select id="category-parent-id" aria-label="Parent category" value={form.parentId} onChange={(event) => setForm((current) => ({ ...current, parentId: event.target.value }))}><option value="">Top level</option>{flattened.filter((category) => category.id !== editingId && !(editingId && descendantIds(categories, editingId).has(category.id))).map((category) => <option key={category.id} value={category.id}>{"— ".repeat(category.depth)}{category.name}</option>)}</select><span>Descendants are excluded to prevent hierarchy cycles.</span></label>
          <label className="catalog-field">Sort order<input type="number" min="0" value={form.sortOrder} onChange={(event) => setForm((current) => ({ ...current, sortOrder: Number(event.target.value) }))} /></label>
          <label className="catalog-field">Image URL<input type="url" value={form.imageUrl} onChange={(event) => setForm((current) => ({ ...current, imageUrl: event.target.value }))} /></label>
          <label className="catalog-field">Description<textarea rows={4} value={form.description} onChange={(event) => setForm((current) => ({ ...current, description: event.target.value }))} /></label>
           <label className="catalog-field">SEO title <span>{form.seoTitle.length}/70 · falls back to name</span><input maxLength={70} value={form.seoTitle} onChange={(event) => setForm((current) => ({ ...current, seoTitle: event.target.value }))} /></label>
           <label className="catalog-field">SEO description <span>{form.seoDescription.length}/170 · falls back to description</span><textarea rows={3} maxLength={170} value={form.seoDescription} onChange={(event) => setForm((current) => ({ ...current, seoDescription: event.target.value }))} /></label>
           <p className="catalog-help">Preview: <strong>{form.seoTitle || form.name || "Category name"}</strong> — {form.seoDescription || form.description || "Category description"}</p>
          <label className="catalog-check"><input type="checkbox" checked={form.active} onChange={(event) => setForm((current) => ({ ...current, active: event.target.checked }))} /><span><strong>Active</strong><small>Available for product assignment</small></span></label>
          <div className="catalog-inline-actions"><button className="button button--dark button--small" type="submit">{editingId ? "Save category" : "Create category"}</button>{editingId && <><button type="button" className="button button--quiet button--small" onClick={() => { setEditingId(null); setForm(emptyForm); }}>Cancel</button><button type="button" className="button button--quiet button--small catalog-danger" onClick={() => void toggle(categories.find((item) => item.id === editingId)!)}>{form.active ? "Deactivate" : "Restore"}</button></>}</div>
        </form>
      </section>}
    </div>
    {removalTarget && <div className="admin-dialog-backdrop" role="presentation" onMouseDown={() => { if (!removalBusy) setRemovalTarget(null); }}>
      <div className="admin-dialog" role="dialog" aria-modal="true" aria-labelledby="category-removal-title" onMouseDown={(event) => event.stopPropagation()}>
        <span className="eyebrow">Catalog safety</span>
         <h2 id="category-removal-title">{descendantCount(removalTarget, categories) > 0 ? "Remove populated category?" : "Delete category?"}</h2>
        <p><strong>{removalTarget.name}</strong></p>
        {removalTarget.childCount > 0 ? <p>This category contains {removalTarget.childCount} child categor{removalTarget.childCount === 1 ? "y" : "ies"}. Move those children first, or archive this category.</p>
          : removalTarget.protectedDependencyCount > 0 ? <p>This category has promotion or SEO history and cannot be hard-deleted. Archive it to remove it from active catalog use.</p>
           : descendantCount(removalTarget, categories) > 0 ? <>
             <p>This category contains {descendantCount(removalTarget, categories)} product{descendantCount(removalTarget, categories) === 1 ? "" : "s"} across its branch. Reassign them to another active category before deletion, or archive this category.</p>
            <label className="catalog-field">Destination category<select value={destinationId} onChange={(event) => setDestinationId(event.target.value)}>
              <option value="">Choose category</option>
              {flattened.filter((category) => category.id !== removalTarget.id && category.active).map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}
            </select></label>
          </> : <p>This empty category will be permanently deleted. This action cannot be undone.</p>}
        <div className="admin-dialog__actions admin-dialog__actions--split">
           <button className="button button--quiet" disabled={removalBusy} onClick={() => { setRemovalTarget(null); setDestinationId(""); }}>Cancel</button>
          <div className="catalog-inline-actions">
            {removalTarget.active && <button className="button button--quiet catalog-danger" disabled={removalBusy} onClick={() => void archiveFromDialog()}>{removalBusy ? "Working…" : "Archive category"}</button>}
             {removalTarget.childCount === 0 && removalTarget.protectedDependencyCount === 0 && <button className="button button--dark" disabled={removalBusy || (descendantCount(removalTarget, categories) > 0 && !destinationId)} onClick={() => void deleteSelectedCategory()}>{removalBusy ? "Working…" : descendantCount(removalTarget, categories) > 0 ? "Reassign and delete" : "Delete category"}</button>}
          </div>
        </div>
      </div>
    </div>}
  </div>;
}