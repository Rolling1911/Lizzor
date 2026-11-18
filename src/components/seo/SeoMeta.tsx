import { useEffect } from "react";
import { useLocation } from "react-router-dom";

export type SeoMetaProps = {
  title: string;
  description: string;
  canonicalPath?: string;
  noIndex?: boolean;
  image?: string | null;
  type?: "website" | "product";
  jsonLd?: Record<string, unknown> | Array<Record<string, unknown>>;
};

const siteName = "Lizzor";

function upsertMeta(selector: string, attribute: "name" | "property", value: string, content: string) {
  let element = document.head.querySelector<HTMLMetaElement>(selector);
  if (!element) {
    element = document.createElement("meta");
    element.setAttribute(attribute, value);
    document.head.append(element);
  }
  element.content = content;
}

/** Updates document metadata for public routes without requiring a page-specific head implementation. */
export function useSeoMeta({ title, description, canonicalPath, noIndex = false, image, type = "website", jsonLd }: SeoMetaProps) {
  const location = useLocation();
  useEffect(() => {
    const canonicalUrl = new URL(canonicalPath ?? location.pathname, window.location.origin).toString();
    const fullTitle = title === siteName ? siteName : `${title} · ${siteName}`;
    document.title = fullTitle;
    upsertMeta('meta[name="description"]', "name", "description", description);
    upsertMeta('meta[name="robots"]', "name", "robots", noIndex ? "noindex,follow" : "index,follow");
    upsertMeta('meta[property="og:title"]', "property", "og:title", fullTitle);
    upsertMeta('meta[property="og:description"]', "property", "og:description", description);
    upsertMeta('meta[property="og:type"]', "property", "og:type", type);
    upsertMeta('meta[property="og:url"]', "property", "og:url", canonicalUrl);
    upsertMeta('meta[property="og:site_name"]', "property", "og:site_name", siteName);
    upsertMeta('meta[name="twitter:card"]', "name", "twitter:card", image ? "summary_large_image" : "summary");
    upsertMeta('meta[name="twitter:title"]', "name", "twitter:title", fullTitle);
    upsertMeta('meta[name="twitter:description"]', "name", "twitter:description", description);
    const absoluteImage = image ? new URL(image, window.location.origin).toString() : "";
    const ogImage = document.head.querySelector<HTMLMetaElement>('meta[property="og:image"]');
    const twitterImage = document.head.querySelector<HTMLMetaElement>('meta[name="twitter:image"]');
    if (absoluteImage) {
      upsertMeta('meta[property="og:image"]', "property", "og:image", absoluteImage);
      upsertMeta('meta[name="twitter:image"]', "name", "twitter:image", absoluteImage);
    } else { ogImage?.remove(); twitterImage?.remove(); }
    let canonical = document.head.querySelector<HTMLLinkElement>('link[rel="canonical"]');
    if (!canonical) { canonical = document.createElement("link"); canonical.rel = "canonical"; document.head.append(canonical); }
    canonical.href = canonicalUrl;
    const schemaId = "lizzor-json-ld";
    const previousSchema = document.getElementById(schemaId);
    if (jsonLd) {
      const schema = previousSchema ?? document.createElement("script");
      schema.id = schemaId;
      schema.setAttribute("type", "application/ld+json");
      schema.textContent = JSON.stringify(jsonLd).replace(/</g, "\\u003c");
      if (!previousSchema) document.head.append(schema);
    } else previousSchema?.remove();
  }, [canonicalPath, description, image, jsonLd, location.pathname, noIndex, title, type]);
}

export function SeoMeta(props: SeoMetaProps) {
  useSeoMeta(props);
  return null;
}