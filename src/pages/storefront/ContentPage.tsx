import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { apiRequest } from "../../auth/api";
import { SeoMeta } from "../../components/seo/SeoMeta";
import { ContentDocument, type ContentDocumentJson } from "../../components/content/ContentDocument";

type Content = { slug: string; title: string; excerpt: string | null; bodyJson: ContentDocumentJson; seoTitle: string | null; seoDescription: string | null; noIndex: boolean; updatedAt: string };
function toDocument(body: any): ContentDocumentJson {
  if (body?.type === "doc") return body;
  if (Array.isArray(body?.blocks)) return { type: "doc", content: body.blocks.map((block: any) => ({ type: block.type === "heading" ? "heading" : "paragraph", ...(block.type === "heading" ? { attrs: { level: 2 } } : {}), content: [{ type: "text", text: block.text || "" }] })) };
  return { type: "doc", content: [] };
}

export function ContentPage() {
  const { slug = "" } = useParams();
  const [page, setPage] = useState<Content | null>(null), [error, setError] = useState("");
  useEffect(() => { setPage(null); setError(""); apiRequest<{ data: Content }>(`/content/${slug}`).then((response) => setPage(response.data)).catch((reason) => setError(reason.message)); }, [slug]);
  if (error) return <main className="shell legal-page"><h1>Page not found</h1><p>{error}</p></main>;
  if (!page) return <main className="shell legal-page"><p>Loading page…</p></main>;
  return <main className="shell legal-page">
    <SeoMeta title={page.seoTitle || page.title} description={page.seoDescription || page.excerpt || `${page.title} at Lizzor.`} noIndex={page.noIndex} canonicalPath={`/pages/${page.slug}`} />
    <span className="eyebrow">Lizzor information</span><h1>{page.title}</h1>{page.excerpt && <p className="legal-page__intro">{page.excerpt}</p>}
    <article><ContentDocument body={toDocument(page.bodyJson)} /></article>
  </main>;
}