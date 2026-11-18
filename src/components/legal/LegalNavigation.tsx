import { Link } from "react-router-dom";
import { useEffect, useState } from "react";
import { apiRequest } from "../../auth/api";

export const legalNavigationLocations = ["footer", "mobile", "authentication", "account", "checkout"] as const;
export type LegalNavigationLocation = typeof legalNavigationLocations[number];
export type LegalLink = { title: string; publicRoute: string };

/** Server readiness remains authoritative; no caller can expose unpublished links. */
export function LegalNavigation({ enabled = true, location }: { enabled?: boolean; location: LegalNavigationLocation }) {
  const [links, setLinks] = useState<LegalLink[]>([]);
  useEffect(() => { if (enabled) void apiRequest<{ data: { enabled: boolean; links: LegalLink[] } }>("/legal-navigation").then((result) => setLinks(result.data.enabled ? result.data.links : [])).catch(() => setLinks([])); }, [enabled]);
  if (!enabled || !links.length) return null;
  return <nav aria-label={`${location} legal links`}>{links.map((link) => <Link key={link.publicRoute} to={link.publicRoute}>{link.title}</Link>)}</nav>;
}