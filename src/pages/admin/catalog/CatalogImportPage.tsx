import { useState } from "react";
import { Link } from "react-router-dom";
import { apiRequest } from "../../../auth/api";
import { AdminPageHeader, ConfirmationDialog, EmptyState, ErrorState, LoadingState, StatusBadge } from "../../../components/admin/AdminPrimitives";
import type { CatalogLookups, ProductVariant } from "./types";

interface ImportError { row: number; field: string; message: string }
interface PreviewProduct {
  sourceRows: number[];
  name: string;
  parentSku: string;
  brandName: string | null;
  categoryName: string;
  variants: ProductVariant[];
}
interface Preview {
  previewId: string;
  products: PreviewProduct[];
  errors: ImportError[];
  unresolvedBrands: string[];
  unresolvedCategories: string[];
  counts: { rows: number; products: number; errors: number };
}
interface ImportSummary {
  imported: number;
  total: number;
  failed: Array<{ rows: number[]; message: string }>;
}

export function CatalogImportPage() {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [lookups, setLookups] = useState<CatalogLookups>({ categories: [], brands: [] });
  const [brandResolution, setBrandResolution] = useState<Record<string, string>>({});
  const [categoryResolution, setCategoryResolution] = useState<Record<string, string>>({});

  async function previewFile() {
    if (!file) return;
    setLoading(true); setError(""); setPreview(null); setSummary(null);
    const body = new FormData();
    body.append("file", file);
    try {
      const [response, lookupResponse] = await Promise.all([
        apiRequest<{ data: Preview }>("/admin/products/import/preview", { method: "POST", body }),
        apiRequest<{ data: CatalogLookups }>("/admin/catalog/lookups"),
      ]);
      setPreview(response.data);
      setLookups(lookupResponse.data);
      setBrandResolution({});
      setCategoryResolution({});
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "The import file could not be previewed.");
    } finally { setLoading(false); }
  }

  async function commit() {
    if (!preview) return;
    setConfirmOpen(false); setLoading(true); setError("");
    try {
      const response = await apiRequest<{ data: ImportSummary }>("/admin/products/import/commit", {
        method: "POST",
        body: JSON.stringify({ previewId: preview.previewId, resolution: { brands: brandResolution, categories: categoryResolution } }),
      });
      setSummary(response.data); setPreview(null);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "The import could not be committed.");
    } finally { setLoading(false); }
  }

  const hasBlockingIssues = Boolean(preview && (
    preview.errors.length
    || preview.unresolvedBrands.some((name) => !brandResolution[name])
    || preview.unresolvedCategories.some((name) => !categoryResolution[name])
  ));

  return <div className="admin-page catalog-page">
    <AdminPageHeader
      eyebrow="Bulk catalog workflow"
      title="Import products"
      description="Upload, parse, validate, preview, and explicitly confirm CSV or Excel catalog records before anything is inserted."
      actions={<div className="catalog-header-actions"><a className="button button--quiet button--small" href="/api/v1/admin/products/import/template">Download CSV template</a><Link className="button button--quiet button--small" to="/admin/products">Back to products</Link></div>}
    />
    {error && <ErrorState title="Import action failed" description={error} />}
    <section className="admin-panel catalog-import-panel">
      <div className="admin-panel__heading"><div><span className="eyebrow">Step 1</span><h2>Choose a catalog file</h2></div><span className="section-note">CSV · XLSX · up to 5,000 rows</span></div>
      <div className="catalog-import-drop">
        <input type="file" accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={(event) => { setFile(event.target.files?.[0] ?? null); setPreview(null); setSummary(null); }} />
        <div><strong>{file?.name ?? "No file selected"}</strong><span>Files are parsed in memory and are not inserted until confirmation.</span></div>
        <button className="button button--dark button--small" disabled={!file || loading} onClick={() => void previewFile()}>{loading ? "Validating…" : "Validate & preview"}</button>
      </div>
    </section>

    {loading && <LoadingState label="Processing catalog import…" />}
    {preview && <section className="admin-panel catalog-import-panel">
      <div className="admin-panel__heading"><div><span className="eyebrow">Step 2</span><h2>Validation preview</h2></div><div className="catalog-preview-badges"><StatusBadge status={`${preview.products.length} products`} tone="positive" /><StatusBadge status={`${preview.errors.length} errors`} tone={preview.errors.length ? "negative" : "positive"} /></div></div>
      {(preview.unresolvedBrands.length > 0 || preview.unresolvedCategories.length > 0) && <div className="catalog-resolution-warning">
        <strong>Resolve catalog references before import</strong>
        <p>Import never creates similar-looking brands or categories silently. Map each value to an existing record, or create the intended record in its catalog workspace and preview again.</p>
        {preview.unresolvedBrands.map((name) => <div key={`brand-${name}`}><span>Brand: <code>{name}</code></span><select aria-label={`Map brand ${name}`} value={brandResolution[name] ?? ""} onChange={(event) => setBrandResolution((current) => ({ ...current, [name]: event.target.value }))}><option value="">Reject unresolved brand</option>{lookups.brands.map((brand) => <option key={brand.id} value={brand.id}>{brand.name}</option>)}</select></div>)}
        {preview.unresolvedCategories.map((name) => <div key={`category-${name}`}><span>Category: <code>{name}</code></span><select aria-label={`Map category ${name}`} value={categoryResolution[name] ?? ""} onChange={(event) => setCategoryResolution((current) => ({ ...current, [name]: event.target.value }))}><option value="">Reject unresolved category</option>{lookups.categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select></div>)}
      </div>}
      {preview.errors.length > 0 && <div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>Row</th><th>Field</th><th>Error</th></tr></thead><tbody>{preview.errors.map((item, index) => <tr key={`${item.row}-${item.field}-${index}`}><td>{item.row}</td><td><code>{item.field}</code></td><td>{item.message}</td></tr>)}</tbody></table></div>}
      {preview.products.length > 0 ? <div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>Rows</th><th>Product</th><th>Parent SKU</th><th>Brand</th><th>Category</th><th>Variants</th></tr></thead><tbody>{preview.products.map((product) => <tr key={product.parentSku}><td>{product.sourceRows.join(", ")}</td><td><strong>{product.name}</strong></td><td><code>{product.parentSku}</code></td><td>{product.brandName ?? "—"}</td><td>{product.categoryName}</td><td>{product.variants.length}</td></tr>)}</tbody></table></div> : <EmptyState title="No importable products" description="The file did not contain valid product rows." />}
      <div className="catalog-import-actions"><p>{hasBlockingIssues ? "Confirmation is disabled until every row and reference is valid." : "All rows passed preview validation. Confirm to insert products in controlled batches."}</p><button className="button button--dark button--small" disabled={hasBlockingIssues || !preview.products.length} onClick={() => setConfirmOpen(true)}>Confirm import</button></div>
    </section>}
    {summary && <section className="admin-panel catalog-import-panel">
      <div className="admin-panel__heading"><div><span className="eyebrow">Complete</span><h2>Import summary</h2></div><StatusBadge status={`${summary.imported} imported`} tone={summary.failed.length ? "warning" : "positive"} /></div>
      <p className="catalog-help">{summary.imported} of {summary.total} products were imported. {summary.failed.length ? `${summary.failed.length} products failed and were not partially saved.` : "No products failed."}</p>
      {summary.failed.length > 0 && <ul className="catalog-error-list">{summary.failed.map((item, index) => <li key={index}>Rows {item.rows.join(", ")}: {item.message}</li>)}</ul>}
      <Link className="button button--dark button--small" to="/admin/products">View products</Link>
    </section>}
    <ConfirmationDialog open={confirmOpen} title="Import validated products?" description={`This will create ${preview?.products.length ?? 0} parent products and their variants in controlled batches. Existing unique SKUs, slugs, or barcodes will be rejected rather than overwritten.`} confirmLabel="Import products" onConfirm={() => void commit()} onCancel={() => setConfirmOpen(false)} />
  </div>;
}