import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { apiRequest } from "../../auth/api";
import type { LegalLink } from "./LegalNavigation";
import { safeLocalStorageGet, safeLocalStorageSet } from "../../lib/browserStorage";

export type CookiePreferences = { version: 1; essential: true; analytics: boolean; marketing: boolean };
const key = "lizzor.cookie-preferences.v1";
const defaults: CookiePreferences = { version: 1, essential: true, analytics: false, marketing: false };
export function readCookiePreferences(): CookiePreferences | null {
  try { const saved = JSON.parse(safeLocalStorageGet(key) ?? "null"); return saved?.version === 1 && saved.essential === true ? { ...defaults, analytics: Boolean(saved.analytics), marketing: Boolean(saved.marketing) } : null; } catch { return null; }
}
/** Future analytics/marketing loaders must use this guard before loading. */
export function cookieConsentAllows(category: "essential" | "analytics" | "marketing", preferences = readCookiePreferences()): boolean {
  return category === "essential" || Boolean(preferences?.[category]);
}
export function CookieConsent() {
  const [saved, setSaved] = useState<CookiePreferences | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<CookiePreferences>(defaults);
  const [cookiePolicyRoute, setCookiePolicyRoute] = useState<string | null>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const firstRef = useRef<HTMLButtonElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const value = readCookiePreferences(); setSaved(value); setDraft(value ?? defaults); setLoaded(true);
    void apiRequest<{ data: { enabled: boolean; links: LegalLink[] } }>("/legal-navigation")
      .then(({ data }) => setCookiePolicyRoute(data.enabled ? data.links.find((link) => link.publicRoute === "/cookies")?.publicRoute ?? null : null))
      .catch(() => setCookiePolicyRoute(null));
    const reopen = () => {
      returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setDraft(readCookiePreferences() ?? defaults);
      setOpen(true);
    };
    window.addEventListener("lizzor:open-cookie-settings", reopen);
    return () => window.removeEventListener("lizzor:open-cookie-settings", reopen);
  }, []);
  useEffect(() => {
    if (!saved || !open) return;
    requestAnimationFrame(() => firstRef.current?.focus());
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
        requestAnimationFrame(() => returnFocusRef.current?.focus());
        return;
      }
      if (event.key !== "Tab") return;
      const nodes = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), a[href]') ?? []);
      if (!nodes.length) return;
      if (event.shiftKey && document.activeElement === nodes[0]) { event.preventDefault(); nodes[nodes.length - 1].focus(); }
      if (!event.shiftKey && document.activeElement === nodes[nodes.length - 1]) { event.preventDefault(); nodes[0].focus(); }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, saved]);
  const persist = (value: CookiePreferences) => { safeLocalStorageSet(key, JSON.stringify(value)); setSaved(value); setDraft(value); setOpen(false); window.dispatchEvent(new CustomEvent("lizzor:cookie-preferences", { detail: value })); };
  const openPreferences = (trigger: HTMLElement) => { returnFocusRef.current = trigger; setOpen(true); };
  const closePreferences = () => { setOpen(false); requestAnimationFrame(() => returnFocusRef.current?.focus()); };
  if (!loaded) return null;
  if (saved && !open) return null;
  return <section ref={dialogRef} className="cookie-consent" role="dialog" aria-modal="true" aria-labelledby="cookie-consent-title" aria-describedby="cookie-consent-description">
    <div className="cookie-consent__heading"><span className="eyebrow">Privacy at Lizzor</span>{open && <button ref={firstRef} type="button" className="cookie-consent__close" aria-label="Close cookie preferences" onClick={closePreferences}>×</button>}</div>
    <h2 id="cookie-consent-title">{open ? "Manage preferences" : "Your privacy choices"}</h2>
    <p id="cookie-consent-description">{open ? "Choose which optional technologies Lizzor may use. Essential technologies are always active." : "We use essential technologies to keep Lizzor secure and make checkout work. With your permission, we may also use analytics and marketing technologies."}</p>
    {open && <div className="cookie-consent__choices">
      <div className="cookie-choice"><div><strong>Essential</strong><small>Required for security, sign-in, cart and checkout.</small></div><button type="button" className="cookie-switch is-on" role="switch" aria-checked="true" aria-label="Essential cookies, always on" disabled><span /></button></div>
      <div className="cookie-choice"><div><strong>Analytics</strong><small>Helps us understand storefront performance. Not currently used.</small></div><button type="button" className={`cookie-switch${draft.analytics ? " is-on" : ""}`} role="switch" aria-checked={draft.analytics} aria-label="Analytics" onClick={() => setDraft({ ...draft, analytics: !draft.analytics })}><span /></button></div>
      <div className="cookie-choice"><div><strong>Marketing</strong><small>Supports relevant campaigns. Not currently used.</small></div><button type="button" className={`cookie-switch${draft.marketing ? " is-on" : ""}`} role="switch" aria-checked={draft.marketing} aria-label="Marketing" onClick={() => setDraft({ ...draft, marketing: !draft.marketing })}><span /></button></div>
    </div>}
    <div className="cookie-consent__policy"><span>Your choices are stored on this device.</span>{cookiePolicyRoute ? <Link to={cookiePolicyRoute}>Cookie Policy</Link> : <span className="cookie-consent__policy-unavailable" aria-label="Cookie Policy is not yet published">Cookie Policy · awaiting publication</span>}</div>
    <div className="cookie-consent__actions">
      <button type="button" className="button button--quiet" onClick={() => persist(defaults)}>Reject non-essential</button>
      {!open && <button ref={firstRef} type="button" className="button button--quiet" onClick={(event) => openPreferences(event.currentTarget)}>Manage preferences</button>}
      <button type="button" className="button button--dark" onClick={() => persist({ ...defaults, analytics: true, marketing: true })}>Accept all</button>
      {open && <button type="button" className="button button--dark" onClick={() => persist(draft)}>Save preferences</button>}
    </div>
  </section>;
}