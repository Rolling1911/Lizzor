import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { apiRequest } from "../../../auth/api";
import { useAuth } from "../../../auth/AuthContext";
import {
  AdminPageHeader,
  ConfirmationDialog,
  ErrorState,
  FormActions,
  FormSection,
  LoadingState,
  StatusBadge,
} from "../../../components/admin/AdminPrimitives";
import { Icon } from "../../../components/ui/Icon";
import type { CatalogLookups, ProductDetail, ProductMedia, ProductVariant } from "./types";
import { slugify } from "./types";
import { inventoryPresentation } from "./inventoryPresentation";

interface ProductForm {
  name: string;
  slug: string;
  parentSku: string;
  barcode: string;
  brandId: string;
  categoryId: string;
  shortDescription: string;
  description: string;
  seoTitle: string;
  seoDescription: string;
  status: "draft" | "active" | "inactive" | "archived";
  costPrice: string;
  basePrice: string;
  vatRate: string;
  taxMode: "inclusive" | "exclusive";
  weight: string;
  minimumOrderQuantity: string;
  width: string;
  height: string;
  length: string;
  featured: boolean;
  homepageWholesale: boolean;
  newArrival: boolean;
}

interface ProductOption {
  name: string;
  values: string;
}

interface VariantInventory {
  id: string; variantId: string | null; warehouseName: string; warehouseCode: string;
  quantityOnHand: number; quantityReserved: number; available: number; active: boolean; status: "inactive" | "out" | "low" | "in_stock";
}

const emptyForm: ProductForm = {
  name: "", slug: "", parentSku: "", barcode: "", brandId: "", categoryId: "",
  shortDescription: "", description: "", seoTitle: "", seoDescription: "", status: "draft", costPrice: "0", basePrice: "0",
  vatRate: "19", taxMode: "inclusive", weight: "0", minimumOrderQuantity: "1", width: "", height: "", length: "", featured: false, homepageWholesale: false, newArrival: false,
};

function optionalNumber(value: string): number | null {
  return value.trim() ? Number(value) : null;
}

function cartesian(options: Array<{ name: string; values: string[] }>): Array<Array<{ attribute: string; value: string }>> {
  return options.reduce<Array<Array<{ attribute: string; value: string }>>>(
    (sets, option) => sets.flatMap((set) => option.values.map((value) => [...set, { attribute: option.name, value }])),
    [[]],
  );
}

function variantSuffix(values: string[]): string {
  return values.map((value) => value.toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 12)).join("-");
}

export function ProductEditorPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { permissions } = useAuth();
  const isNew = !id;
  const [form, setForm] = useState<ProductForm>(emptyForm);
  const [options, setOptions] = useState<ProductOption[]>([]);
  const [variants, setVariants] = useState<ProductVariant[]>([]);
  const [variantInventory, setVariantInventory] = useState<VariantInventory[]>([]);
  const [media, setMedia] = useState<ProductMedia[]>([]);
  const [lookups, setLookups] = useState<CatalogLookups>({ categories: [], brands: [] });
  const [loading, setLoading] = useState(!isNew);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [mediaFile, setMediaFile] = useState<File | null>(null);
  const [mediaAlt, setMediaAlt] = useState("");
  const [mediaVariantId, setMediaVariantId] = useState("");
  const [mediaPrimary, setMediaPrimary] = useState(false);
  const [hasQualifyingWholesaleTier, setHasQualifyingWholesaleTier] = useState<boolean | null>(null);
  const [tooniesVatClassificationRequired, setTooniesVatClassificationRequired] = useState(false);
  const canCost = permissions.includes("product_cost.view");
  const canSave = permissions.includes(isNew ? "products.create" : "products.edit");
  const canArchive = !isNew && permissions.includes("products.archive");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const lookupResponse = await apiRequest<{ data: CatalogLookups }>("/admin/catalog/lookups");
      setLookups(lookupResponse.data);
      if (id) {
        const response = await apiRequest<{ data: ProductDetail }>(`/admin/products/${id}`);
        const product = response.data;
        setForm({
          name: product.name,
          slug: product.slug,
          parentSku: product.parentSku,
          barcode: product.barcode ?? "",
          brandId: product.brand?.id ?? "",
          categoryId: product.category.id,
          shortDescription: product.shortDescription ?? "",
          description: product.description,
          seoTitle: product.seoTitle ?? "",
          seoDescription: product.seoDescription ?? "",
          status: product.status,
          costPrice: String(product.costPrice ?? 0),
          basePrice: String(product.basePrice),
          vatRate: String(product.vatRate),
          taxMode: product.taxMode ?? "inclusive",
          weight: String(product.weight),
          minimumOrderQuantity: String(product.minimumOrderQuantity),
          width: product.dimensions.width === null ? "" : String(product.dimensions.width),
          height: product.dimensions.height === null ? "" : String(product.dimensions.height),
          length: product.dimensions.length === null ? "" : String(product.dimensions.length),
          featured: product.featured,
          homepageWholesale: product.homepageWholesale,
          newArrival: product.newArrival,
        });
        setVariants(product.variants);
        setHasQualifyingWholesaleTier(product.hasActiveWholesaleTier);
        setTooniesVatClassificationRequired(Boolean(product.isToonies && !product.vatClassifiedAt));
        if (permissions.includes("inventory.view")) {
          const inventoryResponse = await apiRequest<{ data: { items: VariantInventory[] } }>(`/admin/inventory?productId=${id}&lifecycle=all&page=1&pageSize=100`);
          setVariantInventory(inventoryResponse.data.items);
        }
        setMedia(product.media);
        const optionMap = new Map<string, Set<string>>();
        for (const variant of product.variants) for (const pair of variant.optionValues) {
          const values = optionMap.get(pair.attribute) ?? new Set<string>();
          values.add(pair.value);
          optionMap.set(pair.attribute, values);
        }
        setOptions([...optionMap].map(([name, values]) => ({ name, values: [...values].join(", ") })));
      }
      setDirty(false);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "The product editor could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, [id, permissions]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (dirty) { event.preventDefault(); event.returnValue = ""; }
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  function updateForm<K extends keyof ProductForm>(key: K, value: ProductForm[K]) {
    setForm((current) => ({ ...current, [key]: value }));
    setDirty(true);
  }

  const parsedOptions = useMemo(() => options
    .map((option) => ({ name: option.name.trim(), values: [...new Set(option.values.split(",").map((value) => value.trim()).filter(Boolean))] }))
    .filter((option) => option.name && option.values.length), [options]);

  function generateVariants() {
    if (!parsedOptions.length) {
      setError("Add at least one option with comma-separated values before generating variants.");
      return;
    }
    const existingByCombination = new Map(variants.map((variant) => [
      JSON.stringify([...variant.optionValues].sort((a, b) => a.attribute.localeCompare(b.attribute))),
      variant,
    ]));
    const generated = cartesian(parsedOptions).map((optionValues) => {
      const key = JSON.stringify([...optionValues].sort((a, b) => a.attribute.localeCompare(b.attribute)));
      return existingByCombination.get(key) ?? {
        sku: `${form.parentSku || "PRODUCT"}-${variantSuffix(optionValues.map((pair) => pair.value))}`,
        barcode: null,
        title: optionValues.map((pair) => pair.value).join(" / "),
        costPrice: null,
        basePrice: null,
        weight: null,
        minimumOrderQuantity: 1,
        active: true,
        optionValues,
      };
    });
    setVariants(generated);
    setDirty(true);
    setError("");
  }

  function updateVariant(index: number, patch: Partial<ProductVariant>) {
    setVariants((current) => current.map((variant, position) => position === index ? { ...variant, ...patch } : variant));
    setDirty(true);
  }

  function payload() {
    return {
      ...form,
      barcode: form.barcode || null,
      brandId: form.brandId || null,
      shortDescription: form.shortDescription || null,
      seoTitle: form.seoTitle || null,
      seoDescription: form.seoDescription || null,
      costPrice: Number(form.costPrice),
      basePrice: Number(form.basePrice),
      vatRate: Number(form.vatRate),
      weight: Number(form.weight),
      minimumOrderQuantity: Number(form.minimumOrderQuantity),
      width: optionalNumber(form.width),
      height: optionalNumber(form.height),
      length: optionalNumber(form.length),
      options: parsedOptions,
      variants: variants.map((variant) => ({
        ...variant,
        barcode: variant.barcode || null,
        costPrice: variant.costPrice === null ? null : Number(variant.costPrice),
        basePrice: variant.basePrice === null ? null : Number(variant.basePrice),
        weight: variant.weight === null ? null : Number(variant.weight),
        minimumOrderQuantity: Number(variant.minimumOrderQuantity),
      })),
    };
  }

  async function save() {
    if (!canSave) return;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const response = await apiRequest<{ data: ProductDetail }>(isNew ? "/admin/products" : `/admin/products/${id}`, {
        method: isNew ? "POST" : "PATCH",
        body: JSON.stringify(payload()),
      });
      setDirty(false);
      setNotice("Product saved successfully.");
      if (isNew) navigate(`/admin/products/${response.data.id}`, { replace: true });
      else {
        setVariants(response.data.variants);
        setMedia(response.data.media);
        setHasQualifyingWholesaleTier(response.data.hasActiveWholesaleTier);
      }
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "The product could not be saved.");
    } finally {
      setSaving(false);
    }
  }

  async function archive() {
    if (!id) return;
    try {
      const restore = form.status === "archived";
      const response = await apiRequest<{ data: ProductDetail }>(`/admin/products/${id}/archive`, { method: "POST", body: JSON.stringify({ restore }) });
      setForm((current) => ({ ...current, status: response.data.status }));
      setDirty(false);
      setArchiveOpen(false);
      setNotice(restore ? "Product restored." : "Product archived.");
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "The product status could not be changed.");
    }
  }

  async function uploadMedia() {
    if (!id || !mediaFile) return;
    const data = new FormData();
    data.append("file", mediaFile);
    data.append("altText", mediaAlt);
    data.append("variantId", mediaVariantId);
    data.append("isPrimary", String(mediaPrimary));
    data.append("sortOrder", String(media.length));
    try {
      const response = await apiRequest<{ data: ProductMedia }>(`/admin/products/${id}/media`, { method: "POST", body: data });
      setMedia((current) => mediaPrimary ? [...current.map((item) => ({ ...item, isPrimary: false })), response.data] : [...current, response.data]);
      setMediaFile(null); setMediaAlt(""); setMediaVariantId(""); setMediaPrimary(false);
      setNotice("Media uploaded.");
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Media could not be uploaded.");
    }
  }

  async function removeMedia(item: ProductMedia) {
    try {
      await apiRequest(`/admin/media/${item.id}`, { method: "DELETE" });
      setMedia((current) => current.filter((mediaItem) => mediaItem.id !== item.id));
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Media could not be removed.");
    }
  }

  if (loading) return <LoadingState label="Loading product editor…" />;
  return <div className="admin-page catalog-page">
    <AdminPageHeader
      eyebrow="Catalog management"
      title={isNew ? "Add product" : form.name || "Edit product"}
      description="Parent details, dynamic options, variant overrides, media, and publishing are saved transactionally."
      actions={<div className="catalog-header-actions">{id && permissions.includes("inventory.view") && <Link className="button button--quiet button--small" to={`/admin/inventory?productId=${id}`}>Inventory</Link>}{id && permissions.includes("pricing.view") && <Link className="button button--quiet button--small" to={`/admin/pricing?productId=${id}`}>Wholesale pricing</Link>}<Link className="button button--quiet button--small" to="/admin/products">Back to products</Link>{form.status && <StatusBadge status={form.status} tone={form.status === "active" ? "positive" : form.status === "archived" ? "negative" : "warning"} />}</div>}
    />
    {error && <ErrorState title="Product action failed" description={error} />}
    {notice && <p className="catalog-notice" role="status">{notice}</p>}
    <form className="catalog-editor" onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <FormSection title="Basic information" description="Core identity and merchandising copy. Slugs, SKUs, and barcodes are unique.">
        <div className="catalog-form-grid">
          <label className="catalog-field catalog-field--wide">Product name<input required maxLength={250} value={form.name} onChange={(event) => { updateForm("name", event.target.value); if (isNew || !form.slug) updateForm("slug", slugify(event.target.value)); }} /></label>
          <label className="catalog-field">Slug<input required pattern="[a-z0-9]+(?:-[a-z0-9]+)*" value={form.slug} onChange={(event) => updateForm("slug", slugify(event.target.value))} /></label>
          <label className="catalog-field">Parent SKU<input required value={form.parentSku} onChange={(event) => updateForm("parentSku", event.target.value)} /></label>
          <label className="catalog-field">Barcode <span>optional</span><input value={form.barcode} onChange={(event) => updateForm("barcode", event.target.value)} /></label>
          <label className="catalog-field">Brand<select value={form.brandId} onChange={(event) => updateForm("brandId", event.target.value)}><option value="">No brand</option>{lookups.brands.map((brand) => <option key={brand.id} value={brand.id}>{brand.name}{brand.active ? "" : " (inactive)"}</option>)}</select></label>
          <label className="catalog-field">Category<select required value={form.categoryId} onChange={(event) => updateForm("categoryId", event.target.value)}><option value="">Choose category</option>{lookups.categories.map((category) => <option key={category.id} value={category.id}>{category.name}{category.active ? "" : " (inactive)"}</option>)}</select></label>
          <label className="catalog-field catalog-field--wide">Short description<textarea rows={2} value={form.shortDescription} onChange={(event) => updateForm("shortDescription", event.target.value)} /></label>
          <label className="catalog-field catalog-field--wide">Full description<textarea required rows={6} value={form.description} onChange={(event) => updateForm("description", event.target.value)} /></label>
        </div>
      </FormSection>

      <FormSection title="Status" description="Active products are published; draft, inactive, and archived products remain unpublished.">
        <div className="catalog-form-grid">
          <label className="catalog-field">Status<select value={form.status} disabled={form.status === "archived"} onChange={(event) => updateForm("status", event.target.value as ProductForm["status"])}><option value="draft">Draft</option><option value="active">Active</option><option value="inactive">Inactive</option>{form.status === "archived" && <option value="archived">Archived</option>}</select></label>
          <label className="catalog-check"><input type="checkbox" checked={form.newArrival} onChange={(event) => updateForm("newArrival", event.target.checked)} /><span><strong>New arrival</strong><small>Mark as recently introduced</small></span></label>
        </div>
      </FormSection>
      <FormSection title="Homepage merchandising" description="Choose the curated homepage placements for this product.">
        <div className="catalog-form-grid">
          <label className="catalog-check"><input type="checkbox" checked={form.featured} onChange={(event) => updateForm("featured", event.target.checked)} /><span><strong>Show in Best Sellers</strong><small>Places this product in the homepage Best Sellers section.</small></span></label>
          <label className="catalog-check"><input type="checkbox" checked={form.homepageWholesale} onChange={(event) => updateForm("homepageWholesale", event.target.checked)} /><span><strong>Show in Live wholesale pricing</strong><small>Places this product in the homepage Live wholesale pricing section. Quantity and wholesale pricing tiers remain the price source.</small></span></label>
        </div>
        {form.homepageWholesale && (isNew || hasQualifyingWholesaleTier === false) && <div className="catalog-wholesale-warning" role="alert">
          <strong>This product has no active wholesale tiers yet.</strong>
          <span>Add quantity pricing before it can appear in Live wholesale pricing.</span>
          {isNew && <small>Save the product first, then add an active tier with a minimum quantity above 1.</small>}
          {isNew ? null : <Link to={`/admin/pricing?productId=${id}`}>Manage quantity pricing</Link>}
        </div>}
      </FormSection>

      <FormSection title="Search preview" description="Optional plain-text search metadata. Empty fields fall back to the product name and short description.">
        <div className="catalog-form-grid">
          <label className="catalog-field catalog-field--wide">SEO title <span>{form.seoTitle.length}/70</span><input maxLength={70} value={form.seoTitle} onChange={(event) => updateForm("seoTitle", event.target.value)} placeholder={form.name || "Product name"} /></label>
          <label className="catalog-field catalog-field--wide">SEO description <span>{form.seoDescription.length}/170</span><textarea rows={3} maxLength={170} value={form.seoDescription} onChange={(event) => updateForm("seoDescription", event.target.value)} placeholder={form.shortDescription || "A concise product summary"} /></label>
          <p className="catalog-help catalog-field--wide">Preview: <strong>{form.seoTitle || form.name || "Product name"}</strong> — {form.seoDescription || form.shortDescription || "Your product description will be used when no SEO description is provided."}</p>
        </div>
      </FormSection>

      <FormSection title="Pricing foundation" description="Base and internal cost prices. Use the focused wholesale pricing workspace for quantity tiers.">
        <div className="catalog-form-grid">
          {canCost && <label className="catalog-field">Cost price (EUR)<input required type="number" min="0" step="0.01" value={form.costPrice} onChange={(event) => updateForm("costPrice", event.target.value)} /></label>}
          <label className="catalog-field">Base selling price (EUR)<input required type="number" min="0" step="0.01" value={form.basePrice} onChange={(event) => updateForm("basePrice", event.target.value)} /></label>
            <label className="catalog-field">Minimum order quantity<input required type="number" min="1" step="1" value={form.minimumOrderQuantity} onChange={(event) => updateForm("minimumOrderQuantity", event.target.value)} /><small>Authoritative minimum for the parent product.</small></label>
          <label className="catalog-field">VAT rate (%)<input required type="number" min="0" max="100" step="0.01" value={form.vatRate} onChange={(event) => updateForm("vatRate", event.target.value)} />{tooniesVatClassificationRequired && <small className="catalog-resolution-warning">VAT classification required. Saving this product explicitly classifies the selected rate, including intentional 0%.</small>}</label>
          <label className="catalog-field">Selling price VAT basis<select value={form.taxMode} onChange={(event) => updateForm("taxMode", event.target.value as ProductForm["taxMode"])}><option value="inclusive">VAT included in price</option><option value="exclusive">VAT added at checkout</option></select></label>
        </div>
      </FormSection>

      <FormSection title="Shipping data" description="Reference dimensions for future fulfillment. Inventory and warehouse stock are managed in the focused inventory workspace.">
        <div className="catalog-form-grid">
          <label className="catalog-field">Weight<input required type="number" min="0" step="0.001" value={form.weight} onChange={(event) => updateForm("weight", event.target.value)} /></label>
          <label className="catalog-field">Width<input type="number" min="0" step="0.001" value={form.width} onChange={(event) => updateForm("width", event.target.value)} /></label>
          <label className="catalog-field">Height<input type="number" min="0" step="0.001" value={form.height} onChange={(event) => updateForm("height", event.target.value)} /></label>
          <label className="catalog-field">Length<input type="number" min="0" step="0.001" value={form.length} onChange={(event) => updateForm("length", event.target.value)} /></label>
        </div>
      </FormSection>

      <FormSection title="Dynamic options" description="Create any option set, such as Color, Size, Material, Capacity, or Pack Size.">
        <div className="catalog-stack">
          {options.map((option, index) => <div className="catalog-option-row" key={index}>
            <input aria-label={`Option ${index + 1} name`} placeholder="Option name" value={option.name} onChange={(event) => { setOptions((current) => current.map((item, position) => position === index ? { ...item, name: event.target.value } : item)); setDirty(true); }} />
            <input aria-label={`Option ${index + 1} values`} placeholder="Comma-separated values" value={option.values} onChange={(event) => { setOptions((current) => current.map((item, position) => position === index ? { ...item, values: event.target.value } : item)); setDirty(true); }} />
            <button className="icon-button" type="button" onClick={() => { setOptions((current) => current.filter((_, position) => position !== index)); setDirty(true); }} aria-label="Remove option"><Icon name="x" size={16} /></button>
          </div>)}
          <div className="catalog-inline-actions"><button className="button button--quiet button--small" type="button" onClick={() => { setOptions((current) => [...current, { name: "", values: "" }]); setDirty(true); }}><Icon name="plus" size={14} /> Add option</button><button className="button button--dark button--small" type="button" onClick={generateVariants}>Generate combinations</button></div>
        </div>
      </FormSection>

      <FormSection title={`Variants (${variants.length})`} description="Generated variants remain manually editable. Saving never silently deletes omitted variants or pricing relationships.">
        <div className="catalog-stack">
          {variants.length ? <div className="admin-table-wrap"><table className="admin-table catalog-variant-table"><thead><tr><th>Combination</th><th>SKU</th><th>Barcode</th><th>Price override</th><th>Weight override</th>{permissions.includes("inventory.view") && <th>Inventory by warehouse</th>}<th>Active</th></tr></thead><tbody>{variants.map((variant, index) => <tr key={variant.id ?? `${variant.sku}-${index}`}>
            <td><input value={variant.title} onChange={(event) => updateVariant(index, { title: event.target.value })} aria-label="Variant title" /></td>
            <td><input required value={variant.sku} onChange={(event) => updateVariant(index, { sku: event.target.value })} aria-label="Variant SKU" /></td>
            <td><input value={variant.barcode ?? ""} onChange={(event) => updateVariant(index, { barcode: event.target.value || null })} aria-label="Variant barcode" /></td>
            <td><input type="number" min="0" step="0.01" value={variant.basePrice ?? ""} onChange={(event) => updateVariant(index, { basePrice: event.target.value ? Number(event.target.value) : null })} aria-label="Variant base price override" /></td>
            <td><input type="number" min="0" step="0.001" value={variant.weight ?? ""} onChange={(event) => updateVariant(index, { weight: event.target.value ? Number(event.target.value) : null })} aria-label="Variant weight override" /></td>
            {permissions.includes("inventory.view") && <td>{variant.id && variantInventory.some((item) => item.variantId === variant.id) ? <div className="catalog-stack">{variantInventory.filter((item) => item.variantId === variant.id).map((item) => <small key={item.id}><strong>{item.warehouseName} ({item.warehouseCode})</strong><br />{inventoryPresentation(item)} · {item.quantityOnHand} on hand · {item.quantityReserved} reserved · {item.available} available</small>)}</div> : <small>No inventory record</small>}</td>}
            <td><input type="checkbox" checked={variant.active} onChange={(event) => updateVariant(index, { active: event.target.checked })} aria-label="Variant active" /></td>
          </tr>)}</tbody></table></div> : <p className="catalog-help">This product has no variants. Add dynamic options to generate combinations, or keep it as a simple parent product.</p>}
        </div>
      </FormSection>

      <FormSection title="Product media" description="Validated images and videos are stored outside PostgreSQL with generated public URLs. Describe the product, color, or key detail in image alt text; leave it empty only for decorative media.">
        <div className="catalog-stack">
          {!id && <p className="catalog-help">Save the product once before uploading media.</p>}
          {media.length > 0 && <div className="catalog-media-grid">{media.map((item) => <article key={item.id} className="catalog-media-card">
            {item.type === "image" ? <img src={item.url} alt={item.altText ?? ""} /> : <video src={item.url} controls preload="metadata" />}
            <div><strong>{item.isPrimary ? "Primary " : ""}{item.type}</strong><small>{item.altText || "No alt text"}</small></div>
            {canSave && <button type="button" className="icon-button" onClick={() => void removeMedia(item)} aria-label="Remove media"><Icon name="x" size={15} /></button>}
          </article>)}</div>}
          {id && canSave && <div className="catalog-media-upload">
            <label className="catalog-field">Image or video<input type="file" accept="image/jpeg,image/png,image/webp,image/gif,video/mp4,video/webm,video/quicktime" onChange={(event) => setMediaFile(event.target.files?.[0] ?? null)} /></label>
            <label className="catalog-field">Alt text<input value={mediaAlt} onChange={(event) => setMediaAlt(event.target.value)} /></label>
            <label className="catalog-field">Variant association<select value={mediaVariantId} onChange={(event) => setMediaVariantId(event.target.value)}><option value="">Whole product</option>{variants.filter((variant) => variant.id).map((variant) => <option key={variant.id} value={variant.id}>{variant.title}</option>)}</select></label>
            <label className="catalog-check"><input type="checkbox" checked={mediaPrimary} onChange={(event) => setMediaPrimary(event.target.checked)} /><span><strong>Primary image</strong><small>Replaces the existing primary image</small></span></label>
            <button className="button button--quiet button--small" disabled={!mediaFile} type="button" onClick={() => void uploadMedia()}>Upload media</button>
          </div>}
        </div>
      </FormSection>

      <FormActions>
        <div>{canArchive && <button className="button button--quiet button--small catalog-danger" type="button" onClick={() => setArchiveOpen(true)}>{form.status === "archived" ? "Restore product" : "Archive product"}</button>}</div>
        <div className="catalog-inline-actions"><Link className="button button--quiet button--small" to="/admin/products">Cancel</Link><button className="button button--dark button--small" disabled={!canSave || saving} type="submit">{saving ? "Saving…" : "Save product"}</button></div>
      </FormActions>
    </form>
    <ConfirmationDialog open={archiveOpen} title={form.status === "archived" ? "Restore this product?" : "Archive this product?"} description={form.status === "archived" ? "The product will return to active, published status." : "The product will be unpublished and preserved for historical relationships. It will not be hard-deleted."} confirmLabel={form.status === "archived" ? "Restore product" : "Archive product"} onConfirm={() => void archive()} onCancel={() => setArchiveOpen(false)} />
  </div>;
}