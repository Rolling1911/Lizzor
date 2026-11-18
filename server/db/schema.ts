import {
  boolean,
  customType,
  type AnyPgColumn,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";

const timestamps = {
  get createdAt() {
    return timestamp("created_at", { withTimezone: true }).defaultNow().notNull();
  },
  get updatedAt() {
    return timestamp("updated_at", { withTimezone: true }).defaultNow().notNull();
  },
};

const money = (name: string) => numeric(name, { precision: 12, scale: 2 });
const bytea = customType<{ data: Buffer }>({ dataType() { return "bytea"; } });

export const accountTypeEnum = pgEnum("account_type", ["personal", "business"]);
export const userStatusEnum = pgEnum("user_status", ["pending", "active", "suspended", "deactivated"]);
export const companyStatusEnum = pgEnum("company_status", ["pending", "active", "suspended", "deactivated"]);
export const companyMembershipRoleEnum = pgEnum("company_membership_role", ["owner", "admin", "buyer", "viewer"]);
export const companyMembershipStatusEnum = pgEnum("company_membership_status", ["active", "suspended"]);
export const addressTypeEnum = pgEnum("address_type", ["billing", "shipping"]);
export const productStatusEnum = pgEnum("product_status", ["draft", "active", "inactive", "archived"]);
export const mediaTypeEnum = pgEnum("media_type", ["image", "video"]);
export const movementTypeEnum = pgEnum("movement_type", [
  "purchase",
  "sale",
  "return",
  "damage",
  "adjustment",
  "transfer_in",
  "transfer_out",
]);
export const cartStatusEnum = pgEnum("cart_status", ["active", "converted", "abandoned"]);
export const reservationStatusEnum = pgEnum("reservation_status", ["active", "released", "converted"]);
export const orderStatusEnum = pgEnum("order_status", ["pending", "confirmed", "processing", "completed", "cancelled"]);
export const paymentStatusEnum = pgEnum("payment_status", ["pending", "requires_action", "processing", "authorized", "paid", "failed", "cancelled", "refunded", "partially_refunded"]);
export const fulfillmentStatusEnum = pgEnum("fulfillment_status", ["unfulfilled", "partially_fulfilled", "fulfilled", "cancelled"]);
export const shipmentStatusEnum = pgEnum("shipment_status", ["pending", "shipped", "in_transit", "delivered", "returned", "cancelled"]);
export const returnStatusEnum = pgEnum("return_status", ["requested", "in_review", "approved", "received", "rejected", "completed", "cancelled"]);
export const refundStatusEnum = pgEnum("refund_status", ["pending", "processing", "completed", "failed", "cancelled"]);
export const discountTypeEnum = pgEnum("discount_type", ["percentage", "fixed"]);
export const notificationPlatformEnum = pgEnum("notification_platform", ["ios", "android", "web"]);
export const notificationCampaignStatusEnum = pgEnum("notification_campaign_status", ["draft", "scheduled", "sending", "sent", "cancelled"]);
export const supportTicketStatusEnum = pgEnum("support_ticket_status", ["open", "in_progress", "waiting_customer", "resolved", "closed"]);
export const chatSessionStatusEnum = pgEnum("chat_session_status", ["open", "closed"]);
export const contentStatusEnum = pgEnum("content_status", ["draft", "published", "archived"]);
export const authSessionTypeEnum = pgEnum("auth_session_type", ["customer", "admin"]);
export const adminTwoFactorStatusEnum = pgEnum("admin_two_factor_status", ["disabled", "pending", "enabled"]);
export const supplierCategoryMappingStatusEnum = pgEnum("supplier_category_mapping_status", ["mapped", "unmapped", "ignored", "needs_review"]);
export const supplierSyncStateEnum = pgEnum("supplier_sync_state", ["Synced", "Changed", "Out of stock", "Supplier unavailable", "Error", "Needs review"]);
export const supplierSyncRunStatusEnum = pgEnum("supplier_sync_run_status", ["running", "partial", "completed", "failed"]);
export const supplierPricingRuleTypeEnum = pgEnum("supplier_pricing_rule_type", ["markup_percent", "markup_fixed", "margin_percent"]);
export const supplierRoundingModeEnum = pgEnum("supplier_rounding_mode", ["none", "whole", "99"]);
export const tooniesSettlementStateEnum = pgEnum("toonies_settlement_state", [
  "not_submitted", "submitting", "transmitted_unknown", "reconciling",
  "replay_pending", "confirmed", "documented_rejection", "manual_review",
]);
export const tooniesSettlementConfirmationKindEnum = pgEnum("toonies_settlement_confirmation_kind", ["original", "duplicate"]);
export const financialOperationTypeEnum = pgEnum("financial_operation_type", [
  "supplier_settlement", "payment_refund", "payment_invalidation", "payment_cancellation",
]);
export const financialOperationStateEnum = pgEnum("financial_operation_state", [
  "active", "ambiguous", "completed", "failed", "released",
]);
export const supplierFailureReversalStateEnum = pgEnum("supplier_failure_reversal_state", [
  "eligible", "reserved", "transmitting", "ambiguous", "manual_review", "completed", "failed",
]);

export const users = pgTable(
  "users",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    email: varchar("email", { length: 320 }).notNull(),
    passwordHash: text("password_hash"),
    firstName: varchar("first_name", { length: 100 }).notNull(),
    lastName: varchar("last_name", { length: 100 }).notNull(),
    phone: varchar("phone", { length: 50 }),
    countryCode: varchar("country_code", { length: 2 }),
    accountType: accountTypeEnum("account_type").default("personal").notNull(),
    status: userStatusEnum("status").default("pending").notNull(),
    emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true }),
    activeCompanyId: uuid("active_company_id"),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("users_email_unique").on(table.email),
    index("users_status_idx").on(table.status),
    index("users_created_at_idx").on(table.createdAt),
  ],
);

export const companies = pgTable(
  "companies",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    companyName: varchar("company_name", { length: 200 }).notNull(),
    vatNumber: varchar("vat_number", { length: 50 }),
    registrationNumber: varchar("registration_number", { length: 100 }),
    contactPerson: varchar("contact_person", { length: 200 }).notNull(),
    phone: varchar("phone", { length: 50 }),
    email: varchar("email", { length: 320 }).notNull(),
    countryCode: varchar("country_code", { length: 2 }),
    status: companyStatusEnum("status").default("active").notNull(),
    billingAddressId: uuid("billing_address_id").references(
      (): AnyPgColumn => addresses.id,
      { onDelete: "set null" },
    ),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("companies_vat_number_unique").on(table.vatNumber),
    index("companies_email_idx").on(table.email),
    index("companies_created_at_idx").on(table.createdAt),
  ],
);

export const addresses = pgTable(
  "addresses",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    companyId: uuid("company_id").references(() => companies.id, { onDelete: "cascade" }),
    type: addressTypeEnum("type").notNull(),
    firstName: varchar("first_name", { length: 100 }).notNull(),
    lastName: varchar("last_name", { length: 100 }).notNull(),
    companyName: varchar("company_name", { length: 200 }),
    addressLine1: varchar("address_line_1", { length: 200 }).notNull(),
    addressLine2: varchar("address_line_2", { length: 200 }),
    city: varchar("city", { length: 100 }).notNull(),
    postalCode: varchar("postal_code", { length: 30 }).notNull(),
    region: varchar("region", { length: 100 }),
    countryCode: varchar("country_code", { length: 2 }).notNull(),
    phone: varchar("phone", { length: 50 }),
    isDefault: boolean("is_default").default(false).notNull(),
    ...timestamps,
  },
  (table) => [
    index("addresses_user_idx").on(table.userId),
    index("addresses_company_idx").on(table.companyId),
    check("addresses_owner_check", sql`num_nonnulls(${table.userId}, ${table.companyId}) = 1`),
  ],
);

export const companyUsers = pgTable(
  "company_users",
  {
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    companyRole: varchar("company_role", { length: 100 }),
    role: companyMembershipRoleEnum("role").default("buyer").notNull(),
    status: companyMembershipStatusEnum("status").default("active").notNull(),
    createdAt: timestamps.createdAt,
  },
  (table) => [
    primaryKey({ columns: [table.companyId, table.userId] }),
    index("company_users_user_idx").on(table.userId),
  ],
);

export const companyInvitations = pgTable(
  "company_invitations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    email: varchar("email", { length: 320 }).notNull(),
    role: companyMembershipRoleEnum("role").default("buyer").notNull(),
    tokenHash: varchar("token_hash", { length: 128 }).notNull(),
    invitedByUserId: uuid("invited_by_user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    lastResendIdempotencyKey: uuid("last_resend_idempotency_key"),
    createdAt: timestamps.createdAt,
  },
  (table) => [
    uniqueIndex("company_invitations_token_hash_unique").on(table.tokenHash),
    index("company_invitations_company_idx").on(table.companyId, table.expiresAt),
    index("company_invitations_email_idx").on(table.email),
  ],
);

/** Retains the original guest proof after an order is attached to an account. */

export const brands = pgTable(
  "brands",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    name: varchar("name", { length: 150 }).notNull(),
    slug: varchar("slug", { length: 180 }).notNull(),
    seoTitle: varchar("seo_title", { length: 70 }),
    seoDescription: varchar("seo_description", { length: 170 }),
    logoUrl: text("logo_url"),
    description: text("description"),
    active: boolean("active").default(true).notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("brands_slug_unique").on(table.slug),
    uniqueIndex("brands_name_unique").on(table.name),
    index("brands_active_idx").on(table.active),
  ],
);

export const categories = pgTable(
  "categories",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    parentId: uuid("parent_id").references(
      (): AnyPgColumn => categories.id,
      { onDelete: "set null" },
    ),
    name: varchar("name", { length: 150 }).notNull(),
    slug: varchar("slug", { length: 180 }).notNull(),
    canonicalKey: varchar("canonical_key", { length: 220 }),
    seoTitle: varchar("seo_title", { length: 70 }),
    seoDescription: varchar("seo_description", { length: 170 }),
    description: text("description"),
    imageUrl: text("image_url"),
    sortOrder: integer("sort_order").default(0).notNull(),
    active: boolean("active").default(true).notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("categories_slug_unique").on(table.slug),
    uniqueIndex("categories_slug_normalized_unique").on(sql`lower(${table.slug})`),
    uniqueIndex("categories_canonical_key_unique").on(table.canonicalKey),
    uniqueIndex("categories_canonical_key_normalized_unique").on(sql`lower(${table.canonicalKey})`),
    index("categories_parent_idx").on(table.parentId),
    index("categories_active_sort_idx").on(table.active, table.sortOrder),
  ],
);

/** A supplier is deliberately generic: integrations must not add provider-specific
 * columns to the catalogue or create supplier rows before an integration is enabled. */
export const suppliers = pgTable(
  "suppliers",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    name: varchar("name", { length: 200 }).notNull(),
    slug: varchar("slug", { length: 180 }).notNull(),
    active: boolean("active").default(true).notNull(),
    publicationEnabled: boolean("publication_enabled").default(false).notNull(),
    complianceExcluded: boolean("compliance_excluded").default(true).notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("suppliers_name_unique").on(table.name),
    uniqueIndex("suppliers_slug_unique").on(table.slug),
    index("suppliers_active_idx").on(table.active),
  ],
);

export const supplierCategoryMappings = pgTable(
  "supplier_category_mappings",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    supplierId: uuid("supplier_id").notNull().references(() => suppliers.id, { onDelete: "cascade" }),
    externalCategoryId: varchar("external_category_id", { length: 255 }).notNull(),
    externalCategoryName: varchar("external_category_name", { length: 500 }).notNull(),
    externalCategoryPath: text("external_category_path"),
    rootCategoryId: uuid("root_category_id").references(() => categories.id, { onDelete: "restrict" }),
    childCategoryId: uuid("child_category_id").references(() => categories.id, { onDelete: "restrict" }),
    status: supplierCategoryMappingStatusEnum("status").default("unmapped").notNull(),
    publicationEnabled: boolean("publication_enabled").default(false).notNull(),
    complianceExcluded: boolean("compliance_excluded").default(true).notNull(),
    metadata: jsonb("metadata"),
    lastMappedBy: uuid("last_mapped_by").references(() => users.id, { onDelete: "set null" }),
    lastMappedAt: timestamp("last_mapped_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("supplier_category_mappings_supplier_external_unique").on(table.supplierId, table.externalCategoryId),
    index("supplier_category_mappings_supplier_status_idx").on(table.supplierId, table.status),
    index("supplier_category_mappings_root_idx").on(table.rootCategoryId),
    index("supplier_category_mappings_child_idx").on(table.childCategoryId),
    check("supplier_category_mappings_publication_safety_check", sql`${table.publicationEnabled} = false OR ${table.complianceExcluded} = false`),
  ],
);

export const supplierCategoryMappingHistory = pgTable(
  "supplier_category_mapping_history",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    mappingId: uuid("mapping_id").notNull().references(() => supplierCategoryMappings.id, { onDelete: "cascade" }),
    action: varchar("action", { length: 40 }).notNull(),
    previousSnapshot: jsonb("previous_snapshot"),
    nextSnapshot: jsonb("next_snapshot"),
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    bulkOperationId: uuid("bulk_operation_id"),
    reason: text("reason"),
    createdAt: timestamps.createdAt,
  },
  (table) => [
    index("supplier_category_mapping_history_mapping_idx").on(table.mappingId, table.createdAt),
    index("supplier_category_mapping_history_actor_idx").on(table.actorUserId, table.createdAt),
    index("supplier_category_mapping_history_bulk_idx").on(table.bulkOperationId),
  ],
);

/** Validated, provider-neutral FX observations shared by supplier operations. */
export const fxRateSnapshots = pgTable(
  "fx_rate_snapshots",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    provider: varchar("provider", { length: 80 }).notNull(),
    source: varchar("source", { length: 80 }).notNull(),
    series: varchar("series", { length: 160 }).notNull(),
    baseCurrency: varchar("base_currency", { length: 3 }).notNull(),
    quoteCurrency: varchar("quote_currency", { length: 3 }).notNull(),
    rate: numeric("rate", { precision: 20, scale: 12 }).notNull(),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    fetchCacheExpiresAt: timestamp("fetch_cache_expires_at", { withTimezone: true }).notNull(),
    maxAgeHours: numeric("max_age_hours", { precision: 6, scale: 2 }).notNull(),
    responseHash: varchar("response_hash", { length: 128 }),
    rawMetadata: jsonb("raw_metadata"),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("fx_rate_snapshots_provider_series_observed_fetched_unique").on(table.provider, table.series, table.observedAt, table.fetchedAt),
    index("fx_rate_snapshots_lookup_idx").on(table.provider, table.series, table.baseCurrency, table.quoteCurrency, table.fetchedAt),
    check("fx_rate_snapshots_rate_positive", sql`${table.rate} > 0`),
    check("fx_rate_snapshots_currency_pair", sql`${table.baseCurrency} = 'EUR' AND ${table.quoteCurrency} = 'CNY'`),
    check("fx_rate_snapshots_expiry_order", sql`${table.expiresAt} >= ${table.observedAt} AND ${table.fetchCacheExpiresAt} >= ${table.fetchedAt}`),
    check("fx_rate_snapshots_max_age_bounded", sql`${table.maxAgeHours} >= 24 AND ${table.maxAgeHours} <= 168`),
  ],
);

/** Provider-neutral supplier catalogue. Credentials are deliberately absent. */
export const supplierCatalogueItems = pgTable(
  "supplier_catalogue_items",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    supplierId: uuid("supplier_id").notNull().references(() => suppliers.id, { onDelete: "cascade" }),
    externalProductId: varchar("external_product_id", { length: 255 }).notNull(),
    externalCategoryId: varchar("external_category_id", { length: 255 }),
    title: varchar("title", { length: 500 }).notNull(),
    description: text("description"),
    imageUrls: jsonb("image_urls"),
    originalAmount: numeric("original_amount", { precision: 30, scale: 12 }).notNull(),
    originalCurrency: varchar("original_currency", { length: 3 }).notNull(),
    normalizedEur: numeric("normalized_eur", { precision: 14, scale: 4 }),
    normalizedCurrency: varchar("normalized_currency", { length: 3 }),
    fxRateSnapshotId: uuid("fx_rate_snapshot_id").references(() => fxRateSnapshots.id, { onDelete: "set null" }),
    fxRateUsed: numeric("fx_rate_used", { precision: 20, scale: 12 }),
    fxSource: varchar("fx_source", { length: 80 }),
    fxObservedAt: timestamp("fx_observed_at", { withTimezone: true }),
    fxFetchedAt: timestamp("fx_fetched_at", { withTimezone: true }),
    fxNormalizationError: varchar("fx_normalization_error", { length: 80 }),
    manualSellingPriceEur: numeric("manual_selling_price_eur", { precision: 14, scale: 4 }),
    stock: integer("stock").default(0).notNull(),
    minimumOrderQuantity: integer("minimum_order_quantity").default(1).notNull(),
    supplierRawMoq: jsonb("supplier_raw_moq"),
    state: supplierSyncStateEnum("state").default("Needs review").notNull(),
    needsReview: boolean("needs_review").default(true).notNull(),
    manualCostOverrideEur: numeric("manual_cost_override_eur", { precision: 14, scale: 4 }),
    rawPayload: jsonb("raw_payload"),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("supplier_catalogue_items_supplier_external_unique").on(table.supplierId, table.externalProductId),
    uniqueIndex("supplier_catalogue_items_supplier_id_unique").on(table.supplierId, table.id),
    index("supplier_catalogue_items_supplier_state_idx").on(table.supplierId, table.state),
    index("supplier_catalogue_items_category_idx").on(table.supplierId, table.externalCategoryId),
    index("supplier_catalogue_items_fx_snapshot_idx").on(table.fxRateSnapshotId),
    check("supplier_catalogue_items_amount_nonnegative", sql`${table.originalAmount} >= 0`),
    check("supplier_catalogue_items_stock_nonnegative", sql`${table.stock} >= 0`),
    check("supplier_catalogue_items_moq_positive", sql`${table.minimumOrderQuantity} > 0`),
    check("supplier_catalogue_items_manual_price_nonnegative", sql`${table.manualSellingPriceEur} IS NULL OR ${table.manualSellingPriceEur} >= 0`),
    check("supplier_catalogue_items_currency_valid", sql`length(${table.originalCurrency}) = 3`),
  ],
);

export const supplierCatalogueVariants = pgTable(
  "supplier_catalogue_variants",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    supplierId: uuid("supplier_id").notNull().references(() => suppliers.id, { onDelete: "cascade" }),
    catalogueItemId: uuid("catalogue_item_id").notNull().references(() => supplierCatalogueItems.id, { onDelete: "cascade" }),
    externalVariantId: varchar("external_variant_id", { length: 255 }).notNull(),
    skuCode: varchar("sku_code", { length: 255 }).notNull(),
    title: varchar("title", { length: 500 }),
    attributes: jsonb("attributes"),
    originalAmount: numeric("original_amount", { precision: 30, scale: 12 }).notNull(),
    originalCurrency: varchar("original_currency", { length: 3 }).notNull(),
    normalizedEur: numeric("normalized_eur", { precision: 14, scale: 4 }),
    normalizedCurrency: varchar("normalized_currency", { length: 3 }),
    fxRateSnapshotId: uuid("fx_rate_snapshot_id").references(() => fxRateSnapshots.id, { onDelete: "set null" }),
    fxRateUsed: numeric("fx_rate_used", { precision: 20, scale: 12 }),
    fxSource: varchar("fx_source", { length: 80 }),
    fxObservedAt: timestamp("fx_observed_at", { withTimezone: true }),
    fxFetchedAt: timestamp("fx_fetched_at", { withTimezone: true }),
    fxNormalizationError: varchar("fx_normalization_error", { length: 80 }),
    manualSellingPriceEur: numeric("manual_selling_price_eur", { precision: 14, scale: 4 }),
    stock: integer("stock").default(0).notNull(),
    minimumOrderQuantity: integer("minimum_order_quantity").default(1).notNull(),
    supplierRawMoq: jsonb("supplier_raw_moq"),
    weightKg: numeric("weight_kg", { precision: 10, scale: 3 }),
    imageUrl: text("image_url"),
    state: supplierSyncStateEnum("state").default("Needs review").notNull(),
    needsReview: boolean("needs_review").default(true).notNull(),
    manualCostOverrideEur: numeric("manual_cost_override_eur", { precision: 14, scale: 4 }),
    rawPayload: jsonb("raw_payload"),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("supplier_catalogue_variants_item_external_unique").on(table.catalogueItemId, table.externalVariantId),
    uniqueIndex("supplier_catalogue_variants_supplier_item_unique").on(table.supplierId, table.catalogueItemId, table.id),
    uniqueIndex("supplier_catalogue_variants_item_sku_unique").on(table.catalogueItemId, table.skuCode),
    index("supplier_catalogue_variants_state_idx").on(table.state),
    index("supplier_catalogue_variants_fx_snapshot_idx").on(table.fxRateSnapshotId),
    foreignKey({
      columns: [table.supplierId, table.catalogueItemId],
      foreignColumns: [supplierCatalogueItems.supplierId, supplierCatalogueItems.id],
      name: "supplier_catalogue_variants_supplier_item_fk",
    }).onDelete("cascade"),
    check("supplier_catalogue_variants_amount_nonnegative", sql`${table.originalAmount} >= 0`),
    check("supplier_catalogue_variants_stock_nonnegative", sql`${table.stock} >= 0`),
    check("supplier_catalogue_variants_moq_positive", sql`${table.minimumOrderQuantity} > 0`),
    check("supplier_catalogue_variants_weight_nonnegative", sql`${table.weightKg} IS NULL OR ${table.weightKg} >= 0`),
    check("supplier_catalogue_variants_manual_price_nonnegative", sql`${table.manualSellingPriceEur} IS NULL OR ${table.manualSellingPriceEur} >= 0`),
  ],
);

export const supplierProductLinks = pgTable(
  "supplier_product_links",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    supplierId: uuid("supplier_id").notNull().references(() => suppliers.id, { onDelete: "cascade" }),
    catalogueItemId: uuid("catalogue_item_id").notNull().references(() => supplierCatalogueItems.id, { onDelete: "cascade" }),
    catalogueVariantId: uuid("catalogue_variant_id").references(() => supplierCatalogueVariants.id, { onDelete: "cascade" }),
    productId: uuid("product_id").references(() => products.id, { onDelete: "cascade" }),
    variantId: uuid("variant_id").references(() => productVariants.id, { onDelete: "cascade" }),
    manualSellingPriceEur: numeric("manual_selling_price_eur", { precision: 14, scale: 4 }),
    manualOverride: boolean("manual_override").default(false).notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("supplier_product_links_catalogue_variant_unique").on(table.catalogueVariantId),
    uniqueIndex("supplier_product_links_catalogue_item_product_unique").on(table.catalogueItemId, table.productId).where(sql`${table.catalogueVariantId} IS NULL`),
    index("supplier_product_links_product_idx").on(table.productId, table.variantId),
    foreignKey({
      columns: [table.supplierId, table.catalogueItemId],
      foreignColumns: [supplierCatalogueItems.supplierId, supplierCatalogueItems.id],
      name: "supplier_product_links_supplier_item_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.supplierId, table.catalogueItemId, table.catalogueVariantId],
      foreignColumns: [supplierCatalogueVariants.supplierId, supplierCatalogueVariants.catalogueItemId, supplierCatalogueVariants.id],
      name: "supplier_product_links_supplier_variant_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.variantId, table.productId],
      foreignColumns: [productVariants.id, productVariants.productId],
      name: "supplier_product_links_variant_product_fk",
    }).onDelete("cascade"),
    check("supplier_product_links_target_check", sql`${table.productId} IS NOT NULL`),
    check("supplier_product_links_manual_price_nonnegative", sql`${table.manualSellingPriceEur} IS NULL OR ${table.manualSellingPriceEur} >= 0`),
    check("supplier_product_links_scope_check", sql`(${table.catalogueVariantId} IS NULL AND ${table.variantId} IS NULL AND ${table.productId} IS NOT NULL) OR (${table.catalogueVariantId} IS NOT NULL AND ${table.variantId} IS NOT NULL AND ${table.productId} IS NOT NULL)`),
  ],
);

export const supplierImportRecords = pgTable(
  "supplier_import_records",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    supplierId: uuid("supplier_id").notNull().references(() => suppliers.id, { onDelete: "cascade" }),
    catalogueItemId: uuid("catalogue_item_id").references(() => supplierCatalogueItems.id, { onDelete: "set null" }),
    catalogueVariantId: uuid("catalogue_variant_id"),
    externalProductId: varchar("external_product_id", { length: 255 }).notNull(),
    externalVariantId: varchar("external_variant_id", { length: 255 }),
    productId: uuid("product_id").references(() => products.id, { onDelete: "cascade" }),
    variantId: uuid("variant_id").references(() => productVariants.id, { onDelete: "cascade" }),
    status: varchar("status", { length: 30 }).default("draft").notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("supplier_import_records_supplier_external_parent_unique").on(table.supplierId, table.externalProductId).where(sql`${table.externalVariantId} IS NULL`),
    uniqueIndex("supplier_import_records_supplier_external_variant_unique").on(table.supplierId, table.externalProductId, table.externalVariantId).where(sql`${table.externalVariantId} IS NOT NULL`),
    index("supplier_import_records_product_idx").on(table.productId, table.variantId),
    foreignKey({
      columns: [table.supplierId, table.catalogueItemId],
      foreignColumns: [supplierCatalogueItems.supplierId, supplierCatalogueItems.id],
      name: "supplier_import_records_supplier_item_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.supplierId, table.catalogueItemId, table.catalogueVariantId],
      foreignColumns: [supplierCatalogueVariants.supplierId, supplierCatalogueVariants.catalogueItemId, supplierCatalogueVariants.id],
      name: "supplier_import_records_catalogue_variant_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.variantId, table.productId],
      foreignColumns: [productVariants.id, productVariants.productId],
      name: "supplier_import_records_variant_product_fk",
    }).onDelete("cascade"),
    check("supplier_import_records_scope_check", sql`(${table.externalVariantId} IS NULL AND ${table.catalogueVariantId} IS NULL AND ${table.productId} IS NOT NULL AND ${table.variantId} IS NULL) OR (${table.externalVariantId} IS NOT NULL AND ${table.catalogueVariantId} IS NOT NULL AND ${table.productId} IS NOT NULL AND ${table.variantId} IS NOT NULL)`),
  ],
);

/** Records every controlled supplier media rehosting attempt, including
 * rejected remote assets. A rejected attempt is useful provenance and must not
 * be represented by a fabricated managed-media URL. */
export const supplierMediaRehosting = pgTable(
  "supplier_media_rehosting",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    supplierId: uuid("supplier_id").notNull().references(() => suppliers.id, { onDelete: "cascade" }),
    catalogueItemId: uuid("catalogue_item_id").references(() => supplierCatalogueItems.id, { onDelete: "cascade" }),
    catalogueVariantId: uuid("catalogue_variant_id").references(() => supplierCatalogueVariants.id, { onDelete: "cascade" }),
    productId: uuid("product_id").notNull().references(() => products.id, { onDelete: "cascade" }),
    variantId: uuid("variant_id").references(() => productVariants.id, { onDelete: "cascade" }),
    sourceUrl: text("source_url").notNull(),
    status: varchar("status", { length: 20 }).notNull(),
    failureReason: varchar("failure_reason", { length: 120 }),
    managedUrl: text("managed_url"),
    contentType: varchar("content_type", { length: 80 }),
    sourceSha256: varchar("source_sha256", { length: 64 }),
    ...timestamps,
  },
  (table) => [
    index("supplier_media_rehosting_product_idx").on(table.productId, table.variantId),
    uniqueIndex("supplier_media_rehosting_parent_source_unique").on(table.supplierId, table.catalogueItemId, table.sourceUrl).where(sql`${table.catalogueVariantId} IS NULL`),
    uniqueIndex("supplier_media_rehosting_variant_source_unique").on(table.supplierId, table.catalogueVariantId, table.sourceUrl).where(sql`${table.catalogueVariantId} IS NOT NULL`),
    check("supplier_media_rehosting_status_check", sql`${table.status} IN ('stored','rejected')`),
    check("supplier_media_rehosting_stored_url_check", sql`${table.status} = 'rejected' OR ${table.managedUrl} IS NOT NULL`),
  ],
);

export const supplierSyncRuns = pgTable(
  "supplier_sync_runs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    supplierId: uuid("supplier_id").notNull().references(() => suppliers.id, { onDelete: "cascade" }),
    operation: varchar("operation", { length: 40 }).notNull(),
    status: supplierSyncRunStatusEnum("status").default("running").notNull(),
    keyword: varchar("keyword", { length: 100 }),
    categoryId: varchar("category_id", { length: 255 }),
    pageSize: integer("page_size").default(20).notNull(),
    nextPage: integer("next_page").default(1).notNull(),
    nextCursor: text("next_cursor"),
    pageCount: integer("page_count").default(0).notNull(),
    itemCount: integer("item_count").default(0).notNull(),
    processedCount: integer("processed_count").default(0).notNull(),
    expectedCount: integer("expected_count"),
    expectedPages: integer("expected_pages"),
    errorCount: integer("error_count").default(0).notNull(),
    errorCode: varchar("error_code", { length: 80 }),
    errorMessage: text("error_message"),
    providerEndAuthoritative: boolean("provider_end_authoritative").default(false).notNull(),
    fxRateSnapshotId: uuid("fx_rate_snapshot_id").references(() => fxRateSnapshots.id, { onDelete: "set null" }),
    startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    index("supplier_sync_runs_supplier_started_idx").on(table.supplierId, table.startedAt),
    check("supplier_sync_runs_counts_nonnegative", sql`${table.pageCount} >= 0 AND ${table.itemCount} >= 0 AND ${table.processedCount} >= 0 AND ${table.errorCount} >= 0 AND ${table.nextPage} >= 1`),
  ],
);

export const supplierFxNormalizationRuns = pgTable(
  "supplier_fx_normalization_runs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    supplierId: uuid("supplier_id").notNull().references(() => suppliers.id, { onDelete: "cascade" }),
    supplierSyncRunId: uuid("supplier_sync_run_id").references(() => supplierSyncRuns.id, { onDelete: "set null" }),
    fxRateSnapshotId: uuid("fx_rate_snapshot_id").references(() => fxRateSnapshots.id, { onDelete: "set null" }),
    status: varchar("status", { length: 24 }).notNull(),
    itemCount: integer("item_count").default(0).notNull(),
    variantCount: integer("variant_count").default(0).notNull(),
    errorCode: varchar("error_code", { length: 80 }),
    errorMessage: text("error_message"),
    startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    index("supplier_fx_normalization_runs_supplier_started_idx").on(table.supplierId, table.startedAt),
    index("supplier_fx_normalization_runs_sync_idx").on(table.supplierSyncRunId),
    check("supplier_fx_normalization_runs_status_valid", sql`${table.status} IN ('running','completed','failed')`),
    check("supplier_fx_normalization_runs_counts_nonnegative", sql`${table.itemCount} >= 0 AND ${table.variantCount} >= 0`),
  ],
);

export const supplierSyncHistory = pgTable(
  "supplier_sync_history",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    supplierId: uuid("supplier_id").notNull().references(() => suppliers.id, { onDelete: "cascade" }),
    runId: uuid("run_id").references(() => supplierSyncRuns.id, { onDelete: "set null" }),
    catalogueItemId: uuid("catalogue_item_id").notNull().references(() => supplierCatalogueItems.id, { onDelete: "cascade" }),
    catalogueVariantId: uuid("catalogue_variant_id").references(() => supplierCatalogueVariants.id, { onDelete: "cascade" }),
    previousState: supplierSyncStateEnum("previous_state"),
    nextState: supplierSyncStateEnum("next_state").notNull(),
    previousPayload: jsonb("previous_payload"),
    nextPayload: jsonb("next_payload"),
    changeReason: varchar("change_reason", { length: 100 }),
    createdAt: timestamps.createdAt,
  },
  (table) => [
    index("supplier_sync_history_supplier_created_idx").on(table.supplierId, table.createdAt),
    index("supplier_sync_history_item_idx").on(table.catalogueItemId, table.catalogueVariantId, table.createdAt),
  ],
);

export const supplierCostPriceHistory = pgTable(
  "supplier_cost_price_history",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    supplierId: uuid("supplier_id").notNull().references(() => suppliers.id, { onDelete: "cascade" }),
    catalogueItemId: uuid("catalogue_item_id").references(() => supplierCatalogueItems.id, { onDelete: "cascade" }),
    catalogueVariantId: uuid("catalogue_variant_id").references(() => supplierCatalogueVariants.id, { onDelete: "cascade" }),
    fxRateSnapshotId: uuid("fx_rate_snapshot_id").references(() => fxRateSnapshots.id, { onDelete: "set null" }),
    previousCostCny: numeric("previous_cost_cny", { precision: 30, scale: 12 }),
    nextCostCny: numeric("next_cost_cny", { precision: 30, scale: 12 }),
    previousCostEur: numeric("previous_cost_eur", { precision: 14, scale: 4 }),
    nextCostEur: numeric("next_cost_eur", { precision: 14, scale: 4 }),
    fxRateUsed: numeric("fx_rate_used", { precision: 20, scale: 12 }),
    fxSource: varchar("fx_source", { length: 80 }),
    fxObservedAt: timestamp("fx_observed_at", { withTimezone: true }),
    fxFetchedAt: timestamp("fx_fetched_at", { withTimezone: true }),
    previousPriceEur: numeric("previous_price_eur", { precision: 14, scale: 4 }),
    nextPriceEur: numeric("next_price_eur", { precision: 14, scale: 4 }),
    reason: varchar("reason", { length: 80 }).notNull(),
    createdAt: timestamps.createdAt,
  },
  (table) => [
    index("supplier_cost_price_history_item_idx").on(table.catalogueItemId, table.catalogueVariantId, table.createdAt),
    index("supplier_cost_price_history_fx_snapshot_idx").on(table.fxRateSnapshotId),
  ],
);

export const supplierPrecheckSnapshots = pgTable(
  "supplier_precheck_snapshots",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    supplierId: uuid("supplier_id").notNull().references(() => suppliers.id, { onDelete: "cascade" }),
    taskId: varchar("task_id", { length: 32 }).notNull(),
    clientTaskNo: varchar("client_task_no", { length: 64 }).notNull(),
    status: varchar("status", { length: 20 }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    payload: jsonb("payload").notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("supplier_precheck_snapshots_supplier_task_unique").on(table.supplierId, table.taskId),
    uniqueIndex("supplier_precheck_snapshots_supplier_client_unique").on(table.supplierId, table.clientTaskNo),
    index("supplier_precheck_snapshots_expiry_idx").on(table.expiresAt),
  ],
);

export const tooniesProcurementAttempts = pgTable(
  "toonies_procurement_attempts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orderId: uuid("order_id").references(() => orders.id, { onDelete: "set null" }),
    supplierId: uuid("supplier_id").notNull().references(() => suppliers.id, { onDelete: "cascade" }),
    actorAdminId: uuid("actor_admin_id").references(() => users.id, { onDelete: "set null" }),
    clientTaskNo: varchar("client_task_no", { length: 64 }).notNull(),
    generation: integer("generation").notNull().default(1),
    taskId: varchar("task_id", { length: 32 }),
    state: varchar("state", { length: 32 }).notNull().default("created"),
    requestFingerprint: varchar("request_fingerprint", { length: 64 }).notNull(),
    rawSnapshot: jsonb("raw_snapshot"),
    failureCode: integer("failure_code"),
    failureMessage: varchar("failure_message", { length: 1000 }),
    snapshotExpiresAt: timestamp("snapshot_expires_at", { withTimezone: true }),
    nextPollAt: timestamp("next_poll_at", { withTimezone: true }),
    pollCount: integer("poll_count").notNull().default(0),
    maxPolls: integer("max_polls").notNull().default(30),
    retryCount: integer("retry_count").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(5),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    leaseToken: varchar("lease_token", { length: 64 }),
    apiOrderSn: varchar("api_order_sn", { length: 128 }),
    tooniesOrderSn: varchar("toonies_order_sn", { length: 128 }),
    tradeOrderSn: varchar("trade_order_sn", { length: 128 }),
    settlementStatus: varchar("settlement_status", { length: 32 }),
    settledCnyProductAmount: numeric("settled_cny_product_amount", { precision: 20, scale: 6 }),
    freightStatus: varchar("freight_status", { length: 32 }),
    freightAmountCny: numeric("freight_amount_cny", { precision: 20, scale: 6 }),
    supplierOrderStatus: varchar("supplier_order_status", { length: 64 }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("toonies_procurement_attempts_supplier_client_unique").on(table.supplierId, table.clientTaskNo),
    uniqueIndex("toonies_procurement_attempts_supplier_fingerprint_generation_unique").on(table.supplierId, table.requestFingerprint, table.generation),
    uniqueIndex("toonies_procurement_attempts_supplier_task_unique").on(table.supplierId, table.taskId).where(sql`${table.taskId} IS NOT NULL`),
    index("toonies_procurement_attempts_order_idx").on(table.orderId, table.createdAt),
    index("toonies_procurement_attempts_poll_idx").on(table.state, table.nextPollAt),
    check("toonies_procurement_attempts_state_valid_v2", sql`${table.state} IN ('created','validating','precheck_pending','task_pending','ready','cost_hold','failed','expired','retry_wait')`),
    check("toonies_procurement_attempts_poll_nonnegative", sql`${table.pollCount} >= 0 AND ${table.maxPolls} > 0 AND ${table.retryCount} >= 0 AND ${table.maxAttempts} > 0 AND ${table.generation} > 0`),
  ],
);

/** Durable financial submission journal. Request identity is immutable once
 * allocated; ambiguous rows are never reset to not_submitted. */
export const tooniesProcurementCommands = pgTable(
  "toonies_procurement_commands",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orderId: uuid("order_id").notNull().unique().references(() => orders.id, { onDelete: "cascade" }),
    orderTotalFingerprint: varchar("order_total_fingerprint", { length: 64 }).notNull(),
    supplierSnapshotFingerprint: varchar("supplier_snapshot_fingerprint", { length: 64 }).notNull(),
    state: varchar("state", { length: 24 }).notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(5),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    leaseToken: varchar("lease_token", { length: 64 }),
    lastError: varchar("last_error", { length: 1000 }),
    ...timestamps,
  },
  (table) => [
    index("toonies_procurement_commands_due_idx").on(table.state, table.nextAttemptAt),
    check("toonies_procurement_commands_state_valid", sql`${table.state} IN ('pending','processing','completed','failed')`),
    check("toonies_procurement_commands_attempts_valid", sql`${table.attempts} >= 0 AND ${table.maxAttempts} > 0 AND ${table.attempts} <= ${table.maxAttempts}`),
  ],
);

export const tooniesSettlements = pgTable(
  "toonies_settlements",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orderId: uuid("order_id").notNull().references(() => orders.id, { onDelete: "cascade" }),
    commandId: uuid("command_id").notNull().references(() => tooniesProcurementCommands.id, { onDelete: "restrict" }),
    attemptId: uuid("attempt_id").notNull().references(() => tooniesProcurementAttempts.id, { onDelete: "restrict" }),
    supplierId: uuid("supplier_id").notNull().references(() => suppliers.id, { onDelete: "restrict" }),
    generation: integer("generation").notNull(),
    taskId: varchar("task_id", { length: 32 }).notNull(),
    apiOrderSn: varchar("api_order_sn", { length: 64 }).notNull(),
    canonicalRequest: jsonb("canonical_request").notNull(),
    canonicalBasket: jsonb("canonical_basket").notNull(),
    expectedProductSum: numeric("expected_product_sum", { precision: 20, scale: 6 }).notNull(),
    expectedShippingFee: numeric("expected_shipping_fee", { precision: 20, scale: 6 }).notNull(),
    expectedTotalSum: numeric("expected_total_sum", { precision: 20, scale: 6 }).notNull(),
    requestHash: varchar("request_hash", { length: 64 }).notNull(),
    basketFingerprint: varchar("basket_fingerprint", { length: 64 }).notNull(),
    destinationFingerprint: varchar("destination_fingerprint", { length: 64 }).notNull(),
    orderTotalFingerprint: varchar("order_total_fingerprint", { length: 64 }).notNull(),
    supplierSnapshotFingerprint: varchar("supplier_snapshot_fingerprint", { length: 64 }).notNull(),
    state: tooniesSettlementStateEnum("state").default("not_submitted").notNull(),
    confirmationKind: tooniesSettlementConfirmationKindEnum("confirmation_kind"),
    leaseToken: varchar("lease_token", { length: 64 }),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    version: integer("version").default(0).notNull(),
    firstSubmissionAt: timestamp("first_submission_at", { withTimezone: true }),
    lastTransmissionAt: timestamp("last_transmission_at", { withTimezone: true }),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    transmissionCount: integer("transmission_count").default(0).notNull(),
    reconciliationCount: integer("reconciliation_count").default(0).notNull(),
    nextReconciliationAt: timestamp("next_reconciliation_at", { withTimezone: true }),
    reconciliationSource: varchar("reconciliation_source", { length: 32 }),
    reconciliationPage: integer("reconciliation_page"),
    reconciliationDateStart: timestamp("reconciliation_date_start", { withTimezone: true }),
    reconciliationDateEnd: timestamp("reconciliation_date_end", { withTimezone: true }),
    reconciliationExhausted: boolean("reconciliation_exhausted").default(false).notNull(),
    orderSn: varchar("order_sn", { length: 128 }),
    tradeOrderSn: varchar("trade_order_sn", { length: 128 }),
    supplierStatus: varchar("supplier_status", { length: 64 }),
    payStatus: varchar("pay_status", { length: 64 }),
    currency: varchar("currency", { length: 3 }),
    productSum: numeric("product_sum", { precision: 20, scale: 6 }),
    shippingFee: numeric("shipping_fee", { precision: 20, scale: 6 }),
    totalSum: numeric("total_sum", { precision: 20, scale: 6 }),
    totalWeight: numeric("total_weight", { precision: 20, scale: 6 }),
    responseEvidence: jsonb("response_evidence"),
    failureCode: integer("failure_code"),
    failureMessage: varchar("failure_message", { length: 2000 }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("toonies_settlements_attempt_generation_unique").on(table.attemptId, table.generation),
    uniqueIndex("toonies_settlements_supplier_api_order_unique").on(table.supplierId, table.apiOrderSn),
    uniqueIndex("toonies_settlements_order_unresolved_unique").on(table.orderId).where(sql`${table.state} IN ('not_submitted','submitting','transmitted_unknown','reconciling','replay_pending','confirmed','manual_review')`),
    index("toonies_settlements_order_state_idx").on(table.orderId, table.state),
    index("toonies_settlements_recovery_idx").on(table.state, table.nextReconciliationAt),
    check("toonies_settlements_generation_positive", sql`${table.generation} > 0`),
    check("toonies_settlements_version_nonnegative", sql`${table.version} >= 0`),
    check("toonies_settlements_transmission_nonnegative", sql`${table.transmissionCount} >= 0`),
    check("toonies_settlements_api_order_format", sql`${table.apiOrderSn} ~ '^[A-Za-z0-9_-]{1,64}$'`),
    check("toonies_settlements_confirmed_facts", sql`${table.state} <> 'confirmed' OR (${table.orderSn} IS NOT NULL AND ${table.currency} = 'CNY' AND ${table.confirmationKind} IS NOT NULL)`),
    check("toonies_settlements_expected_amounts_nonnegative", sql`${table.expectedProductSum} >= 0 AND ${table.expectedShippingFee} >= 0 AND ${table.expectedTotalSum} >= 0`),
  ],
);

export const tooniesSettlementEvidence = pgTable(
  "toonies_settlement_evidence",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    settlementId: uuid("settlement_id").notNull().references(() => tooniesSettlements.id, { onDelete: "restrict" }),
    eventType: varchar("event_type", { length: 64 }).notNull(),
    fromState: tooniesSettlementStateEnum("from_state"),
    toState: tooniesSettlementStateEnum("to_state"),
    requestHash: varchar("request_hash", { length: 64 }),
    responseHash: varchar("response_hash", { length: 64 }),
    errorCode: integer("error_code"),
    details: jsonb("details"),
    createdAt: timestamps.createdAt,
  },
  (table) => [index("toonies_settlement_evidence_settlement_idx").on(table.settlementId, table.createdAt)],
);

/** Durable order-level interlock for contradictory customer/supplier financial effects. */
export const financialOperationReservations = pgTable(
  "financial_operation_reservations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orderId: uuid("order_id").notNull().references(() => orders.id, { onDelete: "cascade" }),
    operationType: financialOperationTypeEnum("operation_type").notNull(),
    operationReferenceId: varchar("operation_reference_id", { length: 128 }).notNull(),
    state: financialOperationStateEnum("state").default("active").notNull(),
    phase: varchar("phase", { length: 24 }).default("reserved").notNull(),
    transmissionStartedAt: timestamp("transmission_started_at", { withTimezone: true }),
    leaseToken: varchar("lease_token", { length: 64 }),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    version: integer("version").default(0).notNull(),
    failureCode: varchar("failure_code", { length: 80 }),
    failureMessage: varchar("failure_message", { length: 2000 }),
    recoveryEvidence: jsonb("recovery_evidence"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("financial_operation_reservations_reference_unique").on(table.operationType, table.operationReferenceId),
    uniqueIndex("financial_operation_reservations_order_active_unique").on(table.orderId).where(sql`${table.state} IN ('active','ambiguous','completed')`),
    index("financial_operation_reservations_order_idx").on(table.orderId, table.createdAt),
    check("financial_operation_reservations_version_nonnegative", sql`${table.version} >= 0`),
  ],
);

/** Worker-owned, full-refund-only supplier non-fulfilment saga.  This table
 * intentionally contains immutable payment and supplier evidence snapshots;
 * it must never be created by a customer-facing request. */
export const supplierFailureReversals = pgTable(
  "supplier_failure_reversals",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orderId: uuid("order_id").notNull().unique().references(() => orders.id, { onDelete: "restrict" }),
    paymentId: uuid("payment_id").notNull().references(() => payments.id, { onDelete: "restrict" }),
    attemptId: uuid("attempt_id").notNull().references(() => tooniesProcurementAttempts.id, { onDelete: "restrict" }),
    operationReservationId: uuid("operation_reservation_id").references(() => financialOperationReservations.id, { onDelete: "restrict" }),
    refundId: uuid("refund_id").references(() => refunds.id, { onDelete: "restrict" }),
    state: supplierFailureReversalStateEnum("state").default("eligible").notNull(),
    reasonCode: varchar("reason_code", { length: 64 }).notNull(),
    evidenceSnapshot: jsonb("evidence_snapshot").notNull(),
    evidenceHash: varchar("evidence_hash", { length: 64 }).notNull(),
    paymentAmount: money("payment_amount").notNull(),
    paymentCurrency: varchar("payment_currency", { length: 3 }).notNull(),
    providerRefundIdentity: varchar("provider_refund_identity", { length: 200 }).notNull(),
    providerRefundReference: varchar("provider_refund_reference", { length: 200 }),
    leaseToken: varchar("lease_token", { length: 64 }),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    version: integer("version").default(0).notNull(),
    transmissionStartedAt: timestamp("transmission_started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    lastError: varchar("last_error", { length: 2000 }),
    recoveryEvidence: jsonb("recovery_evidence"),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("supplier_failure_reversals_refund_identity_unique").on(table.providerRefundIdentity),
    index("supplier_failure_reversals_due_idx").on(table.state, table.leaseUntil),
    check("supplier_failure_reversals_amount_nonnegative", sql`${table.paymentAmount} >= 0`),
    check("supplier_failure_reversals_version_nonnegative", sql`${table.version} >= 0`),
    check("supplier_failure_reversals_currency_valid", sql`length(${table.paymentCurrency}) = 3`),
  ],
);

export const tooniesProcurementLines = pgTable(
  "toonies_procurement_lines",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    attemptId: uuid("attempt_id").notNull().references(() => tooniesProcurementAttempts.id, { onDelete: "cascade" }),
    productId: uuid("product_id").notNull().references(() => products.id, { onDelete: "restrict" }),
    variantId: uuid("variant_id").references(() => productVariants.id, { onDelete: "restrict" }),
    catalogueItemId: uuid("catalogue_item_id").notNull().references(() => supplierCatalogueItems.id, { onDelete: "restrict" }),
    catalogueVariantId: uuid("catalogue_variant_id").references(() => supplierCatalogueVariants.id, { onDelete: "restrict" }),
    productCode: varchar("product_code", { length: 255 }).notNull(),
    skuCode: varchar("sku_code", { length: 255 }).notNull(),
    requestedQuantity: integer("requested_quantity").notNull(),
    returnedQuantity: integer("returned_quantity"),
    returnedMoq: integer("returned_moq"),
    returnedStock: integer("returned_stock"),
    returnedChargeCny: numeric("returned_charge_cny", { precision: 20, scale: 6 }),
    returnedSubtotalCny: numeric("returned_subtotal_cny", { precision: 20, scale: 6 }),
    expectedUnitCostCny: numeric("expected_unit_cost_cny", { precision: 30, scale: 12 }),
    expectedSubtotalCny: numeric("expected_subtotal_cny", { precision: 30, scale: 12 }),
    costThresholdPercent: numeric("cost_threshold_percent", { precision: 12, scale: 6 }),
    returnedCostVarianceCny: numeric("returned_cost_variance_cny", { precision: 30, scale: 12 }),
    returnedWeightKg: numeric("returned_weight_kg", { precision: 20, scale: 6 }),
    orderable: boolean("orderable"),
    failureCode: integer("failure_code"),
    failureMessage: varchar("failure_message", { length: 1000 }),
    rawSnapshot: jsonb("raw_snapshot"),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("toonies_procurement_lines_attempt_product_sku_unique").on(table.attemptId, table.productCode, table.skuCode),
    index("toonies_procurement_lines_attempt_idx").on(table.attemptId),
    check("toonies_procurement_lines_quantity_valid", sql`${table.requestedQuantity} > 0`),
  ],
);

export const tooniesProcurementEvents = pgTable(
  "toonies_procurement_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    attemptId: uuid("attempt_id").notNull().references(() => tooniesProcurementAttempts.id, { onDelete: "cascade" }),
    actorAdminId: uuid("actor_admin_id").references(() => users.id, { onDelete: "set null" }),
    fromState: varchar("from_state", { length: 32 }),
    toState: varchar("to_state", { length: 32 }).notNull(),
    eventType: varchar("event_type", { length: 64 }).notNull(),
    errorCode: integer("error_code"),
    details: jsonb("details"),
    createdAt: timestamps.createdAt,
  },
  (table) => [index("toonies_procurement_events_attempt_idx").on(table.attemptId, table.createdAt)],
);

export const supplierPricingRules = pgTable(
  "supplier_pricing_rules",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    supplierId: uuid("supplier_id").notNull().references(() => suppliers.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 150 }).notNull(),
    ruleType: supplierPricingRuleTypeEnum("rule_type").notNull(),
    minCostEur: numeric("min_cost_eur", { precision: 14, scale: 4 }).default("0").notNull(),
    maxCostEur: numeric("max_cost_eur", { precision: 14, scale: 4 }),
    value: numeric("value", { precision: 12, scale: 4 }).notNull(),
    roundingMode: supplierRoundingModeEnum("rounding_mode").default("none").notNull(),
    priority: integer("priority").default(0).notNull(),
    active: boolean("active").default(true).notNull(),
    significantCostIncreasePercent: numeric("significant_cost_increase_percent", { precision: 6, scale: 2 }).default("20").notNull(),
    ...timestamps,
  },
  (table) => [
    index("supplier_pricing_rules_supplier_active_idx").on(table.supplierId, table.active, table.priority),
    check("supplier_pricing_rules_value_nonnegative", sql`${table.value} >= 0`),
    check("supplier_pricing_rules_cost_band_valid", sql`${table.minCostEur} >= 0 AND (${table.maxCostEur} IS NULL OR ${table.maxCostEur} > ${table.minCostEur})`),
    check("supplier_pricing_rules_significant_increase_valid", sql`${table.significantCostIncreasePercent} >= 0`),
  ],
);

export const supplierShippingRules = pgTable(
  "supplier_shipping_rules",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    supplierId: uuid("supplier_id").notNull().references(() => suppliers.id, { onDelete: "cascade" }),
    countryCode: varchar("country_code", { length: 2 }),
    destinationZoneId: uuid("destination_zone_id"),
    // Retained only to permit safe migration of the original temporary API.
    // New writes must use countryCode or destinationZoneId.
    zone: varchar("zone", { length: 80 }),
    minWeightKg: numeric("min_weight_kg", { precision: 10, scale: 3 }).default("0").notNull(),
    maxWeightKg: numeric("max_weight_kg", { precision: 10, scale: 3 }),
    amountEur: numeric("amount_eur", { precision: 12, scale: 2 }).notNull(),
    minDeliveryDays: integer("min_delivery_days"),
    maxDeliveryDays: integer("max_delivery_days"),
    temporary: boolean("temporary").default(true).notNull(),
    active: boolean("active").default(true).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    index("supplier_shipping_rules_lookup_idx").on(table.supplierId, table.countryCode, table.active, table.minWeightKg),
    index("supplier_shipping_rules_destination_zone_idx").on(table.supplierId, table.destinationZoneId, table.active, table.minWeightKg),
    check("supplier_shipping_rules_destination_xor", sql`((${table.countryCode} IS NOT NULL AND ${table.destinationZoneId} IS NULL) OR (${table.countryCode} IS NULL AND ${table.destinationZoneId} IS NOT NULL))`),
    check("supplier_shipping_rules_weight_valid", sql`${table.minWeightKg} >= 0 AND (${table.maxWeightKg} IS NULL OR ${table.maxWeightKg} > ${table.minWeightKg})`),
    check("supplier_shipping_rules_amount_nonnegative", sql`${table.amountEur} >= 0`),
    check("supplier_shipping_rules_temporary_only", sql`${table.temporary} = true`),
    check("supplier_shipping_rules_delivery_valid", sql`(${table.minDeliveryDays} IS NULL OR ${table.minDeliveryDays} >= 0) AND (${table.maxDeliveryDays} IS NULL OR ${table.maxDeliveryDays} >= 0) AND (${table.maxDeliveryDays} IS NULL OR ${table.minDeliveryDays} IS NULL OR ${table.maxDeliveryDays} >= ${table.minDeliveryDays})`),
  ],
);

export const products = pgTable(
  "products",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    name: varchar("name", { length: 250 }).notNull(),
    slug: varchar("slug", { length: 280 }).notNull(),
    seoTitle: varchar("seo_title", { length: 70 }),
    seoDescription: varchar("seo_description", { length: 170 }),
    parentSku: varchar("parent_sku", { length: 100 }).notNull(),
    barcode: varchar("barcode", { length: 100 }),
    brandId: uuid("brand_id").references(() => brands.id, { onDelete: "set null" }),
    categoryId: uuid("category_id").notNull().references(() => categories.id, { onDelete: "restrict" }),
    shortDescription: text("short_description"),
    description: text("description").notNull(),
    status: productStatusEnum("status").default("draft").notNull(),
    costPrice: money("cost_price").notNull(),
    basePrice: money("base_price").notNull(),
    vatRate: numeric("vat_rate", { precision: 5, scale: 2 }).notNull(),
    taxMode: varchar("tax_mode", { length: 16 }).default("inclusive").notNull(),
    vatClassifiedAt: timestamp("vat_classified_at", { withTimezone: true }),
    weight: numeric("weight", { precision: 10, scale: 3 }).notNull(),
    displayWeightKg: numeric("display_weight_kg", { precision: 10, scale: 3 }),
    minimumOrderQuantity: integer("minimum_order_quantity").default(1).notNull(),
    width: numeric("width", { precision: 10, scale: 3 }),
    height: numeric("height", { precision: 10, scale: 3 }),
    length: numeric("length", { precision: 10, scale: 3 }),
    featured: boolean("featured").default(false).notNull(),
    newArrival: boolean("new_arrival").default(false).notNull(),
    homepageWholesale: boolean("homepage_wholesale").default(false).notNull(),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("products_slug_unique").on(table.slug),
    uniqueIndex("products_parent_sku_unique").on(table.parentSku),
    uniqueIndex("products_barcode_unique").on(table.barcode),
    index("products_category_idx").on(table.categoryId),
    index("products_brand_idx").on(table.brandId),
    index("products_status_idx").on(table.status),
    index("products_featured_idx").on(table.featured),
    index("products_featured_public_homepage_idx").on(table.updatedAt.desc(), table.id)
      .where(sql`${table.featured} = true AND ${table.status} = 'active' AND ${table.publishedAt} IS NOT NULL`),
    index("products_new_arrival_idx").on(table.newArrival),
    index("products_homepage_wholesale_idx").on(table.homepageWholesale),
    index("products_homepage_wholesale_public_idx").on(table.updatedAt.desc(), table.id)
      .where(sql`${table.homepageWholesale} = true AND ${table.status} = 'active' AND ${table.publishedAt} IS NOT NULL`),
    index("products_created_at_idx").on(table.createdAt),
    check("products_cost_price_nonnegative", sql`${table.costPrice} >= 0`),
    check("products_base_price_nonnegative", sql`${table.basePrice} >= 0`),
    check("products_vat_rate_valid", sql`${table.vatRate} >= 0 AND ${table.vatRate} <= 100`),
    check("products_tax_mode_valid", sql`${table.taxMode} IN ('inclusive','exclusive')`),
    check("products_weight_nonnegative", sql`${table.weight} >= 0`),
    check("products_display_weight_positive", sql`${table.displayWeightKg} IS NULL OR ${table.displayWeightKg} > 0`),
    check("products_moq_positive", sql`${table.minimumOrderQuantity} > 0`),
    check("products_dimensions_nonnegative", sql`
      (${table.width} IS NULL OR ${table.width} >= 0)
      AND (${table.height} IS NULL OR ${table.height} >= 0)
      AND (${table.length} IS NULL OR ${table.length} >= 0)
    `),
  ],
);

export const supplierPriceChangeReviews = pgTable(
  "supplier_price_change_reviews",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    supplierId: uuid("supplier_id").notNull().references(() => suppliers.id, { onDelete: "cascade" }),
    catalogueItemId: uuid("catalogue_item_id").notNull().references(() => supplierCatalogueItems.id, { onDelete: "cascade" }),
    catalogueVariantId: uuid("catalogue_variant_id").references(() => supplierCatalogueVariants.id, { onDelete: "cascade" }),
    productId: uuid("product_id").notNull().references(() => products.id, { onDelete: "cascade" }),
    variantId: uuid("variant_id").references(() => productVariants.id, { onDelete: "cascade" }),
    historyId: uuid("history_id").notNull().references(() => supplierCostPriceHistory.id, { onDelete: "restrict" }),
    pricingRuleId: uuid("pricing_rule_id").references(() => supplierPricingRules.id, { onDelete: "set null" }),
    pricingRuleType: varchar("pricing_rule_type", { length: 30 }),
    pricingRuleValue: numeric("pricing_rule_value", { precision: 14, scale: 4 }),
    pricingRoundingMode: varchar("pricing_rounding_mode", { length: 20 }),
    pricingMinCostEur: numeric("pricing_min_cost_eur", { precision: 14, scale: 4 }),
    pricingMaxCostEur: numeric("pricing_max_cost_eur", { precision: 14, scale: 4 }),
    status: varchar("status", { length: 20 }).default("pending").notNull(),
    previousCostEur: numeric("previous_cost_eur", { precision: 14, scale: 4 }).notNull(),
    proposedCostEur: numeric("proposed_cost_eur", { precision: 14, scale: 4 }).notNull(),
    previousPriceEur: numeric("previous_price_eur", { precision: 14, scale: 4 }).notNull(),
    formulaPriceEur: numeric("formula_price_eur", { precision: 14, scale: 4 }),
    manualOverrideEur: numeric("manual_override_eur", { precision: 14, scale: 4 }),
    manualOverrideSource: varchar("manual_override_source", { length: 20 }),
    proposedPriceEur: numeric("proposed_price_eur", { precision: 14, scale: 4 }).notNull(),
    increasePercent: numeric("increase_percent", { precision: 12, scale: 4 }).notNull(),
    thresholdPercent: numeric("threshold_percent", { precision: 6, scale: 2 }).notNull(),
    reason: varchar("reason", { length: 80 }).default("significant_supplier_cost_increase").notNull(),
    fxRateSnapshotId: uuid("fx_rate_snapshot_id").references(() => fxRateSnapshots.id, { onDelete: "set null" }),
    detectedAt: timestamp("detected_at", { withTimezone: true }).defaultNow().notNull(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolvedByAdminId: uuid("resolved_by_admin_id").references(() => users.id, { onDelete: "set null" }),
    decisionNote: text("decision_note"),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("supplier_price_change_reviews_history_unique").on(table.historyId),
    uniqueIndex("supplier_price_change_reviews_one_pending_scope")
      .on(table.catalogueItemId, table.catalogueVariantId)
      .where(sql`${table.status} = 'pending' AND ${table.catalogueVariantId} IS NOT NULL`),
    uniqueIndex("supplier_price_change_reviews_one_pending_item_scope")
      .on(table.catalogueItemId)
      .where(sql`${table.status} = 'pending' AND ${table.catalogueVariantId} IS NULL`),
    index("supplier_price_change_reviews_pending_idx").on(table.supplierId, table.status, table.detectedAt),
    check("supplier_price_change_reviews_status", sql`${table.status} IN ('pending','accepted','rejected','superseded')`),
    check("supplier_price_change_reviews_scope", sql`(${table.catalogueVariantId} IS NULL AND ${table.variantId} IS NULL) OR (${table.catalogueVariantId} IS NOT NULL AND ${table.variantId} IS NOT NULL)`),
    check("supplier_price_change_reviews_values", sql`${table.previousCostEur} >= 0 AND ${table.proposedCostEur} >= 0 AND ${table.previousPriceEur} >= 0 AND ${table.proposedPriceEur} >= 0 AND ${table.increasePercent} >= 0 AND ${table.thresholdPercent} >= 0`),
    check("supplier_price_change_reviews_rule_type", sql`${table.pricingRuleType} IS NULL OR ${table.pricingRuleType} IN ('markup_percent','markup_fixed','margin_percent')`),
    check("supplier_price_change_reviews_rounding_mode", sql`${table.pricingRoundingMode} IS NULL OR ${table.pricingRoundingMode} IN ('none','whole','99')`),
    check("supplier_price_change_reviews_override_source", sql`${table.manualOverrideSource} IS NULL OR ${table.manualOverrideSource} IN ('link','variant','item')`),
    check("supplier_price_change_reviews_override_pair", sql`(${table.manualOverrideEur} IS NULL AND ${table.manualOverrideSource} IS NULL) OR (${table.manualOverrideEur} IS NOT NULL AND ${table.manualOverrideSource} IS NOT NULL)`),
    check("supplier_price_change_reviews_provenance_values", sql`(${table.formulaPriceEur} IS NULL OR ${table.formulaPriceEur} >= 0) AND (${table.manualOverrideEur} IS NULL OR ${table.manualOverrideEur} >= 0)`),
  ],
);

export const slugRedirects = pgTable(
  "slug_redirects",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    entityType: varchar("entity_type", { length: 20 }).notNull(),
    entityId: uuid("entity_id").notNull(),
    oldSlug: varchar("old_slug", { length: 280 }).notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("slug_redirects_entity_type_old_slug_unique").on(table.entityType, table.oldSlug),
    index("slug_redirects_entity_idx").on(table.entityType, table.entityId),
    check("slug_redirects_entity_type_check", sql`${table.entityType} IN ('product', 'category', 'brand')`),
  ],
);

export const productVariants = pgTable(
  "product_variants",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    productId: uuid("product_id").notNull().references(() => products.id, { onDelete: "cascade" }),
    sku: varchar("sku", { length: 100 }).notNull(),
    barcode: varchar("barcode", { length: 100 }),
    title: varchar("title", { length: 200 }).notNull(),
    costPrice: money("cost_price"),
    basePrice: money("base_price"),
    weight: numeric("weight", { precision: 10, scale: 3 }),
    minimumOrderQuantity: integer("minimum_order_quantity").default(1).notNull(),
    active: boolean("active").default(true).notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("product_variants_id_product_unique").on(table.id, table.productId),
    uniqueIndex("product_variants_sku_unique").on(table.sku),
    uniqueIndex("product_variants_barcode_unique").on(table.barcode),
    index("product_variants_product_idx").on(table.productId),
    index("product_variants_active_idx").on(table.active),
    index("product_variants_active_product_idx").on(table.productId, table.id).where(sql`${table.active} = true`),
    check("product_variants_cost_nonnegative", sql`${table.costPrice} IS NULL OR ${table.costPrice} >= 0`),
    check("product_variants_base_nonnegative", sql`${table.basePrice} IS NULL OR ${table.basePrice} >= 0`),
    check("product_variants_weight_nonnegative", sql`${table.weight} IS NULL OR ${table.weight} >= 0`),
    check("product_variants_moq_positive", sql`${table.minimumOrderQuantity} > 0`),
  ],
);

export const productAttributes = pgTable(
  "product_attributes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    name: varchar("name", { length: 100 }).notNull(),
    slug: varchar("slug", { length: 120 }).notNull(),
    ...timestamps,
  },
  (table) => [uniqueIndex("product_attributes_slug_unique").on(table.slug)],
);

export const attributeValues = pgTable(
  "attribute_values",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    attributeId: uuid("attribute_id").notNull().references(() => productAttributes.id, { onDelete: "cascade" }),
    value: varchar("value", { length: 150 }).notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("attribute_values_id_attribute_unique").on(table.id, table.attributeId),
    uniqueIndex("attribute_values_attribute_value_unique").on(table.attributeId, table.value),
    index("attribute_values_attribute_idx").on(table.attributeId),
  ],
);

export const variantAttributeValues = pgTable(
  "variant_attribute_values",
  {
    variantId: uuid("variant_id").notNull().references(() => productVariants.id, { onDelete: "cascade" }),
    attributeId: uuid("attribute_id").notNull().references(() => productAttributes.id, { onDelete: "cascade" }),
    attributeValueId: uuid("attribute_value_id").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.variantId, table.attributeValueId] }),
    uniqueIndex("variant_attribute_values_variant_attribute_unique").on(table.variantId, table.attributeId),
    index("variant_attribute_values_value_idx").on(table.attributeValueId),
    foreignKey({
      columns: [table.attributeValueId, table.attributeId],
      foreignColumns: [attributeValues.id, attributeValues.attributeId],
      name: "variant_attribute_values_value_attribute_fk",
    }).onDelete("cascade"),
  ],
);

export const productMedia = pgTable(
  "product_media",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    productId: uuid("product_id").notNull().references(() => products.id, { onDelete: "cascade" }),
    variantId: uuid("variant_id").references(() => productVariants.id, { onDelete: "cascade" }),
    type: mediaTypeEnum("type").notNull(),
    url: text("url").notNull(),
    altText: text("alt_text"),
    isPrimary: boolean("is_primary").default(false).notNull(),
    sortOrder: integer("sort_order").default(0).notNull(),
    sourceUrl: text("source_url"),
    sourceSha256: varchar("source_sha256", { length: 64 }),
    sourceWorkflow: varchar("source_workflow", { length: 80 }),
    sourceSupplierId: uuid("source_supplier_id").references(() => suppliers.id, { onDelete: "set null" }),
    sourceCatalogueItemId: uuid("source_catalogue_item_id").references(() => supplierCatalogueItems.id, { onDelete: "set null" }),
    sourceCatalogueVariantId: uuid("source_catalogue_variant_id").references(() => supplierCatalogueVariants.id, { onDelete: "set null" }),
    createdAt: timestamps.createdAt,
  },
  (table) => [
    index("product_media_product_idx").on(table.productId, table.sortOrder),
    index("product_media_variant_idx").on(table.variantId),
    uniqueIndex("product_media_primary_product_unique").on(table.productId)
      .where(sql`${table.type} = 'image' AND ${table.isPrimary} = true AND ${table.variantId} IS NULL`),
    uniqueIndex("product_media_primary_variant_unique").on(table.productId, table.variantId)
      .where(sql`${table.type} = 'image' AND ${table.isPrimary} = true AND ${table.variantId} IS NOT NULL`),
    uniqueIndex("product_media_toonies_parent_source_unique").on(table.productId, table.sourceWorkflow, table.sourceUrl)
      .where(sql`${table.variantId} IS NULL AND ${table.sourceWorkflow} IS NOT NULL AND ${table.sourceUrl} IS NOT NULL`),
    uniqueIndex("product_media_toonies_variant_source_unique").on(table.productId, table.variantId, table.sourceWorkflow, table.sourceUrl)
      .where(sql`${table.variantId} IS NOT NULL AND ${table.sourceWorkflow} IS NOT NULL AND ${table.sourceUrl} IS NOT NULL`),
    foreignKey({
      columns: [table.variantId, table.productId],
      foreignColumns: [productVariants.id, productVariants.productId],
      name: "product_media_variant_product_fk",
    }).onDelete("cascade"),
    check("product_media_sort_order_nonnegative", sql`${table.sortOrder} >= 0`),
  ],
);

export const mediaCleanupJobs = pgTable(
  "media_cleanup_jobs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    url: text("url").notNull().unique(),
    reason: varchar("reason", { length: 100 }).notNull(),
    status: varchar("status", { length: 20 }).default("pending").notNull(),
    attempts: integer("attempts").default(0).notNull(),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).defaultNow().notNull(),
    lastError: text("last_error"),
    createdAt: timestamps.createdAt,
    updatedAt: timestamps.updatedAt,
  },
  (table) => [
    index("media_cleanup_jobs_due_idx").on(table.status, table.nextAttemptAt),
    check("media_cleanup_jobs_status_check", sql`${table.status} IN ('pending','processing','failed','completed')`),
    check("media_cleanup_jobs_attempts_nonnegative", sql`${table.attempts} >= 0`),
  ],
);

export const priceTiers = pgTable(
  "price_tiers",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    productId: uuid("product_id").references(() => products.id, { onDelete: "cascade" }),
    variantId: uuid("variant_id").references(() => productVariants.id, { onDelete: "cascade" }),
    minQuantity: integer("min_quantity").notNull(),
    maxQuantity: integer("max_quantity"),
    unitPrice: money("unit_price").notNull(),
    active: boolean("active").default(true).notNull(),
    ...timestamps,
  },
  (table) => [
    index("price_tiers_product_idx").on(table.productId, table.minQuantity),
    index("price_tiers_variant_idx").on(table.variantId, table.minQuantity),
    index("price_tiers_active_product_homepage_idx").on(table.productId, table.minQuantity, table.unitPrice)
      .where(sql`${table.active} = true AND ${table.variantId} IS NULL`),
    index("price_tiers_active_variant_homepage_idx").on(table.variantId, table.minQuantity, table.unitPrice)
      .where(sql`${table.active} = true AND ${table.variantId} IS NOT NULL`),
    check("price_tiers_one_scope", sql`num_nonnulls(${table.productId}, ${table.variantId}) = 1`),
    check("price_tiers_min_quantity_valid", sql`${table.minQuantity} > 0`),
    check("price_tiers_range_valid", sql`${table.maxQuantity} IS NULL OR ${table.maxQuantity} >= ${table.minQuantity}`),
    check("price_tiers_price_nonnegative", sql`${table.unitPrice} >= 0`),
  ],
);

export const warehouses = pgTable(
  "warehouses",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    name: varchar("name", { length: 150 }).notNull(),
    code: varchar("code", { length: 50 }).notNull(),
    countryCode: varchar("country_code", { length: 2 }).notNull(),
    active: boolean("active").default(true).notNull(),
    ...timestamps,
  },
  (table) => [uniqueIndex("warehouses_code_unique").on(table.code), index("warehouses_active_idx").on(table.active)],
);

export const inventory = pgTable(
  "inventory",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    warehouseId: uuid("warehouse_id").notNull().references(() => warehouses.id, { onDelete: "cascade" }),
    productId: uuid("product_id").references(() => products.id, { onDelete: "cascade" }),
    variantId: uuid("variant_id").references(() => productVariants.id, { onDelete: "cascade" }),
    quantityOnHand: integer("quantity_on_hand").default(0).notNull(),
    quantityReserved: integer("quantity_reserved").default(0).notNull(),
    lowStockThreshold: integer("low_stock_threshold").default(0).notNull(),
    active: boolean("active").default(true).notNull(),
    updatedAt: timestamps.updatedAt,
  },
  (table) => [
    uniqueIndex("inventory_warehouse_product_unique").on(table.warehouseId, table.productId),
    uniqueIndex("inventory_warehouse_variant_unique").on(table.warehouseId, table.variantId),
    index("inventory_product_lookup_idx").on(table.productId),
    index("inventory_variant_lookup_idx").on(table.variantId),
    check("inventory_one_scope", sql`num_nonnulls(${table.productId}, ${table.variantId}) = 1`),
    check("inventory_quantities_nonnegative", sql`${table.quantityOnHand} >= 0 AND ${table.quantityReserved} >= 0 AND ${table.lowStockThreshold} >= 0`),
    check("inventory_reserved_not_over_on_hand", sql`${table.quantityReserved} <= ${table.quantityOnHand}`),
  ],
);

export const inventoryMovements = pgTable(
  "inventory_movements",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    warehouseId: uuid("warehouse_id").notNull().references(() => warehouses.id, { onDelete: "restrict" }),
    productId: uuid("product_id").references(() => products.id, { onDelete: "set null" }),
    variantId: uuid("variant_id").references(() => productVariants.id, { onDelete: "set null" }),
    movementType: movementTypeEnum("movement_type").notNull(),
    quantity: integer("quantity").notNull(),
    referenceType: varchar("reference_type", { length: 100 }),
    referenceId: uuid("reference_id"),
    note: text("note"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamps.createdAt,
  },
  (table) => [
    index("inventory_movements_product_idx").on(table.productId, table.createdAt),
    index("inventory_movements_variant_idx").on(table.variantId, table.createdAt),
    index("inventory_movements_warehouse_idx").on(table.warehouseId, table.createdAt),
    index("inventory_movements_created_at_idx").on(table.createdAt),
    check("inventory_movements_one_scope", sql`num_nonnulls(${table.productId}, ${table.variantId}) = 1`),
    check("inventory_movements_quantity_nonzero", sql`${table.quantity} <> 0`),
  ],
);

export const carts = pgTable(
  "carts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    guestSessionId: varchar("guest_session_id", { length: 200 }),
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    currency: varchar("currency", { length: 3 }).default("EUR").notNull(),
    appliedCouponCode: varchar("applied_coupon_code", { length: 80 }),
    status: cartStatusEnum("status").default("active").notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("carts_guest_session_unique").on(table.guestSessionId),
    index("carts_user_status_idx").on(table.userId, table.status),
    check("carts_owner_check", sql`num_nonnulls(${table.guestSessionId}, ${table.userId}) = 1`),
  ],
);

export const cartItems = pgTable(
  "cart_items",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    cartId: uuid("cart_id").notNull().references(() => carts.id, { onDelete: "cascade" }),
    productId: uuid("product_id").notNull().references(() => products.id, { onDelete: "restrict" }),
    variantId: uuid("variant_id").references(() => productVariants.id, { onDelete: "restrict" }),
    quantity: integer("quantity").notNull(),
    lastQuotedUnitPrice: numeric("last_quoted_unit_price", { precision: 12, scale: 2 }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("cart_items_variant_unique")
      .on(table.cartId, table.variantId)
      .where(sql`${table.variantId} IS NOT NULL`),
    uniqueIndex("cart_items_product_only_unique")
      .on(table.cartId, table.productId)
      .where(sql`${table.variantId} IS NULL`),
    index("cart_items_cart_idx").on(table.cartId),
    foreignKey({
      columns: [table.variantId, table.productId],
      foreignColumns: [productVariants.id, productVariants.productId],
      name: "cart_items_variant_product_fk",
    }).onDelete("restrict"),
    check("cart_items_quantity_positive", sql`${table.quantity} > 0`),
  ],
);

export const wishlists = pgTable(
  "wishlists",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 150 }).default("Default wishlist").notNull(),
    ...timestamps,
  },
  (table) => [index("wishlists_user_idx").on(table.userId)],
);

export const wishlistItems = pgTable(
  "wishlist_items",
  {
    wishlistId: uuid("wishlist_id").notNull().references(() => wishlists.id, { onDelete: "cascade" }),
    productId: uuid("product_id").notNull().references(() => products.id, { onDelete: "cascade" }),
    createdAt: timestamps.createdAt,
  },
  (table) => [primaryKey({ columns: [table.wishlistId, table.productId] }), index("wishlist_items_product_idx").on(table.productId)],
);

export const recentlyViewedProducts = pgTable(
  "recently_viewed_products",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    guestSessionId: varchar("guest_session_id", { length: 200 }),
    productId: uuid("product_id").notNull().references(() => products.id, { onDelete: "cascade" }),
    viewedAt: timestamp("viewed_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("recently_viewed_user_idx").on(table.userId, table.viewedAt),
    index("recently_viewed_guest_idx").on(table.guestSessionId, table.viewedAt),
    check("recently_viewed_owner_check", sql`num_nonnulls(${table.userId}, ${table.guestSessionId}) = 1`),
  ],
);

export const orders = pgTable(
  "orders",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orderNumber: varchar("order_number", { length: 40 }).notNull(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    companyId: uuid("company_id").references(() => companies.id, { onDelete: "set null" }),
    guestEmail: varchar("guest_email", { length: 320 }),
    status: orderStatusEnum("status").default("pending").notNull(),
    paymentStatus: paymentStatusEnum("payment_status").default("pending").notNull(),
    fulfillmentStatus: fulfillmentStatusEnum("fulfillment_status").default("unfulfilled").notNull(),
    fulfillmentStage: varchar("fulfillment_stage", { length: 30 }).default("unfulfilled").notNull(),
    currency: varchar("currency", { length: 3 }).default("EUR").notNull(),
    subtotal: money("subtotal").notNull(),
    discountTotal: money("discount_total").default("0").notNull(),
    promotionSnapshot: jsonb("promotion_snapshot"),
    shippingTotal: money("shipping_total").default("0").notNull(),
    shippingRuleId: uuid("shipping_rule_id"),
    shippingProvider: varchar("shipping_provider", { length: 80 }),
    shippingSource: varchar("shipping_source", { length: 80 }),
    shippingWeightKg: numeric("shipping_weight_kg", { precision: 10, scale: 3 }),
    shippingQuotedTotal: money("shipping_quoted_total"),
    shippingChargedTotal: money("shipping_charged_total"),
    shippingMinDeliveryDays: integer("shipping_min_delivery_days"),
    shippingMaxDeliveryDays: integer("shipping_max_delivery_days"),
    taxTotal: money("tax_total").default("0").notNull(),
    grandTotal: money("grand_total").notNull(),
    billingAddressSnapshot: jsonb("billing_address_snapshot").notNull(),
    shippingAddressSnapshot: jsonb("shipping_address_snapshot").notNull(),
    guestSessionId: varchar("guest_session_id", { length: 200 }),
    guestAccessTokenHash: varchar("guest_access_token_hash", { length: 128 }),
    idempotencyKey: varchar("idempotency_key", { length: 200 }),
    checkoutRequestFingerprint: varchar("checkout_request_fingerprint", { length: 64 }),
    checkoutCartFingerprint: varchar("checkout_cart_fingerprint", { length: 64 }),
    totalFingerprint: varchar("total_fingerprint", { length: 64 }),
    purchaseLegalScope: varchar("purchase_legal_scope", { length: 16 }),
    reservationExpiresAt: timestamp("reservation_expires_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("orders_order_number_unique").on(table.orderNumber),
    index("orders_user_idx").on(table.userId, table.createdAt),
    index("orders_company_idx").on(table.companyId, table.createdAt),
    index("orders_status_idx").on(table.status, table.createdAt),
    index("orders_payment_status_idx").on(table.paymentStatus),
    index("orders_created_at_idx").on(table.createdAt),
    index("orders_guest_email_idx").on(table.guestEmail),
    index("orders_fulfillment_stage_idx").on(table.fulfillmentStage, table.createdAt),
    check("orders_customer_check", sql`num_nonnulls(${table.userId}, ${table.companyId}, ${table.guestEmail}) >= 1`),
    check("orders_totals_nonnegative", sql`
      ${table.subtotal} >= 0 AND ${table.discountTotal} >= 0
      AND ${table.shippingTotal} >= 0 AND ${table.taxTotal} >= 0 AND ${table.grandTotal} >= 0
    `),
  ],
);

/** Retains the original guest proof after an order is attached to an account. */
export const guestOrderClaims = pgTable(
  "guest_order_claims",
  {
    orderId: uuid("order_id").primaryKey().references(() => orders.id, { onDelete: "cascade" }),
    claimedByUserId: uuid("claimed_by_user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
    guestSessionId: varchar("guest_session_id", { length: 200 }).notNull(),
    guestAccessTokenHash: varchar("guest_access_token_hash", { length: 128 }).notNull(),
    claimedAt: timestamp("claimed_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index("guest_order_claims_user_idx").on(table.claimedByUserId)],
);

export const inventoryReservations = pgTable(
  "inventory_reservations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orderId: uuid("order_id").notNull().references(() => orders.id, { onDelete: "cascade" }),
    inventoryId: uuid("inventory_id").notNull().references(() => inventory.id, { onDelete: "restrict" }),
    quantity: integer("quantity").notNull(),
    status: reservationStatusEnum("status").default("active").notNull(),
    releasedAt: timestamp("released_at", { withTimezone: true }),
    createdAt: timestamps.createdAt,
  },
  (table) => [
    uniqueIndex("inventory_reservations_order_inventory_unique").on(table.orderId, table.inventoryId),
    index("inventory_reservations_order_idx").on(table.orderId, table.status),
    index("inventory_reservations_inventory_idx").on(table.inventoryId, table.status),
    check("inventory_reservations_quantity_positive", sql`${table.quantity} > 0`),
  ],
);

export const orderItems = pgTable(
  "order_items",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orderId: uuid("order_id").notNull().references(() => orders.id, { onDelete: "cascade" }),
    productId: uuid("product_id").notNull().references(() => products.id, { onDelete: "restrict" }),
    variantId: uuid("variant_id").references(() => productVariants.id, { onDelete: "restrict" }),
    skuSnapshot: varchar("sku_snapshot", { length: 100 }).notNull(),
    productNameSnapshot: varchar("product_name_snapshot", { length: 250 }).notNull(),
    variantNameSnapshot: varchar("variant_name_snapshot", { length: 200 }),
    quantity: integer("quantity").notNull(),
    unitPrice: money("unit_price").notNull(),
    costPriceSnapshot: money("cost_price_snapshot").notNull(),
    taxRateSnapshot: numeric("tax_rate_snapshot", { precision: 5, scale: 2 }).notNull(),
    taxModeSnapshot: varchar("tax_mode_snapshot", { length: 16 }).default("inclusive").notNull(),
    vatClassifiedAtSnapshot: timestamp("vat_classified_at_snapshot", { withTimezone: true }),
    lineTotal: money("line_total").notNull(),
    promotionSnapshot: jsonb("promotion_snapshot"),
    supplierId: uuid("supplier_id").references(() => suppliers.id, { onDelete: "restrict" }),
    supplierProductLinkId: uuid("supplier_product_link_id"),
    supplierCatalogueItemId: uuid("supplier_catalogue_item_id").references(() => supplierCatalogueItems.id, { onDelete: "restrict" }),
    supplierCatalogueVariantId: uuid("supplier_catalogue_variant_id").references(() => supplierCatalogueVariants.id, { onDelete: "restrict" }),
    supplierProductCode: varchar("supplier_product_code", { length: 255 }),
    supplierSkuCode: varchar("supplier_sku_code", { length: 255 }),
    supplierCostEur: numeric("supplier_cost_eur", { precision: 20, scale: 6 }),
    supplierCostCny: numeric("supplier_cost_cny", { precision: 30, scale: 12 }),
    supplierCostProvenance: jsonb("supplier_cost_provenance"),
    supplierCostThresholdPercent: numeric("supplier_cost_threshold_percent", { precision: 12, scale: 6 }),
    createdAt: timestamps.createdAt,
  },
  (table) => [
    index("order_items_order_idx").on(table.orderId),
    index("order_items_product_idx").on(table.productId),
    uniqueIndex("order_items_id_order_unique").on(table.id, table.orderId),
    foreignKey({
      columns: [table.variantId, table.productId],
      foreignColumns: [productVariants.id, productVariants.productId],
      name: "order_items_variant_product_fk",
    }).onDelete("restrict"),
    check("order_items_quantity_positive", sql`${table.quantity} > 0`),
    check("order_items_amounts_nonnegative", sql`${table.unitPrice} >= 0 AND ${table.costPriceSnapshot} >= 0 AND ${table.lineTotal} >= 0`),
    check("order_items_tax_rate_valid", sql`${table.taxRateSnapshot} >= 0 AND ${table.taxRateSnapshot} <= 100`),
    check("order_items_tax_mode_valid", sql`${table.taxModeSnapshot} IN ('inclusive','exclusive')`),
    check("order_items_supplier_snapshot_all_or_none", sql`(
      (${table.supplierProductLinkId} IS NULL AND ${table.supplierId} IS NULL AND ${table.supplierCatalogueItemId} IS NULL AND ${table.supplierCatalogueVariantId} IS NULL AND ${table.supplierProductCode} IS NULL AND ${table.supplierSkuCode} IS NULL AND ${table.supplierCostEur} IS NULL AND ${table.supplierCostCny} IS NULL AND ${table.supplierCostProvenance} IS NULL AND ${table.supplierCostThresholdPercent} IS NULL)
      OR
      (${table.supplierProductLinkId} IS NOT NULL AND ${table.supplierId} IS NOT NULL AND ${table.supplierCatalogueItemId} IS NOT NULL AND ${table.supplierCatalogueVariantId} IS NOT NULL AND ${table.supplierProductCode} IS NOT NULL AND ${table.supplierSkuCode} IS NOT NULL AND ${table.supplierCostEur} > 0 AND ${table.supplierCostCny} > 0 AND ${table.supplierCostProvenance} IS NOT NULL AND ${table.supplierCostThresholdPercent} >= 0)
    )`),
    foreignKey({ columns: [table.supplierProductLinkId], foreignColumns: [supplierProductLinks.id], name: "order_items_supplier_product_link_fk" }).onDelete("restrict"),
  ],
);

export const payments = pgTable(
  "payments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orderId: uuid("order_id").notNull().references(() => orders.id, { onDelete: "cascade" }),
    provider: varchar("provider", { length: 80 }).notNull(),
    providerPaymentId: varchar("provider_payment_id", { length: 200 }),
    status: paymentStatusEnum("status").default("pending").notNull(),
    amount: money("amount").notNull(),
    currency: varchar("currency", { length: 3 }).notNull(),
    paymentMethodType: varchar("payment_method_type", { length: 80 }),
    failureReason: text("failure_reason"),
    idempotencyKey: varchar("idempotency_key", { length: 200 }),
    orderTotalFingerprint: varchar("order_total_fingerprint", { length: 64 }),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    recoveryStatus: varchar("recovery_status", { length: 30 }).default("idle").notNull(),
    recoveryAttemptCount: integer("recovery_attempt_count").default(0).notNull(),
    lastRecoveryAttemptAt: timestamp("last_recovery_attempt_at", { withTimezone: true }),
    nextRecoveryAttemptAt: timestamp("next_recovery_attempt_at", { withTimezone: true }),
    recoveryFailureReason: text("recovery_failure_reason"),
    ...timestamps,
  },
  (table) => [
    index("payments_order_idx").on(table.orderId),
    uniqueIndex("payments_provider_payment_unique").on(table.provider, table.providerPaymentId),
    index("payments_status_idx").on(table.status, table.createdAt),
    uniqueIndex("payments_idempotency_key_unique").on(table.idempotencyKey),
    check("payments_amount_nonnegative", sql`${table.amount} >= 0`),
  ],
);

export const paymentRecoveryAttempts = pgTable(
  "payment_recovery_attempts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    paymentId: uuid("payment_id").notNull().references(() => payments.id, { onDelete: "cascade" }),
    providerEventId: varchar("provider_event_id", { length: 200 }),
    source: varchar("source", { length: 40 }).notNull(),
    status: varchar("status", { length: 30 }).notNull(),
    attemptNumber: integer("attempt_number").notNull(),
    failureReason: text("failure_reason"),
    detailsJson: jsonb("details_json"),
    ...timestamps,
  },
  (table) => [
    index("payment_recovery_attempts_payment_idx").on(table.paymentId, table.createdAt),
    index("payment_recovery_attempts_status_idx").on(table.status, table.createdAt),
    uniqueIndex("payment_recovery_attempts_provider_event_unique").on(table.providerEventId),
    check("payment_recovery_attempts_number_positive", sql`${table.attemptNumber} > 0`),
  ],
);

export const paymentEvents = pgTable(
  "payment_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    paymentId: uuid("payment_id").notNull().references(() => payments.id, { onDelete: "cascade" }),
    providerEventId: varchar("provider_event_id", { length: 200 }),
    eventType: varchar("event_type", { length: 100 }).notNull(),
    payloadJson: jsonb("payload_json").notNull(),
    signatureVerified: boolean("signature_verified").default(false).notNull(),
    createdAt: timestamps.createdAt,
  },
  (table) => [
    uniqueIndex("payment_events_provider_event_unique").on(table.providerEventId),
    index("payment_events_payment_idx").on(table.paymentId, table.createdAt),
  ],
);

export const shippingZones = pgTable(
  "shipping_zones",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    name: varchar("name", { length: 150 }).notNull(),
    active: boolean("active").default(true).notNull(),
    ...timestamps,
  },
  (table) => [uniqueIndex("shipping_zones_name_unique").on(table.name), index("shipping_zones_active_idx").on(table.active)],
);

export const shippingZoneCountries = pgTable(
  "shipping_zone_countries",
  {
    zoneId: uuid("zone_id").notNull().references(() => shippingZones.id, { onDelete: "cascade" }),
    countryCode: varchar("country_code", { length: 2 }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.zoneId, table.countryCode] }), index("shipping_zone_countries_country_idx").on(table.countryCode)],
);

export const shippingRules = pgTable(
  "shipping_rules",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    zoneId: uuid("zone_id").notNull().references(() => shippingZones.id, { onDelete: "cascade" }),
    minimumOrderValue: money("minimum_order_value"),
    maximumOrderValue: money("maximum_order_value"),
    minimumWeight: numeric("minimum_weight", { precision: 10, scale: 3 }),
    maximumWeight: numeric("maximum_weight", { precision: 10, scale: 3 }),
    shippingPrice: money("shipping_price").notNull(),
    freeShipping: boolean("free_shipping").default(false).notNull(),
    active: boolean("active").default(true).notNull(),
    priority: integer("priority").default(0).notNull(),
    ...timestamps,
  },
  (table) => [
    index("shipping_rules_zone_idx").on(table.zoneId, table.priority),
    check("shipping_rules_values_nonnegative", sql`
      (${table.minimumOrderValue} IS NULL OR ${table.minimumOrderValue} >= 0)
      AND (${table.maximumOrderValue} IS NULL OR ${table.maximumOrderValue} >= 0)
      AND ${table.shippingPrice} >= 0
      AND (${table.minimumWeight} IS NULL OR ${table.minimumWeight} >= 0)
      AND (${table.maximumWeight} IS NULL OR ${table.maximumWeight} >= 0)
    `),
    check("shipping_rules_ranges_valid", sql`
      (${table.maximumOrderValue} IS NULL OR ${table.minimumOrderValue} IS NULL OR ${table.maximumOrderValue} >= ${table.minimumOrderValue})
      AND (${table.maximumWeight} IS NULL OR ${table.minimumWeight} IS NULL OR ${table.maximumWeight} >= ${table.minimumWeight})
    `),
  ],
);

export const shipments = pgTable(
  "shipments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orderId: uuid("order_id").notNull().references(() => orders.id, { onDelete: "cascade" }),
    courier: varchar("courier", { length: 100 }).notNull(),
    trackingNumber: varchar("tracking_number", { length: 150 }),
    trackingUrl: text("tracking_url"),
    status: shipmentStatusEnum("status").default("pending").notNull(),
    shippedAt: timestamp("shipped_at", { withTimezone: true }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    index("shipments_order_idx").on(table.orderId),
    index("shipments_tracking_idx").on(table.trackingNumber),
    index("shipments_status_idx").on(table.status),
  ],
);

export const shipmentEvents = pgTable(
  "shipment_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    shipmentId: uuid("shipment_id").notNull().references(() => shipments.id, { onDelete: "cascade" }),
    status: shipmentStatusEnum("status").notNull(),
    note: text("note"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamps.createdAt,
  },
  (table) => [
    index("shipment_events_shipment_idx").on(table.shipmentId, table.createdAt),
    index("shipment_events_status_idx").on(table.status, table.createdAt),
  ],
);

export const fulfillmentEvents = pgTable(
  "fulfillment_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orderId: uuid("order_id").notNull().references(() => orders.id, { onDelete: "cascade" }),
    stage: varchar("stage", { length: 30 }).notNull(),
    note: text("note"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamps.createdAt,
  },
  (table) => [index("fulfillment_events_order_idx").on(table.orderId, table.createdAt)],
);

export const returnRequests = pgTable(
  "return_requests",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orderId: uuid("order_id").notNull().references(() => orders.id, { onDelete: "restrict" }),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    reason: varchar("reason", { length: 150 }).notNull(),
    description: text("description"),
    status: returnStatusEnum("status").default("requested").notNull(),
    adminNotes: text("admin_notes"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    reviewedBy: uuid("reviewed_by").references(() => users.id, { onDelete: "set null" }),
    receivedAt: timestamp("received_at", { withTimezone: true }),
    receivedBy: uuid("received_by").references(() => users.id, { onDelete: "set null" }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("return_requests_id_order_unique").on(table.id, table.orderId),
    index("return_requests_order_idx").on(table.orderId),
    index("return_requests_user_idx").on(table.userId),
    index("return_requests_status_idx").on(table.status, table.createdAt),
  ],
);

export const returnItems = pgTable(
  "return_items",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    returnRequestId: uuid("return_request_id").notNull(),
    orderId: uuid("order_id").notNull().references(() => orders.id, { onDelete: "restrict" }),
    orderItemId: uuid("order_item_id").notNull(),
    quantity: integer("quantity").notNull(),
    approvedQuantity: integer("approved_quantity").default(0).notNull(),
    receivedQuantity: integer("received_quantity").default(0).notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("return_items_request_order_item_unique").on(table.returnRequestId, table.orderItemId),
    index("return_items_order_item_idx").on(table.orderItemId),
    foreignKey({
      columns: [table.returnRequestId, table.orderId],
      foreignColumns: [returnRequests.id, returnRequests.orderId],
      name: "return_items_request_order_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.orderItemId, table.orderId],
      foreignColumns: [orderItems.id, orderItems.orderId],
      name: "return_items_item_order_fk",
    }).onDelete("restrict"),
    check("return_items_quantity_positive", sql`${table.quantity} > 0`),
    check("return_items_approved_quantity_valid", sql`${table.approvedQuantity} >= 0 AND ${table.approvedQuantity} <= ${table.quantity}`),
    check("return_items_received_quantity_valid", sql`${table.receivedQuantity} >= 0 AND ${table.receivedQuantity} <= ${table.approvedQuantity}`),
  ],
);

export const returnAttachments = pgTable(
  "return_attachments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    returnRequestId: uuid("return_request_id").notNull().references(() => returnRequests.id, { onDelete: "cascade" }),
    filename: varchar("filename", { length: 255 }).notNull(),
    mimeType: varchar("mime_type", { length: 120 }).notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    data: bytea("data").notNull(),
    createdAt: timestamps.createdAt,
  },
  (table) => [
    index("return_attachments_request_idx").on(table.returnRequestId, table.createdAt),
    check("return_attachments_size_positive", sql`${table.sizeBytes} > 0 AND ${table.sizeBytes} <= 5242880`),
  ],
);

export const refunds = pgTable(
  "refunds",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orderId: uuid("order_id").notNull().references(() => orders.id, { onDelete: "restrict" }),
    paymentId: uuid("payment_id").references(() => payments.id, { onDelete: "set null" }),
    returnRequestId: uuid("return_request_id").references(() => returnRequests.id, { onDelete: "set null" }),
    providerReference: varchar("provider_reference", { length: 200 }),
    reason: text("reason"),
    failureReason: text("failure_reason"),
    idempotencyKey: varchar("idempotency_key", { length: 200 }),
    amount: money("amount").notNull(),
    currency: varchar("currency", { length: 3 }).notNull(),
    status: refundStatusEnum("status").default("pending").notNull(),
    ...timestamps,
  },
  (table) => [
    index("refunds_order_idx").on(table.orderId, table.createdAt),
    index("refunds_return_request_idx").on(table.returnRequestId),
    uniqueIndex("refunds_idempotency_key_unique").on(table.idempotencyKey),
    check("refunds_amount_nonnegative", sql`${table.amount} >= 0`),
  ],
);

export const paymentRecoveryJobs = pgTable(
  "payment_recovery_jobs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orderId: uuid("order_id").references(() => orders.id, { onDelete: "cascade" }),
    paymentId: uuid("payment_id").references(() => payments.id, { onDelete: "cascade" }),
    refundId: uuid("refund_id").references(() => refunds.id, { onDelete: "cascade" }),
    providerEventId: varchar("provider_event_id", { length: 200 }),
    eventType: varchar("event_type", { length: 100 }),
    operation: varchar("operation", { length: 50 }).notNull(),
    payloadJson: jsonb("payload_json"),
    retryable: boolean("retryable").default(true).notNull(),
    status: varchar("status", { length: 20 }).default("pending").notNull(),
    attempts: integer("attempts").default(0).notNull(),
    lastError: text("last_error"),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).defaultNow().notNull(),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    lockToken: uuid("lock_token"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    index("payment_recovery_jobs_due_idx").on(table.status, table.nextAttemptAt),
    index("payment_recovery_jobs_payment_idx").on(table.paymentId, table.status),
    index("payment_recovery_jobs_refund_idx").on(table.refundId, table.status),
    index("payment_recovery_jobs_created_idx").on(table.createdAt),
    uniqueIndex("payment_recovery_jobs_event_unique").on(table.providerEventId).where(sql`${table.providerEventId} IS NOT NULL`),
    uniqueIndex("payment_recovery_jobs_payment_operation_active_unique")
      .on(table.paymentId, table.operation)
      .where(sql`${table.paymentId} IS NOT NULL AND ${table.operation} NOT IN ('webhook', 'refund') AND ${table.status} IN ('pending', 'processing', 'failed')`),
    uniqueIndex("payment_recovery_jobs_refund_operation_active_unique")
      .on(table.refundId, table.operation)
      .where(sql`${table.refundId} IS NOT NULL AND ${table.operation} = 'refund' AND ${table.status} IN ('pending', 'processing', 'failed')`),
    check("payment_recovery_jobs_operation_valid", sql`${table.operation} IN ('webhook', 'payment_creation', 'payment_status', 'expiration', 'refund', 'payment_invalidation')`),
    check("payment_recovery_jobs_status_valid", sql`${table.status} IN ('pending', 'processing', 'succeeded', 'failed')`),
    check("payment_recovery_jobs_target_check", sql`num_nonnulls(${table.paymentId}, ${table.refundId}, ${table.orderId}) >= 1`),
  ],
);
export const coupons = pgTable(
  "coupons",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    code: varchar("code", { length: 80 }).notNull(),
    discountType: discountTypeEnum("discount_type").notNull(),
    discountValue: money("discount_value").notNull(),
    minimumOrderValue: money("minimum_order_value"),
    startAt: timestamp("start_at", { withTimezone: true }),
    endAt: timestamp("end_at", { withTimezone: true }),
    usageLimit: integer("usage_limit"),
    usageLimitPerCustomer: integer("usage_limit_per_customer"),
    active: boolean("active").default(true).notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("coupons_code_unique").on(table.code),
    index("coupons_active_dates_idx").on(table.active, table.startAt, table.endAt),
    check("coupons_discount_nonnegative", sql`${table.discountValue} >= 0`),
    check("coupons_percentage_valid", sql`${table.discountType} <> 'percentage' OR ${table.discountValue} <= 100`),
    check("coupons_minimum_value_nonnegative", sql`${table.minimumOrderValue} IS NULL OR ${table.minimumOrderValue} >= 0`),
    check("coupons_usage_limits_positive", sql`
      (${table.usageLimit} IS NULL OR ${table.usageLimit} > 0)
      AND (${table.usageLimitPerCustomer} IS NULL OR ${table.usageLimitPerCustomer} > 0)
    `),
    check("coupons_date_range_valid", sql`${table.endAt} IS NULL OR ${table.startAt} IS NULL OR ${table.endAt} >= ${table.startAt}`),
  ],
);

export const couponUsages = pgTable(
  "coupon_usages",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    couponId: uuid("coupon_id").notNull().references(() => coupons.id, { onDelete: "cascade" }),
    orderId: uuid("order_id").notNull().references(() => orders.id, { onDelete: "cascade" }),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    discountAmount: money("discount_amount").notNull(),
    createdAt: timestamps.createdAt,
  },
  (table) => [
    uniqueIndex("coupon_usages_coupon_order_unique").on(table.couponId, table.orderId),
    index("coupon_usages_user_idx").on(table.userId, table.couponId),
    check("coupon_usages_discount_nonnegative", sql`${table.discountAmount} >= 0`),
  ],
);

export const promotionCampaigns = pgTable(
  "promotion_campaigns",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    name: varchar("name", { length: 200 }).notNull(),
    description: text("description"),
    startAt: timestamp("start_at", { withTimezone: true }).notNull(),
    endAt: timestamp("end_at", { withTimezone: true }),
    promotionType: varchar("promotion_type", { length: 30 }).default("order").notNull(),
    discountType: discountTypeEnum("discount_type"),
    discountValue: money("discount_value"),
    minimumOrderValue: money("minimum_order_value"),
    freeShipping: boolean("free_shipping").default(false).notNull(),
    automatic: boolean("automatic").default(true).notNull(),
    couponCode: varchar("coupon_code", { length: 80 }),
    usageLimit: integer("usage_limit"),
    usageLimitPerCustomer: integer("usage_limit_per_customer"),
    usageCount: integer("usage_count").default(0).notNull(),
    allowStacking: boolean("allow_stacking").default(false).notNull(),
    priority: integer("priority").default(0).notNull(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    active: boolean("active").default(true).notNull(),
    ...timestamps,
  },
  (table) => [
    index("promotion_campaigns_active_dates_idx").on(table.active, table.startAt, table.endAt),
    uniqueIndex("promotion_campaigns_coupon_code_unique").on(table.couponCode),
    check("promotion_campaigns_date_range_valid", sql`${table.endAt} IS NULL OR ${table.endAt} >= ${table.startAt}`),
    check("promotion_campaigns_value_nonnegative", sql`${table.discountValue} IS NULL OR ${table.discountValue} >= 0`),
    check("promotion_campaigns_percentage_valid", sql`${table.discountType} IS NULL OR ${table.discountType} <> 'percentage' OR ${table.discountValue} <= 100`),
    check("promotion_campaigns_usage_limits_positive", sql`(${table.usageLimit} IS NULL OR ${table.usageLimit} > 0) AND (${table.usageLimitPerCustomer} IS NULL OR ${table.usageLimitPerCustomer} > 0)`),
    check("promotion_campaigns_usage_count_nonnegative", sql`${table.usageCount} >= 0`),
  ],
);

export const promotionProducts = pgTable(
  "promotion_products",
  {
    campaignId: uuid("campaign_id").notNull().references(() => promotionCampaigns.id, { onDelete: "cascade" }),
    productId: uuid("product_id").notNull().references(() => products.id, { onDelete: "cascade" }),
  },
  (table) => [primaryKey({ columns: [table.campaignId, table.productId] }), index("promotion_products_product_idx").on(table.productId)],
);

export const promotionCategories = pgTable(
  "promotion_categories",
  {
    campaignId: uuid("campaign_id").notNull().references(() => promotionCampaigns.id, { onDelete: "cascade" }),
    categoryId: uuid("category_id").notNull().references(() => categories.id, { onDelete: "cascade" }),
  },
  (table) => [primaryKey({ columns: [table.campaignId, table.categoryId] }), index("promotion_categories_category_idx").on(table.categoryId)],
);

export const promotionBrands = pgTable(
  "promotion_brands",
  {
    campaignId: uuid("campaign_id").notNull().references(() => promotionCampaigns.id, { onDelete: "cascade" }),
    brandId: uuid("brand_id").notNull().references(() => brands.id, { onDelete: "cascade" }),
  },
  (table) => [primaryKey({ columns: [table.campaignId, table.brandId] }), index("promotion_brands_brand_idx").on(table.brandId)],
);

export const promotionUsages = pgTable(
  "promotion_usages",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    campaignId: uuid("campaign_id").notNull().references(() => promotionCampaigns.id, { onDelete: "cascade" }),
    orderId: uuid("order_id").notNull().references(() => orders.id, { onDelete: "cascade" }),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    guestSessionId: varchar("guest_session_id", { length: 200 }),
    discountAmount: money("discount_amount").notNull(),
    createdAt: timestamps.createdAt,
  },
  (table) => [
    uniqueIndex("promotion_usages_campaign_order_unique").on(table.campaignId, table.orderId),
    index("promotion_usages_customer_idx").on(table.campaignId, table.userId),
    index("promotion_usages_guest_idx").on(table.campaignId, table.guestSessionId),
    check("promotion_usages_discount_nonnegative", sql`${table.discountAmount} >= 0`),
  ],
);

export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    companyId: uuid("company_id").references(() => companies.id, { onDelete: "cascade" }),
    type: varchar("type", { length: 100 }).notNull(),
    eventKey: varchar("event_key", { length: 200 }),
    title: varchar("title", { length: 200 }).notNull(),
    message: text("message").notNull(),
    dataJson: jsonb("data_json"),
    readAt: timestamp("read_at", { withTimezone: true }),
    createdAt: timestamps.createdAt,
  },
  (table) => [
    index("notifications_user_read_idx").on(table.userId, table.readAt, table.createdAt),
    index("notifications_company_read_idx").on(table.companyId, table.readAt, table.createdAt),
    uniqueIndex("notifications_event_user_unique").on(table.eventKey, table.userId).where(sql`${table.eventKey} IS NOT NULL AND ${table.userId} IS NOT NULL AND ${table.companyId} IS NULL`),
    uniqueIndex("notifications_event_company_unique").on(table.eventKey, table.companyId).where(sql`${table.eventKey} IS NOT NULL AND ${table.companyId} IS NOT NULL AND ${table.userId} IS NULL`),
    uniqueIndex("notifications_event_user_company_unique").on(table.eventKey, table.userId, table.companyId).where(sql`${table.eventKey} IS NOT NULL AND ${table.userId} IS NOT NULL AND ${table.companyId} IS NOT NULL`),
    check("notifications_recipient_check", sql`num_nonnulls(${table.userId}, ${table.companyId}) >= 1`),
  ],
);

/** Per-user controls for non-essential transactional messages. Essential security
 * and legally required service notices deliberately do not consult these rows. */
export const notificationPreferences = pgTable(
  "notification_preferences",
  {
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    eventType: varchar("event_type", { length: 100 }).notNull(),
    inAppEnabled: boolean("in_app_enabled").default(true).notNull(),
    emailEnabled: boolean("email_enabled").default(true).notNull(),
    updatedAt: timestamps.updatedAt,
  },
  (table) => [primaryKey({ columns: [table.userId, table.eventType] })],
);

/** Durable outbox. A delivery is created with the domain event, then sent by a
 * worker after commit; provider calls never participate in business writes. */
export const notificationDeliveries = pgTable(
  "notification_deliveries",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    notificationId: uuid("notification_id").references(() => notifications.id, { onDelete: "cascade" }),
    eventType: varchar("event_type", { length: 100 }).notNull(),
    channel: varchar("channel", { length: 20 }).notNull(),
    recipientEmail: varchar("recipient_email", { length: 320 }),
    subject: varchar("subject", { length: 200 }),
    message: text("message"),
    metadataJson: jsonb("metadata_json"),
    encryptedSecret: text("encrypted_secret"),
    providerMessageId: varchar("provider_message_id", { length: 200 }),
    providerStatus: varchar("provider_status", { length: 30 }),
    providerEventAt: timestamp("provider_event_at", { withTimezone: true }),
    suppressionReason: varchar("suppression_reason", { length: 30 }),
    suppressedAt: timestamp("suppressed_at", { withTimezone: true }),
    status: varchar("status", { length: 20 }).default("pending").notNull(),
    idempotencyKey: varchar("idempotency_key", { length: 200 }).notNull(),
    attempts: integer("attempts").default(0).notNull(),
    maxAttempts: integer("max_attempts").default(5).notNull(),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).defaultNow().notNull(),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    lockToken: uuid("lock_token"),
    lastError: text("last_error"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    createdAt: timestamps.createdAt,
    updatedAt: timestamps.updatedAt,
  },
  (table) => [
    uniqueIndex("notification_deliveries_idempotency_unique").on(table.idempotencyKey),
    index("notification_deliveries_ready_idx").on(table.status, table.nextAttemptAt),
    index("notification_deliveries_provider_message_idx").on(table.providerMessageId),
    index("notification_deliveries_provider_status_idx").on(table.providerStatus, table.createdAt),
  ],
);

export const resendWebhookEvents = pgTable(
  "resend_webhook_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    webhookId: varchar("webhook_id", { length: 200 }).notNull().unique(),
    eventType: varchar("event_type", { length: 50 }).notNull(),
    providerMessageId: varchar("provider_message_id", { length: 200 }).notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    matchedDeliveryId: uuid("matched_delivery_id").references(() => notificationDeliveries.id, { onDelete: "set null" }),
    detailsJson: jsonb("details_json"),
    createdAt: timestamps.createdAt,
  },
  (table) => [index("resend_webhook_events_provider_message_idx").on(table.providerMessageId, table.occurredAt)],
);

export const emailRecipientSuppressions = pgTable("email_recipient_suppressions", {
  email: varchar("email", { length: 320 }).primaryKey(),
  reason: varchar("reason", { length: 30 }).notNull(),
  providerMessageId: varchar("provider_message_id", { length: 200 }),
  sourceEventId: uuid("source_event_id").references(() => resendWebhookEvents.id, { onDelete: "set null" }),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
  createdAt: timestamps.createdAt,
  updatedAt: timestamps.updatedAt,
});

export const notificationDeliveryAttempts = pgTable(
  "notification_delivery_attempts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    deliveryId: uuid("delivery_id").notNull().references(() => notificationDeliveries.id, { onDelete: "cascade" }),
    attemptNumber: integer("attempt_number").notNull(),
    status: varchar("status", { length: 20 }).notNull(),
    error: text("error"),
    createdAt: timestamps.createdAt,
  },
  (table) => [uniqueIndex("notification_attempt_number_unique").on(table.deliveryId, table.attemptNumber)],
);

export const guestOrderEmailAccessTokens = pgTable(
  "guest_order_email_access_tokens",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    deliveryId: uuid("delivery_id").notNull().references(() => notificationDeliveries.id, { onDelete: "cascade" }),
    orderId: uuid("order_id").notNull().references(() => orders.id, { onDelete: "cascade" }),
    tokenHash: varchar("token_hash", { length: 128 }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamps.createdAt,
  },
  (table) => [
    uniqueIndex("guest_order_email_access_delivery_unique").on(table.deliveryId),
    uniqueIndex("guest_order_email_access_token_hash_unique").on(table.tokenHash),
    index("guest_order_email_access_order_expiry_idx").on(table.orderId, table.expiresAt),
  ],
);

export const pushDevices = pgTable(
  "push_devices",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    platform: notificationPlatformEnum("platform").notNull(),
    pushToken: text("push_token").notNull(),
    active: boolean("active").default(true).notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("push_devices_token_unique").on(table.pushToken),
    index("push_devices_user_active_idx").on(table.userId, table.active),
  ],
);

export const notificationCampaigns = pgTable(
  "notification_campaigns",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    title: varchar("title", { length: 200 }).notNull(),
    message: text("message").notNull(),
    audienceType: varchar("audience_type", { length: 100 }).notNull(),
    targetingJson: jsonb("targeting_json"),
    scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
    status: notificationCampaignStatusEnum("status").default("draft").notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamps.createdAt,
  },
  (table) => [index("notification_campaigns_status_schedule_idx").on(table.status, table.scheduledAt)],
);

export const supportTickets = pgTable(
  "support_tickets",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    ticketNumber: varchar("ticket_number", { length: 40 }).notNull(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    companyId: uuid("company_id").references(() => companies.id, { onDelete: "set null" }),
    relatedOrderId: uuid("related_order_id").references(() => orders.id, { onDelete: "set null" }),
    subject: varchar("subject", { length: 250 }).notNull(),
    status: supportTicketStatusEnum("status").default("open").notNull(),
    priority: varchar("priority", { length: 20 }).default("normal").notNull(),
    assignedAdminId: uuid("assigned_admin_id").references(() => users.id, { onDelete: "set null" }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("support_tickets_ticket_number_unique").on(table.ticketNumber),
    index("support_tickets_user_idx").on(table.userId, table.createdAt),
    index("support_tickets_company_idx").on(table.companyId, table.createdAt),
    index("support_tickets_status_idx").on(table.status, table.createdAt),
    index("support_tickets_assignee_idx").on(table.assignedAdminId, table.createdAt),
  ],
);

export const ticketMessages = pgTable(
  "ticket_messages",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    ticketId: uuid("ticket_id").notNull().references(() => supportTickets.id, { onDelete: "cascade" }),
    authorUserId: uuid("author_user_id").references(() => users.id, { onDelete: "set null" }),
    message: text("message").notNull(),
    isInternal: boolean("is_internal").default(false).notNull(),
    createdAt: timestamps.createdAt,
  },
  (table) => [index("ticket_messages_ticket_idx").on(table.ticketId, table.createdAt)],
);

export const ticketAttachments = pgTable(
  "ticket_attachments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    ticketId: uuid("ticket_id").notNull().references(() => supportTickets.id, { onDelete: "cascade" }),
    messageId: uuid("message_id").references(() => ticketMessages.id, { onDelete: "cascade" }),
    fileName: varchar("file_name", { length: 255 }).notNull(),
    url: text("url").notNull(),
    mimeType: varchar("mime_type", { length: 120 }),
    createdAt: timestamps.createdAt,
  },
  (table) => [index("ticket_attachments_ticket_idx").on(table.ticketId)],
);

export const chatSessions = pgTable(
  "chat_sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    guestSessionId: varchar("guest_session_id", { length: 200 }),
    status: chatSessionStatusEnum("status").default("open").notNull(),
    assignedAdminId: uuid("assigned_admin_id").references(() => users.id, { onDelete: "set null" }),
    lastReadAt: timestamp("last_read_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    index("chat_sessions_user_idx").on(table.userId, table.createdAt),
    index("chat_sessions_guest_idx").on(table.guestSessionId, table.createdAt),
    index("chat_sessions_assignee_idx").on(table.assignedAdminId, table.createdAt),
    check("chat_sessions_owner_check", sql`num_nonnulls(${table.userId}, ${table.guestSessionId}) = 1`),
  ],
);

export const chatMessages = pgTable(
  "chat_messages",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    sessionId: uuid("session_id").notNull().references(() => chatSessions.id, { onDelete: "cascade" }),
    authorUserId: uuid("author_user_id").references(() => users.id, { onDelete: "set null" }),
    message: text("message").notNull(),
    isInternal: boolean("is_internal").default(false).notNull(),
    createdAt: timestamps.createdAt,
  },
  (table) => [index("chat_messages_session_idx").on(table.sessionId, table.createdAt)],
);

export const chatSessionReads = pgTable(
  "chat_session_reads",
  {
    sessionId: uuid("session_id").notNull().references(() => chatSessions.id, { onDelete: "cascade" }),
    adminUserId: uuid("admin_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    lastReadAt: timestamp("last_read_at", { withTimezone: true }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.sessionId, table.adminUserId] }), index("chat_session_reads_admin_idx").on(table.adminUserId, table.lastReadAt)],
);

export const adminRoles = pgTable(
  "admin_roles",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    name: varchar("name", { length: 120 }).notNull(),
    description: text("description"),
    active: boolean("active").default(true).notNull(),
    systemKey: varchar("system_key", { length: 50 }),
    staffAssignable: boolean("staff_assignable").default(false).notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("admin_roles_name_unique").on(table.name),
    uniqueIndex("admin_roles_system_key_unique").on(table.systemKey),
    index("admin_roles_active_idx").on(table.active),
    index("admin_roles_staff_assignable_idx").on(table.staffAssignable),
    check("admin_roles_super_admin_not_staff_assignable", sql`${table.systemKey} IS DISTINCT FROM 'super_admin' OR ${table.staffAssignable} = false`),
  ],
);

export const adminPermissions = pgTable(
  "admin_permissions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    permissionKey: varchar("permission_key", { length: 150 }).notNull(),
    description: text("description"),
    ...timestamps,
  },
  (table) => [uniqueIndex("admin_permissions_key_unique").on(table.permissionKey)],
);

export const adminRolePermissions = pgTable(
  "admin_role_permissions",
  {
    roleId: uuid("role_id").notNull().references(() => adminRoles.id, { onDelete: "cascade" }),
    permissionId: uuid("permission_id").notNull().references(() => adminPermissions.id, { onDelete: "cascade" }),
  },
  (table) => [primaryKey({ columns: [table.roleId, table.permissionId] }), index("admin_role_permissions_permission_idx").on(table.permissionId)],
);

export const adminUserRoles = pgTable(
  "admin_user_roles",
  {
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    roleId: uuid("role_id").notNull().references(() => adminRoles.id, { onDelete: "cascade" }),
    createdAt: timestamps.createdAt,
  },
  (table) => [primaryKey({ columns: [table.userId, table.roleId] }), index("admin_user_roles_role_idx").on(table.roleId)],
);

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    actorAdminId: uuid("actor_admin_id").references(() => users.id, { onDelete: "set null" }),
    action: varchar("action", { length: 150 }).notNull(),
    entityType: varchar("entity_type", { length: 100 }).notNull(),
    entityId: uuid("entity_id"),
    oldValuesJson: jsonb("old_values_json"),
    newValuesJson: jsonb("new_values_json"),
    ipAddress: varchar("ip_address", { length: 45 }),
    userAgent: text("user_agent"),
    createdAt: timestamps.createdAt,
  },
  (table) => [
    index("audit_logs_actor_idx").on(table.actorUserId, table.createdAt),
    index("audit_logs_entity_idx").on(table.entityType, table.entityId),
    index("audit_logs_created_at_idx").on(table.createdAt),
  ],
);

export const adminOperationNotes = pgTable(
  "admin_operation_notes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    entityType: varchar("entity_type", { length: 100 }).notNull(),
    entityId: uuid("entity_id").notNull(),
    body: text("body").notNull(),
    createdBy: uuid("created_by").notNull().references(() => users.id, { onDelete: "restrict" }),
    ...timestamps,
  },
  (table) => [
    index("admin_operation_notes_entity_idx").on(table.entityType, table.entityId, table.createdAt),
    index("admin_operation_notes_author_idx").on(table.createdBy, table.createdAt),
    check("admin_operation_notes_body_nonempty", sql`length(trim(${table.body})) > 0`),
  ],
);

export const contentPages = pgTable(
  "content_pages",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    slug: varchar("slug", { length: 180 }).notNull(),
    pageType: varchar("page_type", { length: 40 }).default("informational").notNull(),
    title: varchar("title", { length: 250 }).notNull(),
    excerpt: text("excerpt"),
    bodyJson: jsonb("body_json").notNull(),
    seoTitle: varchar("seo_title", { length: 70 }),
    seoDescription: varchar("seo_description", { length: 170 }),
    noIndex: boolean("no_index").default(false).notNull(),
    status: contentStatusEnum("status").default("draft").notNull(),
    publishedAt: timestamp("published_at", { withTimezone: true }),
     archivedAt: timestamp("archived_at", { withTimezone: true }),
     publishedBy: uuid("published_by").references(() => users.id, { onDelete: "set null" }),
     archivedBy: uuid("archived_by").references(() => users.id, { onDelete: "set null" }),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
    ...timestamps,
  },
  (table) => [uniqueIndex("content_pages_slug_unique").on(table.slug), index("content_pages_status_idx").on(table.status)],
);

export const contentPagePreviewReceipts = pgTable(
  "content_page_preview_receipts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    pageId: uuid("page_id").notNull().references(() => contentPages.id, { onDelete: "cascade" }),
    actorId: uuid("actor_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    sessionId: uuid("session_id").notNull().references(() => authSessions.id, { onDelete: "cascade" }),
    pageUpdatedAt: timestamp("page_updated_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("content_page_preview_receipts_lookup_idx").on(table.pageId, table.actorId, table.sessionId, table.expiresAt),
    index("content_page_preview_receipts_expiry_idx").on(table.expiresAt),
  ],
);

export const siteSettings = pgTable(
  "site_settings",
  {
    key: varchar("key", { length: 120 }).primaryKey(),
    valueJson: jsonb("value_json").notNull(),
    updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
    ...timestamps,
  },
  (table) => [index("site_settings_updated_idx").on(table.updatedAt)],
);

export const legalDocuments = pgTable(
  "legal_documents",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    canonicalKey: varchar("canonical_key", { length: 80 }).notNull(),
    publicRoute: varchar("public_route", { length: 180 }).notNull(),
    title: varchar("title", { length: 250 }).notNull(),
    language: varchar("language", { length: 12 }).default("en").notNull(),
    audience: varchar("audience", { length: 8 }).default("both").notNull(),
    currentPublishedVersionId: uuid("current_published_version_id"),
    requiredForCommercialLaunch: boolean("required_for_commercial_launch").default(true).notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("legal_documents_key_unique").on(table.canonicalKey),
    uniqueIndex("legal_documents_route_unique").on(table.publicRoute),
    check("legal_documents_audience_valid", sql`${table.audience} IN ('b2c', 'b2b', 'both')`),
  ],
);

export const legalDocumentAliases = pgTable("legal_document_aliases", {
  aliasRoute: varchar("alias_route", { length: 180 }).primaryKey(),
  documentId: uuid("document_id").notNull().references(() => legalDocuments.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

/** Immutable evidence of an exact published policy version; never stores guest IP data. */
export const legalPolicyAcceptances = pgTable(
  "legal_policy_acceptances",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    versionId: uuid("version_id").notNull().references(() => legalDocumentVersions.id, { onDelete: "restrict" }),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    orderId: uuid("order_id").references(() => orders.id, { onDelete: "set null" }),
    companyId: uuid("company_id").references(() => companies.id, { onDelete: "set null" }),
    source: varchar("source", { length: 32 }).notNull(),
    scope: varchar("scope", { length: 16 }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index("legal_policy_acceptances_order_idx").on(table.orderId, table.acceptedAt)],
);

export const legalDocumentVersions = pgTable(
  "legal_document_versions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    documentId: uuid("document_id").notNull().references(() => legalDocuments.id, { onDelete: "cascade" }),
    versionNumber: integer("version_number").notNull(),
    language: varchar("language", { length: 12 }).default("en").notNull(),
    title: varchar("title", { length: 250 }).notNull(),
    bodyJson: jsonb("body_json").notNull(),
    status: varchar("status", { length: 16 }).default("draft").notNull(),
    effectiveAt: timestamp("effective_at", { withTimezone: true }),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    publishedBy: uuid("published_by").references(() => users.id, { onDelete: "set null" }),
    contentReviewedAt: timestamp("content_reviewed_at", { withTimezone: true }),
    contentReviewedBy: uuid("content_reviewed_by").references(() => users.id, { onDelete: "set null" }),
    profileApplicabilityVerifiedAt: timestamp("profile_applicability_verified_at", { withTimezone: true }),
    profileApplicabilityVerifiedBy: uuid("profile_applicability_verified_by").references(() => users.id, { onDelete: "set null" }),
    websiteVisible: boolean("website_visible").default(true).notNull(),
    appVisible: boolean("app_visible").default(false).notNull(),
    pdfStorageKey: text("pdf_storage_key"),
    pdfOriginalFilename: varchar("pdf_original_filename", { length: 255 }),
    pdfSizeBytes: integer("pdf_size_bytes"),
    pdfSha256: varchar("pdf_sha256", { length: 64 }),
    pdfUploadedAt: timestamp("pdf_uploaded_at", { withTimezone: true }),
    pdfUploadedBy: uuid("pdf_uploaded_by").references(() => users.id, { onDelete: "set null" }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("legal_document_versions_number_unique").on(table.documentId, table.language, table.versionNumber),
    check("legal_document_versions_pdf_size_valid", sql`${table.pdfSizeBytes} IS NULL OR ${table.pdfSizeBytes} > 0`),
  ],
);

export const legalDocumentPublications = pgTable(
  "legal_document_publications",
  {
    documentId: uuid("document_id").notNull().references(() => legalDocuments.id, { onDelete: "cascade" }),
    language: varchar("language", { length: 12 }).default("en").notNull(),
    versionId: uuid("version_id").notNull().references(() => legalDocumentVersions.id, { onDelete: "restrict" }),
    publishedAt: timestamp("published_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [primaryKey({ columns: [table.documentId, table.language] }), uniqueIndex("legal_document_publications_version_unique").on(table.versionId)],
);

export const homepageSections = pgTable(
  "homepage_sections",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    key: varchar("key", { length: 120 }).notNull(),
    title: varchar("title", { length: 250 }),
    contentJson: jsonb("content_json").notNull(),
    sortOrder: integer("sort_order").default(0).notNull(),
    active: boolean("active").default(true).notNull(),
    ...timestamps,
  },
  (table) => [uniqueIndex("homepage_sections_key_unique").on(table.key), index("homepage_sections_active_sort_idx").on(table.active, table.sortOrder)],
);

export const storefrontBanners = pgTable(
  "storefront_banners",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    slot: varchar("slot", { length: 64 }).notNull(),
    desktopUrl: text("desktop_url"),
    mobileUrl: text("mobile_url"),
    altText: text("alt_text"),
    enabled: boolean("enabled").default(true).notNull(),
    appStatus: varchar("app_status", { length: 20 }).default("coming_soon").notNull(),
    appStoreUrl: text("app_store_url"),
    googlePlayUrl: text("google_play_url"),
    qrImageUrl: text("qr_image_url"),
    publishedConfigJson: jsonb("published_config_json"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    publishedByUserId: uuid("published_by_user_id").references(() => users.id, { onDelete: "set null" }),
    updatedByUserId: uuid("updated_by_user_id").references(() => users.id, { onDelete: "set null" }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("storefront_banners_slot_unique").on(table.slot),
    index("storefront_banners_public_idx").on(table.enabled, table.publishedAt),
    check("storefront_banners_slot_valid", sql`${table.slot} IN ('homepage_hero', 'homepage_app_banner')`),
    check("storefront_banners_app_status_valid", sql`${table.appStatus} IN ('coming_soon', 'live')`),
  ],
);

export const banners = pgTable(
  "banners",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    title: varchar("title", { length: 250 }).notNull(),
    imageUrl: text("image_url"),
    linkUrl: text("link_url"),
    startAt: timestamp("start_at", { withTimezone: true }).notNull(),
    endAt: timestamp("end_at", { withTimezone: true }),
    active: boolean("active").default(true).notNull(),
    ...timestamps,
  },
  (table) => [
    index("banners_active_dates_idx").on(table.active, table.startAt, table.endAt),
    check("banners_date_range_valid", sql`${table.endAt} IS NULL OR ${table.endAt} >= ${table.startAt}`),
  ],
);

export const authSessions = pgTable(
  "auth_sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    sessionTokenHash: varchar("session_token_hash", { length: 128 }).notNull(),
    csrfTokenHash: varchar("csrf_token_hash", { length: 128 }).notNull(),
    type: authSessionTypeEnum("type").default("customer").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).defaultNow().notNull(),
    ipAddress: varchar("ip_address", { length: 45 }),
    userAgent: text("user_agent"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("auth_sessions_token_hash_unique").on(table.sessionTokenHash),
    index("auth_sessions_user_active_idx").on(table.userId, table.revokedAt, table.expiresAt),
    index("auth_sessions_expiry_idx").on(table.expiresAt),
  ],
);

export const emailVerificationTokens = pgTable(
  "email_verification_tokens",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    tokenHash: varchar("token_hash", { length: 128 }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("email_verification_tokens_hash_unique").on(table.tokenHash),
    index("email_verification_tokens_user_idx").on(table.userId, table.expiresAt),
    index("email_verification_tokens_expiry_idx").on(table.expiresAt),
  ],
);

export const passwordResetTokens = pgTable(
  "password_reset_tokens",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    tokenHash: varchar("token_hash", { length: 128 }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("password_reset_tokens_hash_unique").on(table.tokenHash),
    index("password_reset_tokens_user_idx").on(table.userId, table.expiresAt),
    index("password_reset_tokens_expiry_idx").on(table.expiresAt),
  ],
);

export const adminTwoFactor = pgTable(
  "admin_two_factor",
  {
    userId: uuid("user_id").primaryKey().references(() => users.id, { onDelete: "cascade" }),
    status: adminTwoFactorStatusEnum("status").default("disabled").notNull(),
    secretCiphertext: text("secret_ciphertext"),
    recoveryCodeHashes: jsonb("recovery_code_hashes"),
    enabledAt: timestamp("enabled_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
);

export const adminTwoFactorChallenges = pgTable(
  "admin_two_factor_challenges",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    tokenHash: varchar("token_hash", { length: 128 }).notNull(),
    ipHash: varchar("ip_hash", { length: 128 }).notNull(),
    attempts: integer("attempts").default(0).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("admin_two_factor_challenges_token_hash_unique").on(table.tokenHash),
    index("admin_two_factor_challenges_user_expiry_idx").on(table.userId, table.expiresAt),
    index("admin_two_factor_challenges_expiry_idx").on(table.expiresAt),
    check("admin_two_factor_challenges_attempts_valid", sql`${table.attempts} >= 0 AND ${table.attempts} <= 5`),
  ],
);

export const usersRelations = relations(users, ({ many }) => ({
  addresses: many(addresses),
  companyMemberships: many(companyUsers),
  orders: many(orders),
  carts: many(carts),
  wishlists: many(wishlists),
  pushDevices: many(pushDevices),
  adminRoles: many(adminUserRoles),
  auditLogs: many(auditLogs),
}));

export const companiesRelations = relations(companies, ({ many }) => ({
  addresses: many(addresses),
  members: many(companyUsers),
  orders: many(orders),
  notifications: many(notifications),
}));

export const categoriesRelations = relations(categories, ({ one, many }) => ({
  parent: one(categories, { fields: [categories.parentId], references: [categories.id] }),
  children: many(categories),
  products: many(products),
  supplierRootMappings: many(supplierCategoryMappings, { relationName: "supplierRootCategory" }),
  supplierChildMappings: many(supplierCategoryMappings, { relationName: "supplierChildCategory" }),
}));

export const suppliersRelations = relations(suppliers, ({ many }) => ({
  categoryMappings: many(supplierCategoryMappings),
  fxNormalizationRuns: many(supplierFxNormalizationRuns),
}));

export const supplierCategoryMappingsRelations = relations(supplierCategoryMappings, ({ one, many }) => ({
  supplier: one(suppliers, { fields: [supplierCategoryMappings.supplierId], references: [suppliers.id] }),
  rootCategory: one(categories, { fields: [supplierCategoryMappings.rootCategoryId], references: [categories.id], relationName: "supplierRootCategory" }),
  childCategory: one(categories, { fields: [supplierCategoryMappings.childCategoryId], references: [categories.id], relationName: "supplierChildCategory" }),
  lastMappedByUser: one(users, { fields: [supplierCategoryMappings.lastMappedBy], references: [users.id] }),
  history: many(supplierCategoryMappingHistory),
}));

export const supplierCategoryMappingHistoryRelations = relations(supplierCategoryMappingHistory, ({ one }) => ({
  mapping: one(supplierCategoryMappings, { fields: [supplierCategoryMappingHistory.mappingId], references: [supplierCategoryMappings.id] }),
  actor: one(users, { fields: [supplierCategoryMappingHistory.actorUserId], references: [users.id] }),
}));

export const brandsRelations = relations(brands, ({ many }) => ({
  products: many(products),
}));

export const productsRelations = relations(products, ({ one, many }) => ({
  brand: one(brands, { fields: [products.brandId], references: [brands.id] }),
  category: one(categories, { fields: [products.categoryId], references: [categories.id] }),
  variants: many(productVariants),
  media: many(productMedia),
  priceTiers: many(priceTiers),
  inventory: many(inventory),
  cartItems: many(cartItems),
  orderItems: many(orderItems),
}));

export const productVariantsRelations = relations(productVariants, ({ one, many }) => ({
  product: one(products, { fields: [productVariants.productId], references: [products.id] }),
  media: many(productMedia),
  attributeValues: many(variantAttributeValues),
  priceTiers: many(priceTiers),
  inventory: many(inventory),
}));

export const ordersRelations = relations(orders, ({ one, many }) => ({
  user: one(users, { fields: [orders.userId], references: [users.id] }),
  company: one(companies, { fields: [orders.companyId], references: [companies.id] }),
  items: many(orderItems),
  payments: many(payments),
  shipments: many(shipments),
  shipmentEvents: many(shipmentEvents),
  fulfillmentEvents: many(fulfillmentEvents),
  returns: many(returnRequests),
  refunds: many(refunds),
}));

export const orderItemsRelations = relations(orderItems, ({ one, many }) => ({
  order: one(orders, { fields: [orderItems.orderId], references: [orders.id] }),
  product: one(products, { fields: [orderItems.productId], references: [products.id] }),
  variant: one(productVariants, { fields: [orderItems.variantId], references: [productVariants.id] }),
  returns: many(returnItems),
}));

export const shipmentsRelations = relations(shipments, ({ one, many }) => ({
  order: one(orders, { fields: [shipments.orderId], references: [orders.id] }),
  events: many(shipmentEvents),
}));

export const shipmentEventsRelations = relations(shipmentEvents, ({ one }) => ({
  shipment: one(shipments, { fields: [shipmentEvents.shipmentId], references: [shipments.id] }),
  createdByUser: one(users, { fields: [shipmentEvents.createdBy], references: [users.id] }),
}));

export const supportTicketsRelations = relations(supportTickets, ({ one, many }) => ({
  user: one(users, { fields: [supportTickets.userId], references: [users.id] }),
  company: one(companies, { fields: [supportTickets.companyId], references: [companies.id] }),
  messages: many(ticketMessages),
  attachments: many(ticketAttachments),
}));
