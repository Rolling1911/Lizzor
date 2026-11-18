import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { apiRequest } from "../../auth/api";

export type LegalScope = "b2c" | "b2b" | "account";
type Requirement = { title: string; publicRoute: string; versionId: string };
type Requirements = { active: boolean; b2c: Requirement[]; b2b: Requirement[]; account: Requirement[] };
export function LegalAcceptance({ scope, value, onChange }: { scope: LegalScope; value: string[]; onChange: (value: string[]) => void }) {
  const [requirements, setRequirements] = useState<Requirements | null>(null);
  const previousScope = useRef(scope);
  useEffect(() => { apiRequest<{ data: Requirements }>("/legal-requirements").then((result) => setRequirements(result.data)).catch(() => setRequirements({ active: false, b2c: [], b2b: [], account: [] })); }, []);
  const documents = requirements?.[scope] ?? [];
  useEffect(() => { if (!requirements?.active) onChange([]); }, [requirements?.active]);
  useEffect(() => { if (previousScope.current !== scope) { previousScope.current = scope; onChange([]); } }, [scope, onChange]);
  if (!requirements?.active || !documents.length) return null;
  const checked = value.length === documents.length && documents.every((document) => value.includes(document.versionId));
  return <label className="check-line"><input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked ? documents.map((document) => document.versionId) : [])} />
    <span>I agree to the applicable {documents.filter((document) => !/privacy/i.test(document.title)).map((document, index) => <span key={document.versionId}>{index > 0 && ", "}<Link to={document.publicRoute} target="_blank" rel="noopener noreferrer">{document.title}</Link></span>)} and acknowledge the <Link to={documents.find((document) => /privacy/i.test(document.title))?.publicRoute ?? "/privacy"} target="_blank" rel="noopener noreferrer">Privacy Policy</Link>.</span>
  </label>;
}