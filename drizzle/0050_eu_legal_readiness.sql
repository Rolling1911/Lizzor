-- Additive EU legal readiness extensions. No version is published by this migration.
ALTER TABLE "legal_documents" ADD COLUMN IF NOT EXISTS "required_for_commercial_launch" boolean NOT NULL DEFAULT true;
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "purchase_legal_scope" varchar(16);
--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_purchase_legal_scope_valid" CHECK ("purchase_legal_scope" IS NULL OR "purchase_legal_scope" IN ('b2c','b2b'));
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "legal_document_aliases" (
  "alias_route" varchar(180) PRIMARY KEY,
  "document_id" uuid NOT NULL REFERENCES "legal_documents"("id") ON DELETE CASCADE,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "legal_policy_acceptances" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "version_id" uuid NOT NULL REFERENCES "legal_document_versions"("id") ON DELETE RESTRICT,
  "user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "order_id" uuid REFERENCES "orders"("id") ON DELETE SET NULL,
  "company_id" uuid REFERENCES "companies"("id") ON DELETE SET NULL,
  "source" varchar(32) NOT NULL,
  "scope" varchar(16) NOT NULL,
  "accepted_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "legal_policy_acceptances_source_valid" CHECK ("source" IN ('registration','checkout')),
  CONSTRAINT "legal_policy_acceptances_scope_valid" CHECK ("scope" IN ('b2c','b2b','account')),
  CONSTRAINT "legal_policy_acceptances_subject_valid" CHECK ("user_id" IS NOT NULL OR "order_id" IS NOT NULL OR "company_id" IS NOT NULL),
  CONSTRAINT "legal_policy_acceptances_source_subject_valid" CHECK (
    ("source"='registration' AND "user_id" IS NOT NULL AND "order_id" IS NULL)
    OR ("source"='checkout' AND "order_id" IS NOT NULL)
  ),
  CONSTRAINT "legal_policy_acceptances_scope_subject_valid" CHECK (
    ("scope"='b2b' AND "company_id" IS NOT NULL) OR ("scope"='account' AND "user_id" IS NOT NULL) OR "scope"='b2c'
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "legal_policy_acceptances_exact_evidence_unique"
  ON "legal_policy_acceptances" ("version_id","user_id","order_id","company_id","source","scope")
  NULLS NOT DISTINCT;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "legal_policy_acceptances_order_idx" ON "legal_policy_acceptances" ("order_id","accepted_at");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION prevent_legal_policy_acceptance_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'legal policy acceptance evidence is immutable'; END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "legal_policy_acceptances_immutable" ON "legal_policy_acceptances";
CREATE TRIGGER "legal_policy_acceptances_immutable" BEFORE UPDATE OR DELETE ON "legal_policy_acceptances"
  FOR EACH ROW EXECUTE FUNCTION prevent_legal_policy_acceptance_mutation();
--> statement-breakpoint
INSERT INTO "legal_documents" ("canonical_key","public_route","title") VALUES
  ('warranty-legal-guarantee','/warranty','Warranty and Legal Guarantee'),
  ('payment-information','/payment-information','Payment Information'),
  ('contact-complaints','/contact','Contact and Complaints')
ON CONFLICT ("canonical_key") DO NOTHING;
--> statement-breakpoint
INSERT INTO "legal_document_aliases" ("alias_route","document_id")
SELECT a.alias_route,d.id FROM (VALUES
  ('/returns','returns-refunds-cancellation-policy'),
  ('/shipping','shipping-delivery-policy'),
  ('/consumer-rights','consumer-withdrawal-information')
) AS a(alias_route,canonical_key) JOIN "legal_documents" d ON d.canonical_key=a.canonical_key
ON CONFLICT ("alias_route") DO UPDATE SET document_id=EXCLUDED.document_id;
--> statement-breakpoint
-- Private, intentionally unpublished drafting placeholders. They make the review queue explicit
-- without representing legal advice or public terms.
INSERT INTO "legal_document_versions" ("document_id","version_number","language","title","body_json","status")
SELECT d.id,COALESCE((SELECT max(v.version_number)+1 FROM "legal_document_versions" v WHERE v.document_id=d.id AND v.language='en'),1),'en',
  'LAWYER-REVIEW-REQUIRED — ' || d.title,
  jsonb_build_object('blocks',jsonb_build_array(
    jsonb_build_object('type','heading','text','Draft for Cyprus and European Union legal review'),
    jsonb_build_object('type','paragraph','text','This internal draft is not published and must not be used as legal advice or customer-facing terms until the seller identity, operational rules and legal review are complete. Lizzor is intended to act as a direct retailer established in Cyprus serving customers in the European Union.'),
    jsonb_build_object('type','heading','text','Operational facts to verify before publication'),
    jsonb_build_object('type','paragraph','text','The application processes account, company membership, order, delivery-address, support and chat information; uses Stripe for payments, Resend for transactional email, and Replit hosting, database and storage. It also maintains security and audit records and device or IP information where generated by the service. No analytics, Meta or TikTok tracker is represented by this draft.'),
    jsonb_build_object('type','heading','text','Document-specific review scope'),
    jsonb_build_object('type','paragraph','text',CASE d.canonical_key
      WHEN 'consumer-terms-of-sale' THEN 'Review the consumer order journey, formation of contract, price and VAT disclosures, Stripe authorisation, delivery, cancellation, withdrawal, refund, non-conformity, complaints, jurisdiction and statutory consumer protections. Do not waive consumer rights.'
      WHEN 'business-terms-of-sale' THEN 'Review business representative authority, company orders, pricing and VAT, invoicing, inspection, delivery, title and risk, returns, liability, confidentiality, force majeure and business jurisdiction separately from consumer rights.'
      WHEN 'consumer-withdrawal-information' THEN 'Review the EU distance-contract withdrawal notice, when the period begins, eligible exceptions, communications route, return and refund handling, and the model form. The form may be copied or printed and is not the exclusive method of withdrawal.'
      WHEN 'returns-refunds-cancellation-policy' THEN 'Separate statutory withdrawal and non-conformity remedies from any future voluntary commercial returns programme. Confirm return conditions, authorisation, shipping costs, Stripe refund handling and any configured period before making statements.'
      WHEN 'shipping-delivery-policy' THEN 'Review Cyprus fulfilment origin, EU delivery availability, live shipping calculation, tracking, split shipments, address errors, delays, loss, damage and any future non-EU customs treatment. Do not promise delivery times.'
      WHEN 'privacy-policy' THEN 'Review GDPR roles, purposes, lawful bases, rights handling, security, processors, transfers and retention based on documented operations. Do not identify a DPO or retention period unless actually established.'
      WHEN 'cookie-policy' THEN 'Review essential browser storage and the consent choice for future analytics and marketing technologies. No analytics, advertising tracker or fictional cookie inventory is asserted.'
      WHEN 'warranty-legal-guarantee' THEN 'Review statutory remedies for non-conforming goods and clearly distinguish them from optional manufacturer and Lizzor commercial warranties. Do not state durations or commitments that have not been supplied.'
      WHEN 'payment-information' THEN 'Review Stripe Payment Element processing, payment authorisation and authentication, failures, refunds, currency and pricing disclosures. Do not state that raw card data is stored by Lizzor.'
      WHEN 'contact-complaints' THEN 'Review support, order complaint, returns and privacy request processes once verified contact and seller details exist. Do not invent an address, phone number or complaint body.'
      WHEN 'terms-of-use' THEN 'Review acceptable use, account security, intellectual property, service availability, prohibited misuse, changes and applicable law without conflating site use with consumer sales terms.'
      WHEN 'company-contact-information' THEN 'Insert only verified seller identity, registry, VAT, registered and trading address, returns address and support/privacy contact details after formation.'
      WHEN 'account-data-deletion-information' THEN 'Review account closure and data-rights request routes, identity verification, order/legal record dependencies and retention requirements without promising deletion outcomes or periods.'
      ELSE 'Counsel and an authorised administrator must confirm the seller identity and contact details, applicable VAT and consumer-law wording, delivery and returns operations, statutory notices and any product-specific obligations.'
    END),
    jsonb_build_object('type','heading','text','Publication block'),
    jsonb_build_object('type','paragraph','text','Unresolved seller configuration and qualified legal review are required before publication. No delivery promise, voluntary return period, warranty period, retention period or seller contact detail is asserted here.')
  )),'draft'
FROM "legal_documents" d
WHERE d.canonical_key IN ('privacy-policy','consumer-terms-of-sale','business-terms-of-sale','shipping-delivery-policy','returns-refunds-cancellation-policy','cookie-policy','consumer-withdrawal-information','warranty-legal-guarantee','payment-information','contact-complaints')
  AND NOT EXISTS (SELECT 1 FROM "legal_document_versions" v WHERE v.document_id=d.id AND v.language='en');