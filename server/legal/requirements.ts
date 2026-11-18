import { AppError } from "../middleware/error-handler.js";
import { getDatabasePool } from "../db/client.js";

type Queryable = { query: (text: string, values?: unknown[]) => Promise<{ rows: any[] }> };
export type LegalScope = "b2c" | "b2b" | "account";
export type LegalRequirement = { canonicalKey: string; publicRoute: string; versionId: string; title: string };
export type LegalRequirements = { active: boolean; b2c: LegalRequirement[]; b2b: LegalRequirement[]; account: LegalRequirement[] };
const profileFields = ["tradingName", "legalEntityName", "legalStructure", "countryOfEstablishment", "primaryOperatingRegion", "merchantSellerType", "registeredAddress", "tradingAddress", "companyRegistrationNumber", "vatNumber", "vatRegistrationCountry", "ossRegistrationStatus", "customerSupportEmail", "privacyRequestEmail", "customerSupportTelephone", "warehouseAddress", "returnsAddress", "companyRegistryName", "effectiveDate"];

export async function legalRequirements(queryable: Queryable = getDatabasePool()): Promise<LegalRequirements> {
  const profile = (await queryable.query("SELECT value_json AS value FROM site_settings WHERE key='businessLegalProfile'")).rows[0]?.value ?? {};
  const profileReady = profileFields.every((field) => typeof profile[field] === "string" && profile[field].trim());
  const rows = (await queryable.query(`SELECT d.canonical_key AS "canonicalKey",d.public_route AS "publicRoute",d.title,p.version_id AS "versionId"
    FROM legal_documents d JOIN legal_document_publications p ON p.document_id=d.id AND p.language='en'
    JOIN legal_document_versions v ON v.id=p.version_id
    WHERE v.status='published' AND v.effective_at<=now() AND v.website_visible=true`)).rows as LegalRequirement[];
  const byKey = new Map(rows.map((row) => [row.canonicalKey, row]));
  const required = Number((await queryable.query("SELECT count(*) AS count FROM legal_documents WHERE required_for_commercial_launch=true")).rows[0].count);
  const pick = (...keys: string[]) => keys.map((key) => byKey.get(key)).filter((item): item is LegalRequirement => Boolean(item));
  const b2c = pick("consumer-terms-of-sale", "privacy-policy");
  const b2b = pick("business-terms-of-sale", "privacy-policy");
  const account = pick("terms-of-use", "privacy-policy");
  const active = profileReady && rows.length >= required && b2c.length === 2 && b2b.length === 2 && account.length === 2;
  return { active, b2c: active ? b2c : [], b2b: active ? b2b : [], account: active ? account : [] };
}

export function assertLegalAcceptance(requirements: LegalRequirements, scope: LegalScope, accepted: unknown): LegalRequirement[] {
  const required = requirements[scope];
  if (!requirements.active) return [];
  const ids = Array.isArray(accepted) ? accepted.filter((value): value is string => typeof value === "string") : [];
  if (ids.length !== required.length || new Set(ids).size !== ids.length || !required.every((item) => ids.includes(item.versionId))) {
    throw new AppError(409, "LEGAL_ACCEPTANCE_REQUIRED", "Please acknowledge the current applicable Terms and Privacy Policy before continuing.");
  }
  return required;
}