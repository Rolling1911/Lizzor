import { useEffect, useMemo, useRef, useState } from "react";
import { apiRequest } from "../../auth/api";
import { useAuth } from "../../auth/AuthContext";
import { AdminPageHeader, ErrorState, LoadingState, StatusBadge } from "../../components/admin/AdminPrimitives";

const labels: Record<string, string> = { tradingName: "Trading name", legalEntityName: "Legal entity name", legalStructure: "Legal structure", countryOfEstablishment: "Country of establishment", primaryOperatingRegion: "Primary operating region", merchantSellerType: "Merchant/seller type", registeredAddress: "Registered office", tradingAddress: "Trading/business address", companyRegistrationNumber: "Company registration number", vatNumber: "VAT number", vatRegistrationCountry: "VAT registration country", ossRegistrationStatus: "OSS registration status", customerSupportEmail: "Customer-support email", privacyRequestEmail: "Privacy-request email", customerSupportTelephone: "Customer-support telephone", warehouseAddress: "Warehouse address", returnsAddress: "Returns address", companyRegistryName: "Company registry name", productLiabilityInsurerReference: "Product-liability insurer/reference (optional)", effectiveDate: "Effective date" };
type ReadinessStatus = "Complete" | "Missing information" | "Needs legal review" | "Ready to publish" | "Published" | "Decision required";
type Filter = "all" | "published" | "draft" | "attention";
type WorkflowState = "complete" | "current" | "pending" | "blocked" | "optional";

function fieldComplete(profile: any, keys: string[]) { return keys.every((key) => Boolean(profile[key]?.trim?.() ?? profile[key])); }
function statusTone(status: ReadinessStatus): "positive" | "warning" | "neutral" {
  return status === "Complete" || status === "Published" ? "positive" : status === "Missing information" || status === "Needs legal review" ? "warning" : "neutral";
}
function audienceLabel(audience: string) {
  return audience === "b2c" ? "B2C" : audience === "b2b" ? "B2B" : "B2C / B2B";
}
function formatBytes(value?: number | null) {
  if (!value) return "";
  return value >= 1024 * 1024 ? `${(value / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(value / 1024)} KB`;
}
function currentVersion(document: any) {
  const versions = document.versions ?? [];
  return versions.find((version: any) => version.status === "draft") ?? versions.find((version: any) => version.id === document.currentPublishedVersionId) ?? versions[0];
}
function workflowStages(version: any): Array<{ key: string; label: string; state: WorkflowState; detail: string }> {
  const published = version.status === "published";
  const destinationsReady = version.websiteVisible || version.appVisible;
  const effectiveReady = Boolean(version.effectiveAt);
  const reviewReady = Boolean(version.contentReviewedAt && version.profileApplicabilityVerifiedAt);
  const readyToPublish = destinationsReady && effectiveReady && reviewReady;
  return [
    { key: "document", label: "Document", state: "complete", detail: `v${version.versionNumber}` },
    { key: "pdf", label: "PDF", state: published || version.pdfStorageKey ? "complete" : "optional", detail: version.pdfStorageKey ? "Attached" : "Optional" },
    { key: "visibility", label: "Visibility", state: published || destinationsReady ? "complete" : "current", detail: [version.websiteVisible && "Web", version.appVisible && "App"].filter(Boolean).join(" + ") || "None saved" },
    { key: "effective", label: "Effective date", state: published || effectiveReady ? "complete" : destinationsReady ? "current" : "pending", detail: effectiveReady ? new Date(version.effectiveAt).toLocaleDateString() : "Not set" },
    { key: "review", label: "Legal review", state: published || reviewReady ? "complete" : destinationsReady && effectiveReady ? "current" : "pending", detail: reviewReady ? "Confirmed" : "Required" },
    { key: "publish", label: "Publish", state: published ? "complete" : readyToPublish ? "current" : "blocked", detail: published ? "Published" : readyToPublish ? "Ready" : "Blocked" },
  ];
}

export function LegalReadinessPage() {
  const { permissions } = useAuth();
  const canManage = permissions.includes("legal.manage");
  const [data, setData] = useState<any>(null);
  const [profile, setProfile] = useState<any>({});
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  const [selectedKey, setSelectedKey] = useState("");
  const [preview, setPreview] = useState<any>(null);
  const [draft, setDraft] = useState({ key: "", title: "", content: "", effectiveAt: "", websiteVisible: true, appVisible: false });
  const [settings, setSettings] = useState({ effectiveAt: "", websiteVisible: true, appVisible: false });
  const fileInput = useRef<HTMLInputElement>(null);

  const load = async () => {
    try {
      const result = await apiRequest<{ data: any }>("/admin/legal");
      setData(result.data);
      setProfile(result.data.profile);
      setSelectedKey((current) => current || result.data.documents?.[0]?.canonicalKey || "");
      setError("");
    } catch (reason: any) {
      setError(reason.message);
    }
  };
  useEffect(() => { void load(); }, []);

  const selectedDocument = data?.documents?.find((document: any) => document.canonicalKey === selectedKey);
  const selectedVersion = selectedDocument ? currentVersion(selectedDocument) : null;
  useEffect(() => {
    if (!selectedVersion) return;
    setSettings({
      effectiveAt: selectedVersion.effectiveAt ? new Date(selectedVersion.effectiveAt).toISOString().slice(0, 10) : "",
      websiteVisible: selectedVersion.websiteVisible,
      appVisible: selectedVersion.appVisible,
    });
  }, [selectedVersion?.id, selectedVersion?.updatedAt]);

  const run = async (work: () => Promise<unknown>) => {
    setSaving(true);
    setError("");
    try {
      await work();
      await load();
    } catch (reason: any) {
      setError(reason.message);
    } finally {
      setSaving(false);
    }
  };
  const saveProfile = () => run(() => apiRequest("/admin/legal/profile", { method: "PUT", body: JSON.stringify(profile) }));
  const createDraft = () => run(async () => {
    const result = await apiRequest<{ data: any }>(`/admin/legal/documents/${draft.key}/drafts`, {
      method: "POST",
      body: JSON.stringify({
        title: draft.title,
        bodyJson: { blocks: draft.content.trim() ? [{ type: "paragraph", text: draft.content.trim() }] : [] },
        effectiveAt: draft.effectiveAt ? new Date(`${draft.effectiveAt}T00:00:00.000Z`).toISOString() : undefined,
        websiteVisible: draft.websiteVisible,
        appVisible: draft.appVisible,
      }),
    });
    setSelectedKey(draft.key);
    setPreview(result.data);
    setDraft({ key: "", title: "", content: "", effectiveAt: "", websiteVisible: true, appVisible: false });
  });
  const saveSettings = () => run(() => apiRequest(`/admin/legal/versions/${selectedVersion.id}/settings`, {
    method: "PATCH",
    body: JSON.stringify({
      effectiveAt: settings.effectiveAt ? new Date(`${settings.effectiveAt}T00:00:00.000Z`).toISOString() : null,
      websiteVisible: settings.websiteVisible,
      appVisible: settings.appVisible,
    }),
  }));
  const uploadPdf = (file?: File) => {
    if (!file || !selectedVersion) return;
    const body = new FormData();
    body.append("file", file);
    void run(() => apiRequest(`/admin/legal/versions/${selectedVersion.id}/pdf`, { method: "POST", body }));
  };
  const previewVersion = async (id: string) => {
    try {
      const result = await apiRequest<{ data: any }>(`/admin/legal/versions/${id}/preview`);
      setPreview(result.data);
    } catch (reason: any) {
      setError(reason.message);
    }
  };
  const confirmReadiness = (id: string) => run(() => apiRequest(`/admin/legal/versions/${id}/readiness`, { method: "PATCH", body: JSON.stringify({ contentReviewed: true, profileApplicabilityVerified: true }) }));
  const publish = (id: string) => run(() => apiRequest(`/admin/legal/versions/${id}/publish`, { method: "POST" }));

  const readinessCards = useMemo(() => {
    if (!data) return [];
    const profileStatus = (keys: string[]): ReadinessStatus => fieldComplete(data.profile, keys) ? "Complete" : "Missing information";
    const documents = data.documents ?? [];
    const drafts = documents.flatMap((document: any) => (document.versions ?? []).filter((version: any) => version.status === "draft"));
    const reviewStatus: ReadinessStatus = !documents.length ? "Missing information" : drafts.some((version: any) => !version.contentReviewedAt || !version.profileApplicabilityVerifiedAt) ? "Needs legal review" : "Complete";
    const publicationStatus: ReadinessStatus = data.readiness.legalNavigationSafe ? "Published" : drafts.some((version: any) => version.contentReviewedAt && version.profileApplicabilityVerifiedAt) ? "Ready to publish" : "Missing information";
    return [
      ["Seller identity", profileStatus(["tradingName", "legalEntityName", "legalStructure", "merchantSellerType"])],
      ["Company registration", profileStatus(["companyRegistrationNumber", "companyRegistryName"])],
      ["VAT / OSS", profileStatus(["vatNumber", "vatRegistrationCountry", "ossRegistrationStatus"])],
      ["Business addresses", profileStatus(["registeredAddress", "tradingAddress", "warehouseAddress", "returnsAddress"])],
      ["Contact information", profileStatus(["customerSupportEmail", "privacyRequestEmail", "customerSupportTelephone"])],
      ["Operational policies", "Decision required" as ReadinessStatus],
      ["Legal document review", reviewStatus],
      ["Publication status", publicationStatus],
    ].map(([label, status]) => ({ label: label as string, status: status as ReadinessStatus }));
  }, [data]);

  const blockers = useMemo(() => data ? [...(data.profileStatus.missing ?? []).map((key: string) => `Missing profile field: ${labels[key]}`), ...(data.readiness.missingDocuments ?? []).map((key: string) => `No published version: ${key}`), ...(data.readiness.missingDates ?? []).map((key: string) => `Missing effective date: ${key}`)] : [], [data]);
  const documentStats = useMemo(() => {
    const documents = data?.documents ?? [];
    return {
      total: documents.length,
      published: documents.filter((document: any) => Boolean(document.currentPublishedVersionId)).length,
      drafts: documents.filter((document: any) => (document.versions ?? []).some((version: any) => version.status === "draft")).length,
      pdfsUploaded: documents.filter((document: any) => Boolean(currentVersion(document)?.pdfStorageKey)).length,
      awaitingReview: data?.readiness?.awaitingReview?.length ?? 0,
    };
  }, [data]);
  const visibleDocuments = useMemo(() => (data?.documents ?? []).filter((document: any) => {
    const version = currentVersion(document);
    if (filter === "published") return Boolean(document.currentPublishedVersionId);
    if (filter === "draft") return version?.status === "draft";
    if (filter === "attention") return !version?.effectiveAt || (version.status === "draft" && (!version.contentReviewedAt || !version.profileApplicabilityVerifiedAt)) || (!version.websiteVisible && !version.appVisible);
    return true;
  }), [data, filter]);

  if (!data && !error) return <LoadingState />;
  return <div className="admin-page legal-workspace">
    <AdminPageHeader eyebrow="Administration / Controls" title="Legal & Compliance" description="Manage seller information, readable legal content, official PDFs and controlled publication. Operational readiness only, not legal advice." />
    {error && <ErrorState description={error} onRetry={load} />}
    {data && <>
      <section className="legal-summary" aria-label="Commercial launch status">
        <div><span className="eyebrow">Commercial launch gate</span><h2>{data.readiness.legalNavigationSafe ? "Ready for commercial launch" : "Not ready for commercial launch"}</h2><p>{data.readiness.legalNavigationSafe ? "All currently exposed legal navigation is backed by published content." : "Public legal navigation and incomplete seller controls remain blocked until the blockers are resolved."}</p></div>
        <StatusBadge status={data.readiness.legalNavigationSafe ? "Ready" : "Blocked"} tone={data.readiness.legalNavigationSafe ? "positive" : "warning"} />
      </section>
      <section className="legal-readiness-grid" aria-labelledby="readiness-heading">
        <div className="legal-section-heading"><div><span className="eyebrow">Readiness overview</span><h2 id="readiness-heading">Eight launch control areas</h2></div><span className="legal-section-note">Calculated from the current legal API record</span></div>
        {readinessCards.map((card, index) => <article className="legal-readiness-card" key={card.label}><div className="legal-readiness-card__top"><span className="legal-readiness-card__index">{String(index + 1).padStart(2, "0")}</span><StatusBadge status={card.status} tone={statusTone(card.status)} /></div><h3>{card.label}</h3><p>{card.status === "Decision required" ? "No policy decision is represented by the current API." : card.status === "Published" ? "Current published controls are active." : card.status === "Ready to publish" ? "A reviewed version can be submitted for guarded publication." : card.status === "Needs legal review" ? "Draft content or applicability confirmation is still outstanding." : card.status === "Complete" ? "Required information is present." : "Required information or a published version is missing."}</p></article>)}
      </section>
      {blockers.length > 0 && <section className="legal-blockers admin-panel"><div className="admin-panel__heading"><div><h2>Launch blockers</h2><p>These blockers are calculated from the current API response.</p></div><span className="legal-count">{blockers.length}</span></div><ul>{blockers.map((blocker) => <li key={blocker}>{blocker}</li>)}</ul></section>}

      <section className="admin-panel"><div className="admin-panel__heading"><div><span className="eyebrow">Seller record</span><h2>Business legal profile</h2><p>Incomplete legal details are never public.</p></div><StatusBadge status={data.profileStatus.complete ? "Complete" : "Missing information"} tone={data.profileStatus.complete ? "positive" : "warning"} /></div>
        <div className="admin-form-grid">{Object.keys(labels).map((key) => <label key={key}>{labels[key]}<input value={profile[key] ?? ""} onChange={(event) => setProfile({ ...profile, [key]: event.target.value })} /></label>)}</div>
        {canManage && <div className="admin-form-actions"><button className="button button--dark" disabled={saving} onClick={saveProfile}>{saving ? "Saving…" : "Save legal profile"}</button></div>}
      </section>

      <section className="admin-panel legal-documents-panel">
        <div className="admin-panel__heading"><div><span className="eyebrow">Document manager</span><h2>Legal documents</h2><p>Readable content and official PDFs are versioned together. Uploading never publishes a document.</p></div><StatusBadge status={data.readiness.legalNavigationSafe ? "Website ready" : "Publication controlled"} tone={data.readiness.legalNavigationSafe ? "positive" : "neutral"} /></div>
        <div className="legal-manager-summary" aria-label="Document summary">
          {[["Total documents", documentStats.total], ["Published", documentStats.published], ["Drafts", documentStats.drafts], ["PDFs uploaded", `${documentStats.pdfsUploaded} / ${documentStats.total}`], ["Awaiting review", documentStats.awaitingReview]].map(([label, value]) => <article key={label}><strong>{value}</strong><span>{label}</span></article>)}
        </div>
        <div className="legal-filter-bar" role="group" aria-label="Filter legal documents">
          {(["all", "published", "draft", "attention"] as Filter[]).map((item) => <button key={item} className={filter === item ? "is-active" : ""} onClick={() => setFilter(item)}>{item === "attention" ? "Needs attention" : item[0].toUpperCase() + item.slice(1)}</button>)}
        </div>
        <div className="legal-manager">
          <div className="legal-manager-list">
            {visibleDocuments.map((document: any) => {
              const version = currentVersion(document);
              const warnings = [!version?.effectiveAt && "Missing effective date", version?.status === "draft" && (!version.contentReviewedAt || !version.profileApplicabilityVerifiedAt) && "Needs legal review", version && !version.websiteVisible && !version.appVisible && "Not publicly visible"].filter(Boolean);
              return <button key={document.id} className={`legal-manager-row ${selectedKey === document.canonicalKey ? "is-selected" : ""}`} onClick={() => { setSelectedKey(document.canonicalKey); setPreview(null); }}>
                <span className="legal-manager-row__title"><strong>{document.title}</strong><small>{audienceLabel(document.audience)}</small></span>
                <span><strong>{version ? `v${version.versionNumber}` : "—"}</strong><small>{version?.status ?? "No version"}</small></span>
                <span className={`legal-pdf-status ${version?.pdfStorageKey ? "is-attached" : ""}`}><strong>{version?.pdfStorageKey ? "PDF attached" : "No PDF"}</strong><small>{version?.pdfSizeBytes ? formatBytes(version.pdfSizeBytes) : "Optional"}</small></span>
                <span className="legal-manager-row__warnings">{warnings.length ? warnings.slice(0, 2).map((warning) => <em key={String(warning)}>{warning}</em>) : <em className="is-clear">Ready</em>}</span>
              </button>;
            })}
          </div>
          {selectedDocument && <aside className="legal-manager-detail">
            <div className="legal-manager-detail__heading"><div><span className="eyebrow">{audienceLabel(selectedDocument.audience)} · {selectedDocument.publicRoute}</span><h3>{selectedDocument.title}</h3></div>{selectedVersion && <StatusBadge status={selectedVersion.status} tone={selectedVersion.status === "published" ? "positive" : "neutral"} />}</div>
            {selectedVersion ? <>
              <ol className="legal-workflow-path" aria-label="Legal document workflow">
                {workflowStages(selectedVersion).map((stage, index) => <li key={stage.key} className={`is-${stage.state}`} aria-current={stage.state === "current" ? "step" : undefined}>
                  <span className="legal-workflow-path__checkpoint" aria-hidden="true">{stage.state === "complete" ? "✓" : index + 1}</span>
                  <strong>{stage.label}</strong>
                  <small>{stage.detail}</small>
                </li>)}
              </ol>
              <dl className="legal-version-facts">
                <div><dt>Version</dt><dd>v{selectedVersion.versionNumber}</dd></div><div><dt>Last updated</dt><dd>{new Date(selectedVersion.updatedAt).toLocaleDateString()}</dd></div>
              </dl>
              <div className="legal-workflow-section">
                <div className="legal-workflow-section__heading"><div><span className="legal-workflow-section__number">01</span><h4>Official PDF</h4></div><span className={`legal-workflow-status ${selectedVersion.pdfStorageKey ? "is-positive" : ""}`}>{selectedVersion.pdfStorageKey ? "PDF attached" : "No PDF · optional"}</span></div>
                {selectedVersion.pdfStorageKey && <p>{selectedVersion.pdfOriginalFilename} · {formatBytes(selectedVersion.pdfSizeBytes)}</p>}
                <div className="legal-manager-actions">
                  {canManage && selectedVersion.status === "draft" && <button className="button button--quiet button--small" onClick={() => fileInput.current?.click()}>{selectedVersion.pdfStorageKey ? "Replace PDF" : "Upload PDF"}</button>}
                  {selectedVersion.pdfStorageKey && <a className="button button--quiet button--small" href={`/api/v1/admin/legal/versions/${selectedVersion.id}/pdf`} target="_blank" rel="noreferrer">View</a>}
                  {selectedVersion.pdfStorageKey && <a className="button button--quiet button--small" href={`/api/v1/admin/legal/versions/${selectedVersion.id}/pdf?download=1`}>Download</a>}
                  <button className="button button--quiet button--small" onClick={() => previewVersion(selectedVersion.id)}>Preview content</button>
                  <input ref={fileInput} hidden type="file" accept="application/pdf,.pdf" onChange={(event) => { uploadPdf(event.target.files?.[0]); event.currentTarget.value = ""; }} />
                </div>
              </div>
              <div className="legal-workflow-section">
                <div className="legal-workflow-section__heading"><div><span className="legal-workflow-section__number">02</span><h4>Destinations</h4></div><span className={`legal-workflow-status ${selectedVersion.websiteVisible || selectedVersion.appVisible ? "is-positive" : "is-attention"}`}>{[selectedVersion.websiteVisible && "Website", selectedVersion.appVisible && "Mobile App"].filter(Boolean).join(" + ") || "Not publicly visible"}</span></div>
                {canManage && selectedVersion.status === "draft" ? <div className="legal-destination-options"><label><input type="checkbox" checked={settings.websiteVisible} onChange={(event) => setSettings({ ...settings, websiteVisible: event.target.checked })} />Website</label><label><input type="checkbox" checked={settings.appVisible} onChange={(event) => setSettings({ ...settings, appVisible: event.target.checked })} />Mobile App</label></div> : <p>Website: {selectedVersion.websiteVisible ? "Enabled" : "Disabled"} · Mobile App: {selectedVersion.appVisible ? "Enabled" : "Disabled"}</p>}
              </div>
              <div className="legal-workflow-section">
                <div className="legal-workflow-section__heading"><div><span className="legal-workflow-section__number">03</span><h4>Effective date</h4></div><span className={`legal-workflow-status ${selectedVersion.effectiveAt ? "is-positive" : "is-attention"}`}>{selectedVersion.effectiveAt ? new Date(selectedVersion.effectiveAt).toLocaleDateString() : "Not set"}</span></div>
                {canManage && selectedVersion.status === "draft" && <><label className="legal-effective-date">Effective date<input type="date" value={settings.effectiveAt} onChange={(event) => setSettings({ ...settings, effectiveAt: event.target.value })} /></label><button className="button button--quiet button--small" disabled={saving} onClick={saveSettings}>Save visibility &amp; date</button></>}
              </div>
              <div className="legal-workflow-section">
                <div className="legal-workflow-section__heading"><div><span className="legal-workflow-section__number">04</span><h4>Legal review</h4></div><span className={`legal-workflow-status ${selectedVersion.contentReviewedAt && selectedVersion.profileApplicabilityVerifiedAt ? "is-positive" : "is-attention"}`}>{selectedVersion.contentReviewedAt && selectedVersion.profileApplicabilityVerifiedAt ? "Confirmed" : "Required"}</span></div>
                <p>{selectedVersion.contentReviewedAt && selectedVersion.profileApplicabilityVerifiedAt ? "Confirmed for this exact version." : "Content and profile applicability must be confirmed before publication."}</p>
                {canManage && selectedVersion.status === "draft" && (!selectedVersion.contentReviewedAt || !selectedVersion.profileApplicabilityVerifiedAt) && <button className="button button--quiet button--small" disabled={saving} onClick={() => confirmReadiness(selectedVersion.id)}>Confirm legal review</button>}
              </div>
              <div className="legal-workflow-section legal-workflow-section--publish">
                <div className="legal-workflow-section__heading"><div><span className="legal-workflow-section__number">05</span><h4>Publish</h4></div><span className={`legal-workflow-status ${selectedVersion.status === "published" ? "is-positive" : ""}`}>{selectedVersion.status === "published" ? "Published" : "Server guarded"}</span></div>
                <p>{selectedVersion.status === "published" ? "This version and its PDF are immutable." : "The server validates all publication requirements before making this version available."}</p>
                {canManage && selectedVersion.status === "draft" && <button className="button button--dark button--small" disabled={saving || !selectedVersion.contentReviewedAt || !selectedVersion.profileApplicabilityVerifiedAt} onClick={() => publish(selectedVersion.id)}>Publish version</button>}
              </div>
              <details className="legal-history"><summary>Version history ({selectedDocument.versions?.length ?? 0})</summary><div>{(selectedDocument.versions ?? []).map((version: any) => <button key={version.id} onClick={() => previewVersion(version.id)}><span>v{version.versionNumber} · {version.status}</span><small>{new Date(version.updatedAt).toLocaleDateString()} · {version.pdfStorageKey ? "PDF attached" : "No PDF"}</small></button>)}</div></details>
            </> : <p>No version exists for this canonical document.</p>}
          </aside>}
        </div>
        {canManage && <details className="legal-new-version"><summary>Create new draft version</summary><div className="legal-new-version__body"><p>Use a new draft for every change to a published document. Readable content is optional when an approved PDF will be attached.</p><div className="admin-form-grid"><label>Document<select value={draft.key} onChange={(event) => setDraft({ ...draft, key: event.target.value, title: data.documents.find((item: any) => item.canonicalKey === event.target.value)?.title ?? "" })}><option value="">Choose document</option>{data.documents.map((item: any) => <option key={item.canonicalKey} value={item.canonicalKey}>{item.title}</option>)}</select></label><label>Version title<input value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} /></label><label>Effective date<input type="date" value={draft.effectiveAt} onChange={(event) => setDraft({ ...draft, effectiveAt: event.target.value })} /></label><label className="admin-form-grid__wide">Web-readable content<textarea rows={6} value={draft.content} onChange={(event) => setDraft({ ...draft, content: event.target.value })} placeholder="Enter approved readable content, or leave blank when the official PDF will be the only content." /></label></div><div className="legal-destination-options"><label><input type="checkbox" checked={draft.websiteVisible} onChange={(event) => setDraft({ ...draft, websiteVisible: event.target.checked })} />Website</label><label><input type="checkbox" checked={draft.appVisible} onChange={(event) => setDraft({ ...draft, appVisible: event.target.checked })} />Mobile App</label></div><div className="admin-form-actions"><button className="button button--dark" disabled={saving || !draft.key || !draft.title} onClick={createDraft}>{saving ? "Creating…" : "Create draft version"}</button></div></div></details>}
        {preview && <div className="content-preview legal-content-preview" aria-live="polite"><div className="legal-content-preview__heading"><div><span className="eyebrow">Authorised preview · v{preview.versionNumber} · {preview.language}</span><h2>{preview.title}</h2></div><button className="button button--quiet button--small" onClick={() => setPreview(null)}>Close</button></div>{preview.bodyJson.blocks.length ? preview.bodyJson.blocks.map((item: any, index: number) => item.type === "heading" ? <h3 key={index}>{item.text}</h3> : item.type === "list" ? <ul key={index}>{item.text.split("\n").filter(Boolean).map((entry: string) => <li key={entry}>{entry.replace(/^[-•]\s*/, "")}</li>)}</ul> : <p key={index}>{item.text}</p>) : <p>No web-readable content is attached to this version.</p>}{preview.pdfStorageKey && <p><a className="text-link" href={`/api/v1/admin/legal/versions/${preview.id}/pdf`} target="_blank" rel="noreferrer">Open official PDF</a></p>}</div>}
      </section>
    </>}
  </div>;
}