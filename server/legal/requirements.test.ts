import assert from "node:assert/strict";
import { assertLegalAcceptance, legalRequirements, type LegalRequirement } from "./requirements.js";

const documentKeys = [
  "terms-of-use",
  "consumer-terms-of-sale",
  "business-terms-of-sale",
  "shipping-delivery-policy",
  "returns-refunds-cancellation-policy",
  "privacy-policy",
  "cookie-policy",
  "company-contact-information",
  "account-data-deletion-information",
  "consumer-withdrawal-information",
  "warranty-legal-guarantee",
  "payment-information",
  "contact-complaints",
] as const;

const completeProfile = {
  tradingName: "Test trader",
  legalEntityName: "Test entity",
  legalStructure: "Test structure",
  countryOfEstablishment: "Cyprus",
  primaryOperatingRegion: "European Union",
  merchantSellerType: "Direct retailer",
  registeredAddress: "Test registered address",
  tradingAddress: "Test trading address",
  companyRegistrationNumber: "TEST-REG",
  vatNumber: "TEST-VAT",
  vatRegistrationCountry: "Cyprus",
  ossRegistrationStatus: "Test status",
  customerSupportEmail: "support@example.test",
  privacyRequestEmail: "privacy@example.test",
  customerSupportTelephone: "+35700000000",
  warehouseAddress: "Test warehouse",
  returnsAddress: "Test returns address",
  companyRegistryName: "Test registry",
  effectiveDate: "2026-01-01",
};

const rows: LegalRequirement[] = documentKeys.map((canonicalKey, index) => ({
  canonicalKey,
  publicRoute: `/${canonicalKey}`,
  title: canonicalKey,
  versionId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
}));

function queryable(profile: Record<string, string>, documents = rows, required = 13) {
  return {
    async query(sql: string) {
      if (sql.includes("FROM site_settings")) return { rows: [{ value: profile }] };
      if (sql.includes("count(*)")) return { rows: [{ count: String(required) }] };
      return { rows: documents };
    },
  };
}

async function run() {
  const incomplete = await legalRequirements(queryable({ ...completeProfile, legalEntityName: "" }));
  assert.equal(incomplete.active, false);
  assert.deepEqual(incomplete.b2c, []);

  const missingDocument = await legalRequirements(queryable(completeProfile, rows.slice(0, -1)));
  assert.equal(missingDocument.active, false);

  const active = await legalRequirements(queryable(completeProfile));
  assert.equal(active.active, true);
  assert.deepEqual(active.b2c.map((item) => item.canonicalKey), ["consumer-terms-of-sale", "privacy-policy"]);
  assert.deepEqual(active.b2b.map((item) => item.canonicalKey), ["business-terms-of-sale", "privacy-policy"]);
  assert.deepEqual(active.account.map((item) => item.canonicalKey), ["terms-of-use", "privacy-policy"]);

  assert.deepEqual(
    assertLegalAcceptance(active, "b2c", active.b2c.map((item) => item.versionId)),
    active.b2c,
  );
  for (const invalid of [
    undefined,
    [],
    [active.b2c[0].versionId],
    [active.b2c[0].versionId, active.b2c[0].versionId],
    active.b2b.map((item) => item.versionId),
    ["00000000-0000-4000-8000-999999999999", active.b2c[1].versionId],
  ]) {
    assert.throws(() => assertLegalAcceptance(active, "b2c", invalid), (error: any) => error?.code === "LEGAL_ACCEPTANCE_REQUIRED");
  }
  assert.deepEqual(assertLegalAcceptance(incomplete, "b2c", undefined), []);
  console.log("Legal requirements and exact-version acceptance checks passed.");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});