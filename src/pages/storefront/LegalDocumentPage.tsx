import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { apiRequest } from "../../auth/api";
import { SeoMeta } from "../../components/seo/SeoMeta";

type LegalDocument = { title: string; publicRoute: string; effectiveAt: string; publishedAt: string; updatedAt: string; pdfUrl: string | null; pdfOriginalFilename: string | null; bodyJson: { blocks: Array<{ type: "heading" | "paragraph" | "list"; text: string }> } };
export function LegalDocumentPage() {
  const { pathname } = useLocation();
  const [document, setDocument] = useState<LegalDocument | null>(null);
  const [documents, setDocuments] = useState<Array<Pick<LegalDocument, "title" | "publicRoute">>>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    setDocument(null); setDocuments([]); setError("");
    if (pathname === "/legal") { apiRequest<{ data: Array<Pick<LegalDocument, "title" | "publicRoute">> }>("/legal-documents").then((result) => setDocuments(result.data)).catch((reason) => setError(reason.message)); return; }
    apiRequest<{ data: LegalDocument }>(`/legal-documents/route${pathname}`).then((result) => setDocument(result.data)).catch((reason) => setError(reason.message));
  }, [pathname]);
  if (pathname === "/legal") return <main className="shell legal-page"><SeoMeta title="Legal information" description="Published Lizzor legal information." canonicalPath="/legal" /><span className="eyebrow">Lizzor legal information</span><h1>Legal information</h1>{error ? <p>{error}</p> : documents.length ? <ul>{documents.map((item) => <li key={item.publicRoute}><a href={item.publicRoute}>{item.title}</a></li>)}</ul> : <p>No legal documents are currently published.</p>}</main>;
  if (error) return <main className="shell legal-page"><h1>Page not found</h1><p>{error}</p></main>;
  if (!document) return <main className="shell legal-page"><p>Loading page…</p></main>;
  const hasReadableContent = document.bodyJson.blocks.length > 0;
  return <main className="shell legal-page"><SeoMeta title={document.title} description={`${document.title} at Lizzor.`} canonicalPath={document.publicRoute} />
    <span className="eyebrow">Lizzor legal information</span><h1>{document.title}</h1>
    <p className="legal-page__intro">Effective {new Date(document.effectiveAt).toLocaleDateString()} · Last updated {new Date(document.updatedAt).toLocaleDateString()}</p>
    {document.pdfUrl && <div className="legal-page__pdf"><p>{hasReadableContent ? "The official PDF version is available to view or download." : "This document is available as an approved PDF."}</p><a className="button button--dark" href={document.pdfUrl} target="_blank" rel="noreferrer">View official PDF</a><a className="button button--quiet" href={`${document.pdfUrl}&download=1`}>Download PDF</a></div>}
    {hasReadableContent ? <article>{document.bodyJson.blocks.map((block, index) => block.type === "heading" ? <h2 key={index}>{block.text}</h2> : block.type === "list" ? <ul key={index}>{block.text.split("\n").filter(Boolean).map((item) => <li key={item}>{item.replace(/^[-•]\s*/, "")}</li>)}</ul> : <p key={index}>{block.text}</p>)}</article> : !document.pdfUrl ? <p>This document is not available in a readable format.</p> : null}
    <p><Link className="text-link" to="/legal">Back to Legal Center</Link></p>
  </main>;
}