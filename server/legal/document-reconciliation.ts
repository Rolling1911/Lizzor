import type { PoolClient } from "pg";
import { getDatabasePool } from "../db/client.js";

export interface LegalDocumentReconciliationResult {
  documentsAdded: number;
  draftsAdded: number;
  aliasesReconciled: number;
}

const canonicalDocuments = [
  ["privacy-policy", "/privacy", "Privacy Policy", "both"],
  ["terms-of-use", "/terms", "Terms of Use", "both"],
  ["consumer-terms-of-sale", "/terms-of-sale", "Consumer Terms of Sale", "b2c"],
  ["business-terms-of-sale", "/business-terms", "Business Terms of Sale", "b2b"],
  ["shipping-delivery-policy", "/shipping-delivery", "Shipping and Delivery Policy", "both"],
  ["returns-refunds-cancellation-policy", "/returns-refunds", "Returns, Refunds and Cancellation Policy", "both"],
  ["cookie-policy", "/cookies", "Cookie Policy", "both"],
  ["company-contact-information", "/company-information", "Company and Contact Information", "both"],
  ["account-data-deletion-information", "/account-deletion", "Account and Data Deletion Information", "both"],
  ["consumer-withdrawal-information", "/withdrawal-rights", "Consumer Withdrawal Information", "b2c"],
  ["warranty-legal-guarantee", "/warranty", "Warranty and Legal Guarantee", "both"],
  ["payment-information", "/payment-information", "Payment Information", "both"],
  ["contact-complaints", "/contact", "Contact and Complaints", "both"],
] as const;

type Block = { type: "heading" | "paragraph" | "list"; text: string };

const lawyerReviewDrafts: Record<string, Block[]> = {
  "terms-of-use": [
    { type: "heading", text: "Website Terms of Use" },
    { type: "paragraph", text: "These internal draft terms address use of the Lizzor website and account features. They are separate from Consumer Terms of Sale and Business Terms of Sale, which govern purchases when published. [INTERNAL REVIEW REQUIRED: seller identity, governing-law and notice details]" },
    { type: "heading", text: "Accounts and acceptable use" },
    { type: "paragraph", text: "Users should provide accurate account information, protect credentials and use the service lawfully. The draft should prohibit interference with service security, unauthorised access, fraudulent activity and misuse of content, while preserving rights that cannot be limited." },
    { type: "list", text: "Account security and credential protection\nPermitted website and account use\nAvailability, changes and interruption handling\nIntellectual-property and third-party content review\nAccount suspension or closure process subject to applicable rights" },
    { type: "heading", text: "Technology and review points" },
    { type: "paragraph", text: "The service uses browser session, CSRF, authentication, cart and checkout storage; a guest-order capability is used only to access the relevant guest order. Confirm final notices, complaint route and enforceability before publication. [UNRESOLVED LEGAL REVIEW]" },
  ],
  "consumer-terms-of-sale": [
    { type: "heading", text: "Consumer Terms of Sale" },
    { type: "paragraph", text: "This draft is for purchases primarily outside a trade, business or profession. Lizzor is intended to be a direct retailer operating from Cyprus for EU customers, but verified seller details must be inserted before publication. Mandatory consumer rights are not waived. [INTERNAL REVIEW REQUIRED]" },
    { type: "heading", text: "Order, price and payment" },
    { type: "paragraph", text: "Product availability, pricing, VAT treatment, obvious errors, order acknowledgement and contract formation must be confirmed against live operations. Payments are processed through Stripe using the existing direct PaymentIntent and Payment Element flow; Lizzor does not describe itself as storing raw card details. Security or fraud checks must be described only as actually configured." },
    { type: "heading", text: "Delivery, cancellation and remedies" },
    { type: "list", text: "Delivery availability and estimates must use configured shipping information and must not promise a time\nEligible consumers may have statutory withdrawal rights; see the withdrawal information\nDefective, damaged, missing or incorrect goods require a rights-preserving process\nRisk, title, refunds, liability, force majeure, complaints and consumer jurisdiction require Cyprus/EU legal review" },
    { type: "paragraph", text: "No commercial return window, warranty duration, ADR membership, seller address or contact detail is stated in this draft. [UNRESOLVED SELLER AND OPERATIONS CONFIGURATION]" },
  ],
  "business-terms-of-sale": [
    { type: "heading", text: "Business Terms of Sale" },
    { type: "paragraph", text: "These draft terms apply only where the buyer purchases primarily for professional or business purposes. They must not grant consumer-only rights merely because a business uses the storefront, and they must not remove rights required by applicable law. [INTERNAL REVIEW REQUIRED]" },
    { type: "heading", text: "Company authority and commercial orders" },
    { type: "paragraph", text: "A company account should identify authorised representatives, membership roles and order authority. Pricing, VAT, invoicing, payment through Stripe, product availability and contract formation require verification against the configured business flow." },
    { type: "list", text: "Company representative and account-misuse rules\nDelivery, inspection and reporting process to be confirmed\nTitle, risk, cancellation and return provisions subject to review\nStatutory business remedies and optional warranty treatment\nLiability, confidentiality, force majeure and jurisdiction review" },
    { type: "paragraph", text: "Do not publish until business identity, tax treatment, delivery operation and enforceable B2B wording are completed. [UNRESOLVED B2B LEGAL REVIEW]" },
  ],
  "shipping-delivery-policy": [
    { type: "heading", text: "Shipping and Delivery Policy" },
    { type: "paragraph", text: "Lizzor is intended normally to fulfil from Cyprus to supported EU destinations. Actual delivery availability and shipping cost are confirmed through configured checkout rules rather than this draft. [INTERNAL OPERATIONS REVIEW REQUIRED]" },
    { type: "heading", text: "Order handling and delivery" },
    { type: "list", text: "Available delivery zones, methods and charges must reflect live configuration\nProcessing and delivery estimates must not be stated unless operationally supportable\nTracking, multiple shipments, address corrections and failed delivery handling require confirmation\nDelays, lost parcels, damaged parcels and delivery restrictions require rights-preserving procedures" },
    { type: "heading", text: "Future territory changes" },
    { type: "paragraph", text: "If shipping is later offered outside the EU, customs and import-charge information must be reviewed before it is communicated. No dispatch time, carrier promise or return address is asserted. [UNRESOLVED SHIPPING CONFIGURATION]" },
  ],
  "returns-refunds-cancellation-policy": [
    { type: "heading", text: "Returns, Refunds and Cancellation Policy" },
    { type: "paragraph", text: "This draft distinguishes statutory withdrawal and remedies for non-conforming goods from any optional commercial returns programme. It does not create a voluntary return period. [INTERNAL LEGAL AND OPERATIONS REVIEW REQUIRED]" },
    { type: "heading", text: "Statutory routes" },
    { type: "list", text: "Eligible consumer withdrawal is addressed in the Consumer Withdrawal Information\nDamaged, defective, incorrect and missing goods must be assessed without reducing mandatory remedies\nReturn authorisation, condition expectations, bundles, gifts and partial refunds require lawful operational rules\nRefund destination and Stripe refund handling must reflect actual payment operations" },
    { type: "paragraph", text: "Return shipping responsibility, deductions, rejected returns and the returns address require verified configuration and legal review. [UNRESOLVED RETURNS DETAILS]" },
  ],
  "cookie-policy": [
    { type: "heading", text: "Cookie Policy" },
    { type: "paragraph", text: "The service uses essential browser storage supporting session, CSRF, authentication, cart, checkout, guest-order access and the versioned cookie-choice preference. Essential functions remain available; users can accept all, reject non-essential choices, manage choices and reopen settings." },
    { type: "heading", text: "Optional categories" },
    { type: "list", text: "Essential: security and requested service storage\nAnalytics: no optional analytics tracker currently operates\nMarketing: no optional marketing tracker currently operates\nFuture non-essential scripts must use the consent gate before loading" },
    { type: "paragraph", text: "The final cookie inventory, legal basis language and retention details require verification from deployed configuration. No Google Analytics, Meta Pixel or TikTok Pixel is represented. [UNRESOLVED COOKIE AUDIT]" },
  ],
  "privacy-policy": [
    { type: "heading", text: "Privacy Policy" },
    { type: "paragraph", text: "This internal GDPR-oriented draft describes only observed Lizzor processing and must be reviewed before publication. Lizzor has not supplied verified controller identity, privacy contact, DPO, retention schedule or transfer information. [INTERNAL PRIVACY REVIEW REQUIRED]" },
    { type: "heading", text: "Information and purposes to assess" },
    { type: "list", text: "Account identity and contact data; companies and memberships\nOrders, delivery addresses, payment-related status and Stripe processing\nSupport tickets, chat, notifications and Resend transactional email\nAudit and security events plus device or IP information where generated\nBrowser session, CSRF, authentication, cart, checkout, guest capability and cookie-choice storage" },
    { type: "heading", text: "Providers and rights" },
    { type: "paragraph", text: "Observed providers are Stripe, Resend and Replit hosting, database and object storage. No optional analytics or marketing tracker currently operates. Contract, legal obligation, legitimate interests and consent may require analysis for particular processing; this draft does not settle lawful bases, retention, transfer regions, automated decisions, children’s treatment or supervisory authority details. Data-subject rights and contact process require completion. [UNRESOLVED GDPR REVIEW]" },
  ],
  "company-contact-information": [
    { type: "heading", text: "Company and Contact Information" },
    { type: "paragraph", text: "This page must display verified seller identity and contact information consistently from the central business legal profile once available. The company is not yet registered and no entity name, number, VAT number, office, trading address, returns address, telephone, representative or regulatory registration is invented. [UNRESOLVED SELLER DETAILS]" },
    { type: "heading", text: "Information to verify before publication" },
    { type: "list", text: "Legal entity name and legal structure\nCompany registry and registration number\nVAT details and applicable registration country\nRegistered office, trading address and returns address\nVerified customer-support and privacy-request contact channels" },
    { type: "paragraph", text: "Contact, order complaint, return and privacy request routes must point only to configured, verified channels. [PUBLICATION BLOCKER]" },
  ],
  "account-data-deletion-information": [
    { type: "heading", text: "Account and Data Deletion Information" },
    { type: "paragraph", text: "This draft explains that account closure and privacy-rights requests need a clear support process and identity safeguards. It must not promise deletion of information that must be retained for orders, security, legal obligations or other applicable reasons. [INTERNAL PRIVACY REVIEW REQUIRED]" },
    { type: "heading", text: "Account and request handling" },
    { type: "list", text: "Account profile and sign-in information\nCompany membership and authority records\nOrders, delivery information and payment-related records\nSupport, chat, audit and security information\nIdentity verification and request status communications" },
    { type: "paragraph", text: "Retention periods, response time, exemptions, identity verification method and privacy contact route are not configured. This page should explain applicable access, rectification, deletion, restriction, objection, portability and consent-withdrawal rights only after review. [UNRESOLVED RIGHTS PROCESS]" },
  ],
  "consumer-withdrawal-information": [
    { type: "heading", text: "Consumer Right of Withdrawal" },
    { type: "paragraph", text: "Eligible EU consumers may have a statutory right to withdraw from eligible distance contracts. This draft must be reviewed for Cyprus/EU application, timing, exceptions and operational process. It does not narrow mandatory rights or assert a commercial returns period. [INTERNAL LEGAL REVIEW REQUIRED]" },
    { type: "heading", text: "Withdrawal process to confirm" },
    { type: "list", text: "Who qualifies and when a withdrawal period begins\nA clear withdrawal statement can be submitted through the verified support process\nReturn, refund, standard-delivery-cost and diminished-value treatment subject to law\nExceptions may be narrow and product-specific, including personalised goods or sealed hygiene, software or media where legally applicable" },
    { type: "heading", text: "Model withdrawal form — optional copy/print form" },
    { type: "paragraph", text: "To: [INTERNAL: INSERT VERIFIED SELLER/CONTACT]. I/we hereby give notice that I/we withdraw from my/our contract for the sale of the following goods: [goods]. Ordered on: [date]. Received on: [date]. Name: [name]. Address: [address]. Order number: [order number]. Date: [date]. Signature (only if sent on paper): [signature]. This form may be copied or printed; customers do not have to use it where another clear statement is permitted. [UNRESOLVED CONTACT AND LEGAL REVIEW]" },
  ],
  "warranty-legal-guarantee": [
    { type: "heading", text: "Warranty and Legal Guarantee" },
    { type: "paragraph", text: "This draft distinguishes mandatory statutory remedies for non-conforming or defective goods from optional manufacturer warranties and any future Lizzor commercial warranty. Optional warranties must not replace statutory rights. [INTERNAL LEGAL REVIEW REQUIRED]" },
    { type: "heading", text: "Defect and warranty handling" },
    { type: "list", text: "Customers should report damage, defects or incorrect goods through a verified support route\nApplicable repair, replacement, price reduction, cancellation or other remedies require legal review\nManufacturer warranty documents, if supplied, need product-specific presentation\nNo warranty duration, manufacturer commitment or commercial warranty is stated" },
    { type: "paragraph", text: "Product-category safety, electrical, beauty and children’s-product obligations may require separate product compliance work. [UNRESOLVED PRODUCT AND LEGAL REVIEW]" },
  ],
  "payment-information": [
    { type: "heading", text: "Payment Information" },
    { type: "paragraph", text: "Payments are processed through the existing direct Stripe PaymentIntent and Payment Element integration. This page must not expose credentials or claim that Lizzor stores raw card numbers. [INTERNAL PAYMENT DISCLOSURE REVIEW REQUIRED]" },
    { type: "heading", text: "Payment journey" },
    { type: "list", text: "Available payment methods should reflect what Stripe and the checkout actually present\nAuthorisation, authentication including 3D Secure where applicable, and payment failures follow the live flow\nOrder status remains authoritative under the existing payment and webhook handling\nRefunds are processed through applicable operational processes and may use Stripe" },
    { type: "paragraph", text: "Currency, VAT/pricing wording, refund timing and final seller/payment contact details require configuration and review. No payment-settlement condition is created by browser policy acknowledgement. [UNRESOLVED PAYMENT DISCLOSURES]" },
  ],
  "contact-complaints": [
    { type: "heading", text: "Contact and Complaints" },
    { type: "paragraph", text: "Customers should be able to use verified Lizzor support channels for order, delivery, return, defect, privacy and general complaints. No phone number, address, legal entity contact, returns location, ADR membership or complaint body is supplied in this draft. [UNRESOLVED CONTACT DETAILS]" },
    { type: "heading", text: "Routes to configure" },
    { type: "list", text: "Order, delivery, damaged or incorrect goods enquiries\nWithdrawal and returns communications\nPrivacy and data-rights requests\nAccount, company membership and technical support\nComplaint escalation and any legally required external information" },
    { type: "paragraph", text: "Support and chat records are processed by the service; operational response commitments and complaint escalation details must be approved before publication. [INTERNAL COMPLAINTS REVIEW REQUIRED]" },
  ],
};

async function reconcileWithClient(client: PoolClient): Promise<LegalDocumentReconciliationResult> {
  const documentResult = await client.query(
    `INSERT INTO legal_documents (canonical_key,public_route,title,audience,language,required_for_commercial_launch)
     SELECT * FROM unnest($1::text[],$2::text[],$3::text[],$4::text[],$5::text[],$6::boolean[])
     ON CONFLICT (canonical_key) DO UPDATE SET audience=EXCLUDED.audience
       WHERE legal_documents.audience IS DISTINCT FROM EXCLUDED.audience`,
    [
      canonicalDocuments.map(([key]) => key),
      canonicalDocuments.map(([, route]) => route),
      canonicalDocuments.map(([, , title]) => title),
      canonicalDocuments.map(([, , , audience]) => audience),
      canonicalDocuments.map(() => "en"),
      canonicalDocuments.map(() => true),
    ],
  );

  let draftsAdded = 0;
  for (const [canonicalKey, , title] of canonicalDocuments) {
    const draft = lawyerReviewDrafts[canonicalKey];
    if (!draft) throw new Error(`Missing bundled legal draft: ${canonicalKey}`);
    const draftResult = await client.query(
      `INSERT INTO legal_document_versions
         (document_id,version_number,language,title,body_json,status)
       SELECT d.id,1,'en',$2,$3::jsonb,'draft'
         FROM legal_documents d
        WHERE d.canonical_key=$1
          AND NOT EXISTS (
            SELECT 1 FROM legal_document_versions v
             WHERE v.document_id=d.id AND v.language='en'
          )
       ON CONFLICT (document_id,language,version_number) DO NOTHING`,
      [canonicalKey, `LAWYER-REVIEW-REQUIRED — ${title}`, JSON.stringify({ blocks: draft })],
    );
    draftsAdded += draftResult.rowCount ?? 0;
  }

  const aliasResult = await client.query(
    `INSERT INTO legal_document_aliases (alias_route,document_id)
     SELECT aliases.route,documents.id
       FROM (VALUES
         ('/returns','returns-refunds-cancellation-policy'),
         ('/shipping','shipping-delivery-policy'),
         ('/consumer-rights','consumer-withdrawal-information')
       ) AS aliases(route,canonical_key)
       JOIN legal_documents documents ON documents.canonical_key=aliases.canonical_key
     ON CONFLICT (alias_route) DO UPDATE SET document_id=EXCLUDED.document_id
       WHERE legal_document_aliases.document_id IS DISTINCT FROM EXCLUDED.document_id`,
  );

  return {
    documentsAdded: documentResult.rowCount ?? 0,
    draftsAdded,
    aliasesReconciled: aliasResult.rowCount ?? 0,
  };
}

export async function reconcileLegalDocumentCatalog(client?: PoolClient): Promise<LegalDocumentReconciliationResult> {
  if (client) return reconcileWithClient(client);

  const ownedClient = await getDatabasePool().connect();
  try {
    await ownedClient.query("BEGIN");
    await ownedClient.query("SET LOCAL lock_timeout = '10s'");
    await ownedClient.query("SET LOCAL statement_timeout = '20s'");
    await ownedClient.query("SELECT pg_advisory_xact_lock(hashtext('lizzor:legal-document-catalog'))");
    const result = await reconcileWithClient(ownedClient);
    await ownedClient.query("COMMIT");
    return result;
  } catch (error) {
    await ownedClient.query("ROLLBACK");
    throw error;
  } finally {
    ownedClient.release();
  }
}