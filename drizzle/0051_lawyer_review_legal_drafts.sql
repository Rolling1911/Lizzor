-- Internal drafting material only. This migration deliberately creates no public
-- publication, effective date, readiness confirmation or pointer update.
INSERT INTO "legal_document_versions" ("document_id","version_number","language","title","body_json","status")
SELECT d.id,
  COALESCE((SELECT max(v.version_number) + 1 FROM "legal_document_versions" v WHERE v.document_id=d.id AND v.language='en'), 1),
  'en',
  'LAWYER-REVIEW-REQUIRED — ' || d.title,
  CASE d.canonical_key
    WHEN 'terms-of-use' THEN jsonb_build_object('blocks', jsonb_build_array(
      jsonb_build_object('type','heading','text','Website Terms of Use'),
      jsonb_build_object('type','paragraph','text','These internal draft terms address use of the Lizzor website and account features. They are separate from Consumer Terms of Sale and Business Terms of Sale, which govern purchases when published. [INTERNAL REVIEW REQUIRED: seller identity, governing-law and notice details]'),
      jsonb_build_object('type','heading','text','Accounts and acceptable use'),
      jsonb_build_object('type','paragraph','text','Users should provide accurate account information, protect credentials and use the service lawfully. The draft should prohibit interference with service security, unauthorised access, fraudulent activity and misuse of content, while preserving rights that cannot be limited.'),
      jsonb_build_object('type','list','text','Account security and credential protection\nPermitted website and account use\nAvailability, changes and interruption handling\nIntellectual-property and third-party content review\nAccount suspension or closure process subject to applicable rights'),
      jsonb_build_object('type','heading','text','Technology and review points'),
      jsonb_build_object('type','paragraph','text','The service uses browser session, CSRF, authentication, cart and checkout storage; a guest-order capability is used only to access the relevant guest order. Confirm final notices, complaint route and enforceability before publication. [UNRESOLVED LEGAL REVIEW]')))
    WHEN 'consumer-terms-of-sale' THEN jsonb_build_object('blocks', jsonb_build_array(
      jsonb_build_object('type','heading','text','Consumer Terms of Sale'),
      jsonb_build_object('type','paragraph','text','This draft is for purchases primarily outside a trade, business or profession. Lizzor is intended to be a direct retailer operating from Cyprus for EU customers, but verified seller details must be inserted before publication. Mandatory consumer rights are not waived. [INTERNAL REVIEW REQUIRED]'),
      jsonb_build_object('type','heading','text','Order, price and payment'),
      jsonb_build_object('type','paragraph','text','Product availability, pricing, VAT treatment, obvious errors, order acknowledgement and contract formation must be confirmed against live operations. Payments are processed through Stripe using the existing direct PaymentIntent and Payment Element flow; Lizzor does not describe itself as storing raw card details. Security or fraud checks must be described only as actually configured.'),
      jsonb_build_object('type','heading','text','Delivery, cancellation and remedies'),
      jsonb_build_object('type','list','text','Delivery availability and estimates must use configured shipping information and must not promise a time\nEligible consumers may have statutory withdrawal rights; see the withdrawal information\nDefective, damaged, missing or incorrect goods require a rights-preserving process\nRisk, title, refunds, liability, force majeure, complaints and consumer jurisdiction require Cyprus/EU legal review'),
      jsonb_build_object('type','paragraph','text','No commercial return window, warranty duration, ADR membership, seller address or contact detail is stated in this draft. [UNRESOLVED SELLER AND OPERATIONS CONFIGURATION]')))
    WHEN 'business-terms-of-sale' THEN jsonb_build_object('blocks', jsonb_build_array(
      jsonb_build_object('type','heading','text','Business Terms of Sale'),
      jsonb_build_object('type','paragraph','text','These draft terms apply only where the buyer purchases primarily for professional or business purposes. They must not grant consumer-only rights merely because a business uses the storefront, and they must not remove rights required by applicable law. [INTERNAL REVIEW REQUIRED]'),
      jsonb_build_object('type','heading','text','Company authority and commercial orders'),
      jsonb_build_object('type','paragraph','text','A company account should identify authorised representatives, membership roles and order authority. Pricing, VAT, invoicing, payment through Stripe, product availability and contract formation require verification against the configured business flow.'),
      jsonb_build_object('type','list','text','Company representative and account-misuse rules\nDelivery, inspection and reporting process to be confirmed\nTitle, risk, cancellation and return provisions subject to review\nStatutory business remedies and optional warranty treatment\nLiability, confidentiality, force majeure and jurisdiction review'),
      jsonb_build_object('type','paragraph','text','Do not publish until business identity, tax treatment, delivery operation and enforceable B2B wording are completed. [UNRESOLVED B2B LEGAL REVIEW]')))
    WHEN 'shipping-delivery-policy' THEN jsonb_build_object('blocks', jsonb_build_array(
      jsonb_build_object('type','heading','text','Shipping and Delivery Policy'),
      jsonb_build_object('type','paragraph','text','Lizzor is intended normally to fulfil from Cyprus to supported EU destinations. Actual delivery availability and shipping cost are confirmed through configured checkout rules rather than this draft. [INTERNAL OPERATIONS REVIEW REQUIRED]'),
      jsonb_build_object('type','heading','text','Order handling and delivery'),
      jsonb_build_object('type','list','text','Available delivery zones, methods and charges must reflect live configuration\nProcessing and delivery estimates must not be stated unless operationally supportable\nTracking, multiple shipments, address corrections and failed delivery handling require confirmation\nDelays, lost parcels, damaged parcels and delivery restrictions require rights-preserving procedures'),
      jsonb_build_object('type','heading','text','Future territory changes'),
      jsonb_build_object('type','paragraph','text','If shipping is later offered outside the EU, customs and import-charge information must be reviewed before it is communicated. No dispatch time, carrier promise or return address is asserted. [UNRESOLVED SHIPPING CONFIGURATION]')))
    WHEN 'returns-refunds-cancellation-policy' THEN jsonb_build_object('blocks', jsonb_build_array(
      jsonb_build_object('type','heading','text','Returns, Refunds and Cancellation Policy'),
      jsonb_build_object('type','paragraph','text','This draft distinguishes statutory withdrawal and remedies for non-conforming goods from any optional commercial returns programme. It does not create a voluntary return period. [INTERNAL LEGAL AND OPERATIONS REVIEW REQUIRED]'),
      jsonb_build_object('type','heading','text','Statutory routes'),
      jsonb_build_object('type','list','text','Eligible consumer withdrawal is addressed in the Consumer Withdrawal Information\nDamaged, defective, incorrect and missing goods must be assessed without reducing mandatory remedies\nReturn authorisation, condition expectations, bundles, gifts and partial refunds require lawful operational rules\nRefund destination and Stripe refund handling must reflect actual payment operations'),
      jsonb_build_object('type','paragraph','text','Return shipping responsibility, deductions, rejected returns and the returns address require verified configuration and legal review. [UNRESOLVED RETURNS DETAILS]')))
    WHEN 'cookie-policy' THEN jsonb_build_object('blocks', jsonb_build_array(
      jsonb_build_object('type','heading','text','Cookie Policy'),
      jsonb_build_object('type','paragraph','text','The service uses essential browser storage supporting session, CSRF, authentication, cart, checkout, guest-order access and the versioned cookie-choice preference. Essential functions remain available; users can accept all, reject non-essential choices, manage choices and reopen settings.'),
      jsonb_build_object('type','heading','text','Optional categories'),
      jsonb_build_object('type','list','text','Essential: security and requested service storage\nAnalytics: no optional analytics tracker currently operates\nMarketing: no optional marketing tracker currently operates\nFuture non-essential scripts must use the consent gate before loading'),
      jsonb_build_object('type','paragraph','text','The final cookie inventory, legal basis language and retention details require verification from deployed configuration. No Google Analytics, Meta Pixel or TikTok Pixel is represented. [UNRESOLVED COOKIE AUDIT]')))
    WHEN 'privacy-policy' THEN jsonb_build_object('blocks', jsonb_build_array(
      jsonb_build_object('type','heading','text','Privacy Policy'),
      jsonb_build_object('type','paragraph','text','This internal GDPR-oriented draft describes only observed Lizzor processing and must be reviewed before publication. Lizzor has not supplied verified controller identity, privacy contact, DPO, retention schedule or transfer information. [INTERNAL PRIVACY REVIEW REQUIRED]'),
      jsonb_build_object('type','heading','text','Information and purposes to assess'),
      jsonb_build_object('type','list','text','Account identity and contact data; companies and memberships\nOrders, delivery addresses, payment-related status and Stripe processing\nSupport tickets, chat, notifications and Resend transactional email\nAudit and security events plus device or IP information where generated\nBrowser session, CSRF, authentication, cart, checkout, guest capability and cookie-choice storage'),
      jsonb_build_object('type','heading','text','Providers and rights'),
      jsonb_build_object('type','paragraph','text','Observed providers are Stripe, Resend and Replit hosting, database and object storage. No optional analytics or marketing tracker currently operates. Contract, legal obligation, legitimate interests and consent may require analysis for particular processing; this draft does not settle lawful bases, retention, transfer regions, automated decisions, children’s treatment or supervisory authority details. Data-subject rights and contact process require completion. [UNRESOLVED GDPR REVIEW]')))
    WHEN 'company-contact-information' THEN jsonb_build_object('blocks', jsonb_build_array(
      jsonb_build_object('type','heading','text','Company and Contact Information'),
      jsonb_build_object('type','paragraph','text','This page must display verified seller identity and contact information consistently from the central business legal profile once available. The company is not yet registered and no entity name, number, VAT number, office, trading address, returns address, telephone, representative or regulatory registration is invented. [UNRESOLVED SELLER DETAILS]'),
      jsonb_build_object('type','heading','text','Information to verify before publication'),
      jsonb_build_object('type','list','text','Legal entity name and legal structure\nCompany registry and registration number\nVAT details and applicable registration country\nRegistered office, trading address and returns address\nVerified customer-support and privacy-request contact channels'),
      jsonb_build_object('type','paragraph','text','Contact, order complaint, return and privacy request routes must point only to configured, verified channels. [PUBLICATION BLOCKER]')))
    WHEN 'account-data-deletion-information' THEN jsonb_build_object('blocks', jsonb_build_array(
      jsonb_build_object('type','heading','text','Account and Data Deletion Information'),
      jsonb_build_object('type','paragraph','text','This draft explains that account closure and privacy-rights requests need a clear support process and identity safeguards. It must not promise deletion of information that must be retained for orders, security, legal obligations or other applicable reasons. [INTERNAL PRIVACY REVIEW REQUIRED]'),
      jsonb_build_object('type','heading','text','Account and request handling'),
      jsonb_build_object('type','list','text','Account profile and sign-in information\nCompany membership and authority records\nOrders, delivery information and payment-related records\nSupport, chat, audit and security information\nIdentity verification and request status communications'),
      jsonb_build_object('type','paragraph','text','Retention periods, response time, exemptions, identity verification method and privacy contact route are not configured. This page should explain applicable access, rectification, deletion, restriction, objection, portability and consent-withdrawal rights only after review. [UNRESOLVED RIGHTS PROCESS]')))
    WHEN 'consumer-withdrawal-information' THEN jsonb_build_object('blocks', jsonb_build_array(
      jsonb_build_object('type','heading','text','Consumer Right of Withdrawal'),
      jsonb_build_object('type','paragraph','text','Eligible EU consumers may have a statutory right to withdraw from eligible distance contracts. This draft must be reviewed for Cyprus/EU application, timing, exceptions and operational process. It does not narrow mandatory rights or assert a commercial returns period. [INTERNAL LEGAL REVIEW REQUIRED]'),
      jsonb_build_object('type','heading','text','Withdrawal process to confirm'),
      jsonb_build_object('type','list','text','Who qualifies and when a withdrawal period begins\nA clear withdrawal statement can be submitted through the verified support process\nReturn, refund, standard-delivery-cost and diminished-value treatment subject to law\nExceptions may be narrow and product-specific, including personalised goods or sealed hygiene, software or media where legally applicable'),
      jsonb_build_object('type','heading','text','Model withdrawal form — optional copy/print form'),
      jsonb_build_object('type','paragraph','text','To: [INTERNAL: INSERT VERIFIED SELLER/CONTACT]. I/we hereby give notice that I/we withdraw from my/our contract for the sale of the following goods: [goods]. Ordered on: [date]. Received on: [date]. Name: [name]. Address: [address]. Order number: [order number]. Date: [date]. Signature (only if sent on paper): [signature]. This form may be copied or printed; customers do not have to use it where another clear statement is permitted. [UNRESOLVED CONTACT AND LEGAL REVIEW]')))
    WHEN 'warranty-legal-guarantee' THEN jsonb_build_object('blocks', jsonb_build_array(
      jsonb_build_object('type','heading','text','Warranty and Legal Guarantee'),
      jsonb_build_object('type','paragraph','text','This draft distinguishes mandatory statutory remedies for non-conforming or defective goods from optional manufacturer warranties and any future Lizzor commercial warranty. Optional warranties must not replace statutory rights. [INTERNAL LEGAL REVIEW REQUIRED]'),
      jsonb_build_object('type','heading','text','Defect and warranty handling'),
      jsonb_build_object('type','list','text','Customers should report damage, defects or incorrect goods through a verified support route\nApplicable repair, replacement, price reduction, cancellation or other remedies require legal review\nManufacturer warranty documents, if supplied, need product-specific presentation\nNo warranty duration, manufacturer commitment or commercial warranty is stated'),
      jsonb_build_object('type','paragraph','text','Product-category safety, electrical, beauty and children’s-product obligations may require separate product compliance work. [UNRESOLVED PRODUCT AND LEGAL REVIEW]')))
    WHEN 'payment-information' THEN jsonb_build_object('blocks', jsonb_build_array(
      jsonb_build_object('type','heading','text','Payment Information'),
      jsonb_build_object('type','paragraph','text','Payments are processed through the existing direct Stripe PaymentIntent and Payment Element integration. This page must not expose credentials or claim that Lizzor stores raw card numbers. [INTERNAL PAYMENT DISCLOSURE REVIEW REQUIRED]'),
      jsonb_build_object('type','heading','text','Payment journey'),
      jsonb_build_object('type','list','text','Available payment methods should reflect what Stripe and the checkout actually present\nAuthorisation, authentication including 3D Secure where applicable, and payment failures follow the live flow\nOrder status remains authoritative under the existing payment and webhook handling\nRefunds are processed through applicable operational processes and may use Stripe'),
      jsonb_build_object('type','paragraph','text','Currency, VAT/pricing wording, refund timing and final seller/payment contact details require configuration and review. No payment-settlement condition is created by browser policy acknowledgement. [UNRESOLVED PAYMENT DISCLOSURES]')))
    WHEN 'contact-complaints' THEN jsonb_build_object('blocks', jsonb_build_array(
      jsonb_build_object('type','heading','text','Contact and Complaints'),
      jsonb_build_object('type','paragraph','text','Customers should be able to use verified Lizzor support channels for order, delivery, return, defect, privacy and general complaints. No phone number, address, legal entity contact, returns location, ADR membership or complaint body is supplied in this draft. [UNRESOLVED CONTACT DETAILS]'),
      jsonb_build_object('type','heading','text','Routes to configure'),
      jsonb_build_object('type','list','text','Order, delivery, damaged or incorrect goods enquiries\nWithdrawal and returns communications\nPrivacy and data-rights requests\nAccount, company membership and technical support\nComplaint escalation and any legally required external information'),
      jsonb_build_object('type','paragraph','text','Support and chat records are processed by the service; operational response commitments and complaint escalation details must be approved before publication. [INTERNAL COMPLAINTS REVIEW REQUIRED]')))
    ELSE jsonb_build_object('blocks', jsonb_build_array(
      jsonb_build_object('type','heading','text','Internal legal draft'),
      jsonb_build_object('type','paragraph','text','[UNRESOLVED LEGAL REVIEW REQUIRED]')))
  END,
  'draft'
FROM "legal_documents" d
WHERE d.canonical_key IN ('terms-of-use','privacy-policy','consumer-terms-of-sale','business-terms-of-sale','shipping-delivery-policy','returns-refunds-cancellation-policy','cookie-policy','company-contact-information','account-data-deletion-information','consumer-withdrawal-information','warranty-legal-guarantee','payment-information','contact-complaints');