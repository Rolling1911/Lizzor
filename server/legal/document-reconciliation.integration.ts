import assert from "node:assert/strict";
import { getDatabasePool } from "../db/client.js";
import { reconcileLegalDocumentCatalog } from "./document-reconciliation.js";

const expectedKeys = [
  "privacy-policy",
  "terms-of-use",
  "consumer-terms-of-sale",
  "business-terms-of-sale",
  "shipping-delivery-policy",
  "returns-refunds-cancellation-policy",
  "cookie-policy",
  "company-contact-information",
  "account-data-deletion-information",
  "consumer-withdrawal-information",
  "warranty-legal-guarantee",
  "payment-information",
  "contact-complaints",
];

const client = await getDatabasePool().connect();
try {
  await client.query("BEGIN");
  await client.query(`CREATE TEMP TABLE legal_documents (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    canonical_key varchar(80) NOT NULL UNIQUE,
    public_route varchar(180) NOT NULL UNIQUE,
    title varchar(250) NOT NULL,
    audience varchar(8) NOT NULL DEFAULT 'both',
    language varchar(12) NOT NULL DEFAULT 'en',
    current_published_version_id uuid,
    required_for_commercial_launch boolean NOT NULL DEFAULT true
  ) ON COMMIT DROP`);
  await client.query(`CREATE TEMP TABLE legal_document_versions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id uuid NOT NULL REFERENCES legal_documents(id) ON DELETE CASCADE,
    version_number integer NOT NULL,
    language varchar(12) NOT NULL DEFAULT 'en',
    title varchar(250) NOT NULL,
    body_json jsonb NOT NULL,
    status varchar(16) NOT NULL DEFAULT 'draft',
    effective_at timestamptz,
    published_at timestamptz,
    content_reviewed_at timestamptz,
    profile_applicability_verified_at timestamptz,
    UNIQUE(document_id,language,version_number)
  ) ON COMMIT DROP`);
  await client.query(`CREATE TEMP TABLE legal_document_aliases (
    alias_route varchar(180) PRIMARY KEY,
    document_id uuid NOT NULL REFERENCES legal_documents(id) ON DELETE CASCADE
  ) ON COMMIT DROP`);
  await client.query(`CREATE TEMP TABLE legal_document_publications (
    document_id uuid NOT NULL REFERENCES legal_documents(id) ON DELETE CASCADE,
    language varchar(12) NOT NULL,
    version_id uuid NOT NULL REFERENCES legal_document_versions(id) ON DELETE RESTRICT,
    PRIMARY KEY(document_id,language)
  ) ON COMMIT DROP`);

  const first = await reconcileLegalDocumentCatalog(client);
  assert.equal(first.documentsAdded, 13);
  assert.equal(first.draftsAdded, 13);
  assert.equal(first.aliasesReconciled, 3);

  const rows = (await client.query(
    `SELECT d.canonical_key,d.audience,v.version_number,v.status,v.effective_at,v.published_at,
            v.content_reviewed_at,v.profile_applicability_verified_at,v.title,
            jsonb_array_length(v.body_json->'blocks') AS block_count
       FROM legal_documents d
       JOIN legal_document_versions v ON v.document_id=d.id AND v.language='en'
      ORDER BY d.canonical_key`,
  )).rows;
  assert.deepEqual(rows.map((row) => row.canonical_key), [...expectedKeys].sort());
  assert.equal(rows.find((row) => row.canonical_key === "consumer-terms-of-sale")?.audience, "b2c");
  assert.equal(rows.find((row) => row.canonical_key === "business-terms-of-sale")?.audience, "b2b");
  assert.ok(rows.every((row) => row.version_number === 1));
  assert.ok(rows.every((row) => row.status === "draft"));
  assert.ok(rows.every((row) => row.effective_at === null && row.published_at === null));
  assert.ok(rows.every((row) => row.content_reviewed_at === null && row.profile_applicability_verified_at === null));
  assert.ok(rows.every((row) => row.title.startsWith("LAWYER-REVIEW-REQUIRED — ")));
  assert.ok(rows.every((row) => Number(row.block_count) >= 5), "every restored draft remains comprehensive");
  assert.equal(Number((await client.query("SELECT count(*) AS count FROM legal_document_publications")).rows[0]?.count ?? 0), 0);

  const second = await reconcileLegalDocumentCatalog(client);
  assert.equal(second.documentsAdded, 0);
  assert.equal(second.draftsAdded, 0);
  assert.equal(second.aliasesReconciled, 0);
  assert.equal(Number((await client.query("SELECT count(*) AS count FROM legal_document_versions")).rows[0].count), 13);

  await client.query("ROLLBACK");
  console.log("Legal document catalog reconciliation passed.");
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  client.release();
}