import { useCallback, useEffect, useState } from "react";
import { apiRequest } from "../../../auth/api";
import { useAuth } from "../../../auth/AuthContext";
import { AdminPageHeader, ErrorState, FormActions, FormSection, LoadingState, StatusBadge } from "../../../components/admin/AdminPrimitives";
import { Icon } from "../../../components/ui/Icon";

type BannerSlot = "homepage_hero" | "homepage_app_banner";
type AppStatus = "coming_soon" | "live";
interface Banner {
  id: string;
  slot: BannerSlot;
  desktopUrl: string | null;
  mobileUrl: string | null;
  altText: string | null;
  enabled: boolean;
  appStatus: AppStatus;
  appStoreUrl: string | null;
  googlePlayUrl: string | null;
  qrImageUrl: string | null;
  publishedAt: string | null;
  updatedAt: string;
}

interface BannerDraft {
  altText: string;
  enabled: boolean;
  appStatus: AppStatus;
  appStoreUrl: string;
  googlePlayUrl: string;
  qrImageUrl: string;
}

const slotCopy: Record<BannerSlot, {
  title: string;
  description: string;
  desktop: string;
  mobile: string;
  desktopHint: string;
  mobileHint: string;
}> = {
  homepage_hero: {
    title: "Homepage Hero",
    description: "Replace the artwork only. The wholesale headline, CTAs, trust points, and accessible HTML remain live.",
    desktop: "1600 × 900 px",
    mobile: "900 × 1100 px",
    desktopHint: "Wide landscape artwork · minimum 1000 × 560 px",
    mobileHint: "Portrait-friendly artwork · minimum 560 × 680 px",
  },
  homepage_app_banner: {
    title: "Lizzor App Banner",
    description: "Replace the complete app artwork without adding duplicate text, badges, phones, or QR graphics.",
    desktop: "1920 × 480 px",
    mobile: "1920 × 480 px",
    desktopHint: "Full-width landscape artwork · minimum 1000 × 250 px",
    mobileHint: "Use the same complete artwork · minimum 1000 × 250 px",
  },
};

function draftFromBanner(banner: Banner): BannerDraft {
  return {
    altText: banner.altText ?? "",
    enabled: banner.enabled,
    appStatus: banner.appStatus,
    appStoreUrl: banner.appStoreUrl ?? "",
    googlePlayUrl: banner.googlePlayUrl ?? "",
    qrImageUrl: banner.qrImageUrl ?? "",
  };
}

export function StorefrontBannersPage() {
  const { permissions } = useAuth();
  const canManage = permissions.includes("storefront_banners.manage");
  const [banners, setBanners] = useState<Banner[]>([]);
  const [drafts, setDrafts] = useState<Partial<Record<BannerSlot, BannerDraft>>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<BannerSlot | null>(null);
  const [uploading, setUploading] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await apiRequest<{ data: Banner[] }>("/admin/storefront/banners");
      setBanners(response.data);
      setDrafts(Object.fromEntries(response.data.map((banner) => [banner.slot, draftFromBanner(banner)])));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The banner workspace could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  function updateDraft(slot: BannerSlot, patch: Partial<BannerDraft>) {
    setDrafts((current) => ({ ...current, [slot]: { ...current[slot]!, ...patch } }));
  }

  async function save(banner: Banner) {
    const draft = drafts[banner.slot];
    if (!draft || !canManage) return;
    setSaving(banner.slot);
    setError("");
    setNotice("");
    try {
      const response = await apiRequest<{ data: Banner }>(`/admin/storefront/banners/${banner.slot}`, {
        method: "PATCH",
        body: JSON.stringify({
          altText: draft.altText.trim() || null,
          enabled: draft.enabled,
          appStatus: draft.appStatus,
          appStoreUrl: draft.appStoreUrl.trim() || null,
          googlePlayUrl: draft.googlePlayUrl.trim() || null,
          qrImageUrl: draft.qrImageUrl.trim() || null,
        }),
      });
      setBanners((current) => current.map((item) => item.slot === banner.slot ? response.data : item));
      setDrafts((current) => ({ ...current, [banner.slot]: draftFromBanner(response.data) }));
      setNotice(`${slotCopy[banner.slot].title} changes saved. Publish when ready.`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The banner settings could not be saved.");
    } finally {
      setSaving(null);
    }
  }

  async function publish(banner: Banner) {
    if (!canManage) return;
    setSaving(banner.slot);
    setError("");
    setNotice("");
    try {
      const response = await apiRequest<{ data: Banner }>(`/admin/storefront/banners/${banner.slot}/publish`, { method: "POST" });
      setBanners((current) => current.map((item) => item.slot === banner.slot ? response.data : item));
      setNotice(`${slotCopy[banner.slot].title} is now published.`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The banner could not be published.");
    } finally {
      setSaving(null);
    }
  }

  async function upload(banner: Banner, device: "desktop" | "mobile", file: File | undefined) {
    if (!file || !canManage) return;
    const key = `${banner.slot}-${device}`;
    setUploading(key);
    setError("");
    setNotice("");
    const data = new FormData();
    data.append("file", file);
    try {
      const response = await apiRequest<{ data: Banner }>(`/admin/storefront/banners/${banner.slot}/assets/${device}`, { method: "POST", body: data });
      setBanners((current) => current.map((item) => item.slot === banner.slot ? response.data : item));
      setNotice(`${device === "desktop" ? "Desktop" : "Mobile"} artwork uploaded. Publish when ready.`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The artwork could not be uploaded.");
    } finally {
      setUploading(null);
    }
  }

  if (loading) return <LoadingState label="Loading storefront banner settings…" />;
  return <div className="admin-page storefront-banners-page">
    <AdminPageHeader
      eyebrow="Storefront"
      title="Banners"
      description="Manage responsive homepage artwork without changing the storefront’s live HTML content."
      actions={<span className="foundation-chip"><span className="status-dot" /> Controlled publishing</span>}
    />
    {error && <ErrorState title="Banner action failed" description={error} onRetry={() => void load()} />}
    {notice && <p className="catalog-notice" role="status"><Icon name="check" size={15} />{notice}</p>}
    <div className="storefront-banners-intro">
      <Icon name="shield-check" size={19} />
      <p><strong>Safe by default.</strong> Changes are saved as drafts until published. Disabled or unpublished artwork falls back to the built-in Lizzor treatment, and app store destinations stay inactive while the app is coming soon.</p>
    </div>
    <div className="storefront-banners-list">
      {(["homepage_hero", "homepage_app_banner"] as BannerSlot[]).map((slot) => {
        const banner = banners.find((item) => item.slot === slot);
        const draft = drafts[slot];
        if (!banner || !draft) return null;
        const copy = slotCopy[slot];
        return <article className="storefront-banner-editor" key={slot}>
          <div className="storefront-banner-editor__heading">
            <div><span className="eyebrow">{slot === "homepage_hero" ? "Primary placement" : "Mobile app placement"}</span><h2>{copy.title}</h2><p>{copy.description}</p></div>
            <div className="storefront-banner-editor__status"><StatusBadge status={draft.enabled ? "Enabled" : "Disabled"} tone={draft.enabled ? "positive" : "neutral"} /><StatusBadge status={banner.publishedAt ? "Published" : "Unpublished"} tone={banner.publishedAt ? "positive" : "warning"} /></div>
          </div>
          <div className="storefront-banner-previews">
            {(["desktop", "mobile"] as const).map((device) => {
              const url = device === "desktop" ? banner.desktopUrl : banner.mobileUrl;
              const hint = device === "desktop" ? copy.desktopHint : copy.mobileHint;
              return <div className={`storefront-banner-preview storefront-banner-preview--${device}`} key={device}>
                <div className="storefront-banner-preview__top"><strong>{device === "desktop" ? "Desktop artwork" : "Mobile artwork"}</strong><span>{device === "desktop" ? copy.desktop : copy.mobile}</span></div>
                <div className="storefront-banner-preview__media">{url ? <img src={url} alt={draft.altText || `${copy.title} ${device} preview`} /> : <><Icon name="panel-top" size={24} /><span>Built-in Lizzor artwork</span></>}</div>
                <small>{hint}</small>
                {canManage && <label className="button button--quiet button--small storefront-banner-upload"><Icon name="arrow-up-right" size={13} />{uploading === `${slot}-${device}` ? "Uploading…" : "Replace artwork"}<input type="file" accept="image/jpeg,image/png,image/webp,image/gif" disabled={uploading !== null} onChange={(event) => { void upload(banner, device, event.target.files?.[0]); event.currentTarget.value = ""; }} /></label>}
              </div>;
            })}
          </div>
          <FormSection title="Accessibility & visibility" description="Alt text describes meaningful artwork. Leave it empty only when the uploaded image is purely decorative.">
            <div className="storefront-banner-form-grid">
              <label className="catalog-field storefront-banner-form-grid__wide">Alt text<input maxLength={500} value={draft.altText} disabled={!canManage} onChange={(event) => updateDraft(slot, { altText: event.target.value })} placeholder="Describe the banner artwork" /></label>
              <label className="catalog-check"><input type="checkbox" checked={draft.enabled} disabled={!canManage} onChange={(event) => updateDraft(slot, { enabled: event.target.checked })} /><span><strong>Banner enabled</strong><small>Disabled banners use built-in artwork on the storefront</small></span></label>
            </div>
          </FormSection>
          {slot === "homepage_app_banner" && <FormSection title="App launch readiness" description="These fields are stored for launch day. Coming-soon mode always prevents public store links and QR destinations from becoming actionable.">
            <div className="storefront-banner-form-grid">
              <label className="catalog-field">App status<select value={draft.appStatus} disabled={!canManage} onChange={(event) => updateDraft(slot, { appStatus: event.target.value as AppStatus })}><option value="coming_soon">Coming soon</option><option value="live">Live</option></select></label>
              <p className="catalog-help storefront-banner-form-grid__wide">{draft.appStatus === "coming_soon" ? "Safe mode: badges remain non-clickable and the decorative QR treatment is retained." : "Live mode: configured HTTPS store links and QR artwork can be exposed publicly."}</p>
              <label className="catalog-field">App Store URL<input type="url" value={draft.appStoreUrl} disabled={!canManage} onChange={(event) => updateDraft(slot, { appStoreUrl: event.target.value })} placeholder="https://apps.apple.com/…" /></label>
              <label className="catalog-field">Google Play URL<input type="url" value={draft.googlePlayUrl} disabled={!canManage} onChange={(event) => updateDraft(slot, { googlePlayUrl: event.target.value })} placeholder="https://play.google.com/…" /></label>
              <label className="catalog-field storefront-banner-form-grid__wide">QR image URL<input type="url" value={draft.qrImageUrl} disabled={!canManage} onChange={(event) => updateDraft(slot, { qrImageUrl: event.target.value })} placeholder="Managed media URL or HTTPS image URL" /></label>
            </div>
          </FormSection>}
          <FormActions>
            <span className="storefront-banner-updated">Last updated {new Date(banner.updatedAt).toLocaleString()}</span>
            <div className="catalog-inline-actions">{canManage && <><button className="button button--quiet button--small" disabled={saving !== null || uploading !== null} type="button" onClick={() => void save(banner)}>{saving === banner.slot ? "Saving…" : "Save changes"}</button><button className="button button--dark button--small" disabled={saving !== null || uploading !== null} type="button" onClick={() => void publish(banner)}>{saving === banner.slot ? "Publishing…" : "Publish"}</button></>}</div>
          </FormActions>
        </article>;
      })}
    </div>
  </div>;
}