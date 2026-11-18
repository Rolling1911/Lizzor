import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { apiRequest } from "../../auth/api";
import { useAuth } from "../../auth/AuthContext";
import { AdminPageHeader, ConfirmationDialog, ErrorState, LoadingState, StatusBadge } from "../../components/admin/AdminPrimitives";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import LinkExtension from "@tiptap/extension-link";
import { Table } from "@tiptap/extension-table";
import TableRow from "@tiptap/extension-table-row";
import TableCell from "@tiptap/extension-table-cell";
import TableHeader from "@tiptap/extension-table-header";
import { ContentDocument } from "../../components/content/ContentDocument";

type Section = { key: string; title: string; sortOrder: number; active: boolean };
type BodyJson = { type: "doc"; content?: any[] };
type Page = { id: string; slug: string; pageType: string; title: string; excerpt: string | null; bodyJson: BodyJson; seoTitle: string | null; seoDescription: string | null; noIndex: boolean; status: "draft" | "published" | "archived"; createdAt: string; updatedAt: string; publishedAt?: string | null; archivedAt?: string | null; createdByAdmin?: string | null; updatedByAdmin?: string | null; publishedByAdmin?: string | null; archivedByAdmin?: string | null };
const emptyDoc: BodyJson = { type: "doc", content: [{ type: "paragraph" }] };
const blankPage: Omit<Page, "id" | "status" | "createdAt" | "updatedAt"> = { slug: "", pageType: "informational", title: "", excerpt: "", bodyJson: emptyDoc, seoTitle: "", seoDescription: "", noIndex: false };

function normalizeDoc(body: any): BodyJson {
  if (body?.type === "doc") return body;
  if (Array.isArray(body?.blocks)) return { type: "doc", content: body.blocks.map((block: any) => ({ type: block.type === "list" ? "bulletList" : block.type === "heading" ? "heading" : "paragraph", ...(block.type === "heading" ? { attrs: { level: 2 } } : {}), content: [{ type: "text", text: block.text || "" }] })) };
  return emptyDoc;
}

export function ConstrainedContentEditor({ value, onChange }: { value: BodyJson; onChange: (value: BodyJson) => void }) {
  const editor = useEditor({
    extensions: [StarterKit.configure({ link: false }), LinkExtension.configure({ openOnClick: false, protocols: ["http", "https", "mailto", "tel"], validate: (href) => /^(https?:|mailto:|tel:)/i.test(href) || /^\/(?!\/)/.test(href) }), Table.configure({ resizable: false }), TableRow, TableHeader, TableCell],
    content: normalizeDoc(value),
    onUpdate: ({ editor: instance }) => onChange(instance.getJSON() as BodyJson),
    editorProps: { attributes: { class: "content-rich-editor__area", "aria-label": "Page content" } },
  });
  useEffect(() => { if (editor && JSON.stringify(editor.getJSON()) !== JSON.stringify(normalizeDoc(value))) editor.commands.setContent(normalizeDoc(value)); }, [editor, value]);
  if (!editor) return <div className="content-rich-editor">Loading editor…</div>;
  const button = (label: string, active: boolean, action: () => void) => <button type="button" className={`button button--quiet button--small ${active ? "is-active" : ""}`} onClick={action}>{label}</button>;
  return <div className="content-rich-editor"><div className="content-rich-editor__toolbar" role="toolbar" aria-label="Formatting">
    {button("Paragraph", editor.isActive("paragraph"), () => editor.chain().focus().setParagraph().run())}
    {button("H2", editor.isActive("heading", { level: 2 }), () => editor.chain().focus().toggleHeading({ level: 2 }).run())}
    {button("H3", editor.isActive("heading", { level: 3 }), () => editor.chain().focus().toggleHeading({ level: 3 }).run())}
    {button("H4", editor.isActive("heading", { level: 4 }), () => editor.chain().focus().toggleHeading({ level: 4 }).run())}
    {button("Bold", editor.isActive("bold"), () => editor.chain().focus().toggleBold().run())}
    {button("Italic", editor.isActive("italic"), () => editor.chain().focus().toggleItalic().run())}
    {button("Link", editor.isActive("link"), () => { const href = window.prompt("Link URL (https://, mailto:, tel:, or /path)"); if (href && (/^(https?:|mailto:|tel:)/i.test(href) || /^\/(?!\/)/.test(href))) editor.chain().focus().setLink({ href }).run(); })}
    {button("• List", editor.isActive("bulletList"), () => editor.chain().focus().toggleBulletList().run())}
    {button("1. List", editor.isActive("orderedList"), () => editor.chain().focus().toggleOrderedList().run())}
    {button("Quote", editor.isActive("blockquote"), () => editor.chain().focus().toggleBlockquote().run())}
    {button("Table", editor.isActive("table"), () => editor.chain().focus().insertTable({ rows: 2, cols: 2, withHeaderRow: true }).run())}
    {editor.isActive("table") && button("+ Row", false, () => editor.chain().focus().addRowAfter().run())}
    {editor.isActive("table") && button("+ Column", false, () => editor.chain().focus().addColumnAfter().run())}
    {editor.isActive("table") && button("Delete table", false, () => editor.chain().focus().deleteTable().run())}
  </div><EditorContent editor={editor} /></div>;
}

export function HomepageControlPage() {
  const { permissions } = useAuth();
  const [sections, setSections] = useState<Section[]>([]), [banners, setBanners] = useState<any[]>([]);
  const [error, setError] = useState(""), [saving, setSaving] = useState(false);
  const load = () => apiRequest<{ data: { sections: Section[]; banners: any[] } }>("/admin/homepage").then((r) => { setSections(r.data.sections); setBanners(r.data.banners); }).catch((e) => setError(e.message));
  useEffect(() => { void load(); }, []);
  const move = (index: number, delta: number) => setSections((current) => { const next = [...current], target = index + delta; if (target < 0 || target >= next.length) return current; [next[index], next[target]] = [next[target], next[index]]; return next; });
  const save = async () => { setSaving(true); setError(""); try { await apiRequest("/admin/homepage", { method: "PUT", body: JSON.stringify({ sections: sections.map(({ key, active }) => ({ key, active })) }) }); await load(); } catch (e: any) { setError(e.message); } finally { setSaving(false); } };
  if (!sections.length && !error) return <LoadingState />;
  return <div className="admin-page"><AdminPageHeader eyebrow="Content control" title="Homepage" description="Order and publish the homepage’s existing sections. Banner artwork remains in Storefront → Banners." actions={<Link className="button button--quiet" to="/admin/storefront/banners">Manage banner artwork</Link>} />
    {error && <ErrorState description={error} onRetry={load} />}
    <section className="admin-panel control-list"><div className="admin-panel__heading"><div><h2>Section sequence</h2><p>Public rendering follows this order. Hidden sections retain their content.</p></div></div>
      {sections.map((section, index) => <div className="control-row" key={section.key}><div><strong>{index + 1}. {section.title}</strong><span>{section.key === "hero" || section.key === "app_banner" ? "Artwork managed in Banners" : "Uses live storefront data"}</span></div><div className="control-row__actions"><button className="button button--quiet button--small" disabled={index === 0} onClick={() => move(index, -1)}>Up</button><button className="button button--quiet button--small" disabled={index === sections.length - 1} onClick={() => move(index, 1)}>Down</button><label className="control-toggle"><input type="checkbox" checked={section.active} onChange={(e) => setSections((items) => items.map((item) => item.key === section.key ? { ...item, active: e.target.checked } : item))} /> Visible</label></div></div>)}
      {permissions.includes("homepage.manage") && <div className="admin-form-actions"><button className="button button--dark" disabled={saving} onClick={save}>{saving ? "Saving…" : "Save homepage"}</button></div>}
    </section>
    <section className="admin-panel"><div className="admin-panel__heading"><div><h2>Banner readiness</h2><p>Read-only status from the dedicated banner workspace.</p></div></div><div className="readiness-grid">{["homepage_hero", "homepage_app_banner"].map((slot) => { const banner = banners.find((item) => item.slot === slot); const live = banner?.enabled && banner?.publishedAt; return <div key={slot}><strong>{slot === "homepage_hero" ? "Hero" : "App banner"}</strong><StatusBadge status={live ? "Published" : "Fallback active"} tone={live ? "positive" : "warning"} /></div>; })}</div></section>
  </div>;
}

export function ContentPagesPage() {
  const { permissions } = useAuth();
  const [pages, setPages] = useState<Page[]>([]), [editing, setEditing] = useState<Page | null>(null), [draft, setDraft] = useState<any>(blankPage), [error, setError] = useState(""), [saving, setSaving] = useState(false), [search, setSearch] = useState(""), [status, setStatus] = useState("all"), [confirm, setConfirm] = useState<{ page: Page; action: "publish" | "unpublish" | "archive" } | null>(null), [preview, setPreview] = useState<any>(null), [previewReceipt, setPreviewReceipt] = useState("");
  const load = () => {
    const query = new URLSearchParams();
    if (status !== "all") query.set("status", status);
    if (search.trim()) query.set("search", search.trim());
    return apiRequest<{ data: { items: Page[] } }>(`/admin/content${query.size ? `?${query}` : ""}`).then((r) => setPages(r.data.items)).catch((e) => setError(e.message));
  };
  useEffect(() => { void load(); }, [status, search]);
  const edit = (page?: Page) => { setEditing(page ?? null); setPreview(null); setPreviewReceipt(""); setDraft(page ? { ...page, bodyJson: normalizeDoc(page.bodyJson) } : { ...blankPage, bodyJson: emptyDoc }); };
  const save = async () => { setSaving(true); setError(""); try { const payload = { slug: draft.slug, pageType: draft.pageType, title: draft.title, excerpt: draft.excerpt || null, bodyJson: normalizeDoc(draft.bodyJson), seoTitle: draft.seoTitle || null, seoDescription: draft.seoDescription || null, noIndex: !!draft.noIndex }; const result = await apiRequest<{ data: Page }>(editing ? `/admin/content/${editing.id}` : "/admin/content", { method: editing ? "PATCH" : "POST", body: JSON.stringify(payload) }); setEditing(result.data); setDraft({ ...result.data, bodyJson: normalizeDoc(result.data.bodyJson) }); setPreview(null); setPreviewReceipt(""); await load(); } catch (e: any) { setError(e.message); } finally { setSaving(false); } };
  const transition = async () => { if (!confirm) return; try { const payload = { action: confirm.action, confirmed: true, ...(confirm.action === "publish" ? { previewReceipt } : {}) }; const result = await apiRequest<{ data: Page }>(`/admin/content/${confirm.page.id}/status`, { method: "POST", body: JSON.stringify(payload) }); setConfirm(null); setPreview(null); setPreviewReceipt(""); if (editing?.id === result.data.id) { setEditing(result.data); setDraft({ ...result.data, bodyJson: normalizeDoc(result.data.bodyJson) }); } await load(); } catch (e: any) { setError(e.message); } };
  const loadPreview = async () => { if (!editing) return; try { const result = await apiRequest<{ data: { page: Page; previewReceipt: string } }>(`/admin/content/${editing.id}/preview`, { method: "POST", body: "{}" }); setPreview(result.data.page); setPreviewReceipt(result.data.previewReceipt); } catch (e: any) { setError(e.message); } };
  return <div className="admin-page"><AdminPageHeader eyebrow="CMS" title="Content pages" description="Create informational, help, FAQ, and about pages. Canonical Legal & Compliance documents remain in their separate workspace." actions={permissions.includes("content.manage") && <button className="button button--dark" onClick={() => edit()}>New page</button>} />{error && <ErrorState description={error} />}
    <div className="content-control-layout"><section className="admin-panel control-list"><div className="content-list-filters"><input aria-label="Search content pages" placeholder="Search pages" value={search} onChange={(e) => setSearch(e.target.value)} /><select aria-label="Filter by status" value={status} onChange={(e) => setStatus(e.target.value)}><option value="all">All statuses</option><option value="draft">Draft</option><option value="published">Published</option><option value="archived">Archived</option></select></div>{pages.length ? pages.map((page) => <div className="control-row" key={page.id}><button className="control-row__main" onClick={() => edit(page)}><strong>{page.title}</strong><span>/pages/{page.slug} · {page.pageType} · Updated {new Date(page.updatedAt).toLocaleString()} {page.updatedByAdmin ? `· ${page.updatedByAdmin}` : ""}</span></button><div className="control-row__actions"><StatusBadge status={page.status} tone={page.status === "published" ? "positive" : page.status === "archived" ? "neutral" : "warning"} />{permissions.includes("content.manage") && page.status === "published" && <button className="button button--quiet button--small" onClick={() => setConfirm({ page, action: "unpublish" })}>Unpublish</button>}{permissions.includes("content.manage") && page.status !== "archived" && <button className="button button--quiet button--small" onClick={() => setConfirm({ page, action: "archive" })}>Archive</button>}</div></div>) : <p>No content pages yet.</p>}</section>
      <section className="admin-panel content-editor"><div className="admin-panel__heading"><div><h2>{editing ? "Edit page" : "Create page"}</h2><p>{editing ? `Current status: ${editing.status}. Save draft before previewing.` : "Saved as a draft until explicitly published."}</p></div></div>
        <div className="admin-form-grid"><label>Title<input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} /></label><label>Slug<input value={draft.slug} onChange={(e) => setDraft({ ...draft, slug: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-") })} /></label><label>Page type<select value={draft.pageType} onChange={(e) => setDraft({ ...draft, pageType: e.target.value })}>{["informational","about","help","faq","legal"].map((value) => <option key={value} value={value}>{value === "legal" ? "Legal information (not compliance document)" : value}</option>)}</select>{draft.pageType === "legal" && <span>Canonical policies and compliance documents must be managed only in Legal &amp; Compliance.</span>}</label><label>SEO title<input maxLength={70} value={draft.seoTitle ?? ""} onChange={(e) => setDraft({ ...draft, seoTitle: e.target.value })} /></label><label className="admin-form-grid__wide">SEO description<textarea maxLength={170} value={draft.seoDescription ?? ""} onChange={(e) => setDraft({ ...draft, seoDescription: e.target.value })} /></label><label className="admin-form-grid__wide">Page content<ConstrainedContentEditor value={normalizeDoc(draft.bodyJson)} onChange={(bodyJson) => setDraft({ ...draft, bodyJson })} /></label><label><input type="checkbox" checked={!!draft.noIndex} onChange={(e) => setDraft({ ...draft, noIndex: e.target.checked })} /> Exclude from search indexing</label></div>
        {editing && <p className="content-attribution">Created {new Date(editing.createdAt).toLocaleString()} by {editing.createdByAdmin || "administrator"} · Updated {new Date(editing.updatedAt).toLocaleString()} by {editing.updatedByAdmin || "administrator"}{editing.publishedAt ? ` · Published ${new Date(editing.publishedAt).toLocaleString()} by ${editing.publishedByAdmin || "administrator"}` : ""}{editing.archivedAt ? ` · Archived ${new Date(editing.archivedAt).toLocaleString()} by ${editing.archivedByAdmin || "administrator"}` : ""}</p>}
        {preview && <div className="content-preview"><span className="eyebrow">Saved preview</span><h2>{preview.title}</h2>{preview.excerpt && <p>{preview.excerpt}</p>}<ContentDocument body={normalizeDoc(preview.bodyJson)} />{permissions.includes("content.manage") && editing?.status === "draft" && <button className="button button--dark" onClick={() => setConfirm({ page: editing, action: "publish" })}>Continue to publish</button>}</div>}
        {permissions.includes("content.manage") && <div className="admin-form-actions"><button className="button button--dark" disabled={saving} onClick={save}>{saving ? "Saving…" : "Save draft"}</button>{editing && <button className="button button--quiet" onClick={loadPreview}>Preview</button>}</div>}
      </section></div>
      <ConfirmationDialog open={!!confirm} title={`${confirm?.action === "publish" ? "Publish" : confirm?.action === "unpublish" ? "Unpublish" : "Archive"} page?`} description={confirm?.action === "publish" ? "Confirm that you reviewed this saved preview. Publishing will make the page public and eligible for indexing unless noindex is enabled." : confirm?.action === "unpublish" ? "The public page will immediately become unavailable and return to Draft." : "The public page will immediately become unavailable and move to Archived."} confirmLabel={confirm?.action === "publish" ? "Confirm and publish" : confirm?.action === "unpublish" ? "Confirm unpublish" : "Confirm archive"} onConfirm={transition} onCancel={() => setConfirm(null)} />
  </div>;
}

export function SettingsControlPage() {
  const { permissions } = useAuth();
  const [data, setData] = useState<any>(null), [values, setValues] = useState<Record<string, any>>({}), [error, setError] = useState("");
  const load = () => apiRequest<{ data: any }>("/admin/settings").then((r) => { setData(r.data); setValues(Object.fromEntries(r.data.settings.map((item: any) => [item.key, item.value]))); }).catch((e) => setError(e.message));
  useEffect(() => { void load(); }, []);
  if (!data && !error) return <LoadingState />;
  const save = async () => { try { await apiRequest("/admin/settings", { method: "PATCH", body: JSON.stringify({ values }) }); await load(); } catch (e: any) { setError(e.message); } };
  return <div className="admin-page"><AdminPageHeader eyebrow="Administration" title="Settings" description="Validated non-secret presentation settings and truthful infrastructure readiness." />{error && <ErrorState description={error} onRetry={load} />}
    {data && <><section className="admin-panel"><div className="admin-panel__heading"><div><h2>Provider readiness</h2><p>Configuration status only. This does not claim remote reachability.</p></div></div><div className="readiness-grid">{Object.entries(data.readiness).map(([key, value]) => <div key={key}><strong>{key}</strong><StatusBadge status={String(value).replaceAll("_", " ")} tone={value === "configured" ? "positive" : "warning"} /></div>)}</div></section>
    <section className="admin-panel"><div className="admin-panel__heading"><div><h2>Safe settings</h2><p>Currency and reservation rules are authoritative, read-only commerce invariants.</p></div></div><div className="invariant-strip"><span>Currency <strong>{data.invariants.currency}</strong></span><span>Reservation <strong>{data.invariants.checkoutReservationMinutes} min</strong></span><span>Payment mode <strong>{data.invariants.paymentProvider}</strong></span></div><div className="admin-form-grid">{data.settings.map((item: any) => <label key={item.key}>{item.label}<input value={values[item.key]} onChange={(e) => setValues({ ...values, [item.key]: e.target.value })} /></label>)}</div>{permissions.includes("settings.manage") && <div className="admin-form-actions"><button className="button button--dark" onClick={save}>Save settings</button></div>}</section></>}
  </div>;
}