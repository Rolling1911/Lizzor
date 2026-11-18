import type { Pool, PoolClient } from "pg";
import { getDatabasePool } from "../db/client.js";
import { AppError } from "../middleware/error-handler.js";
import { assertMerchandisePriceFloor } from "../pricing/floor.js";
import type { BrandInput, CategoryInput, ProductInput, VariantInput } from "./validation.js";
import { enqueueMediaCleanup } from "./media-cleanup.js";
import { resolveCategoryImageUrl } from "./category-media.js";

type Queryable = Pool | PoolClient;

interface ProductRow {
  id: string;
  name: string;
  slug: string;
  seoTitle: string | null;
  seoDescription: string | null;
  parentSku: string;
  barcode: string | null;
  brandId: string | null;
  brandName: string | null;
  brandSlug: string | null;
  categoryId: string;
  categoryName: string;
  categorySlug: string;
  shortDescription: string | null;
  description: string;
  status: string;
  costPrice: string;
  basePrice: string;
  vatRate: string;
  taxMode: "inclusive" | "exclusive";
  vatClassifiedAt: Date | string | null;
  isToonies: boolean;
  weight: string;
  displayWeightKg: string | null;
  minimumOrderQuantity: string;
  width: string | null;
  height: string | null;
  length: string | null;
  featured: boolean;
  newArrival: boolean;
  homepageWholesale: boolean;
  hasActiveWholesaleTier?: boolean;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
  variantCount: string;
  thumbnailUrl: string | null;
}

function numeric(value: string | number | null | undefined): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function slugify(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 120) || "option";
}

function uniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}

function catalogConflict(error: unknown): never {
  if (uniqueViolation(error)) throw new AppError(409, "CATALOG_CONFLICT", "A catalog record with the same unique identifier already exists.");
  throw error;
}

async function lockTooniesPublicationDependencies(client: Queryable, productId: string): Promise<void> {
  await client.query("SELECT id FROM products WHERE id=$1 FOR UPDATE", [productId]);
  const links = await client.query<{
    supplierId: string;
    catalogueItemId: string;
    catalogueVariantId: string | null;
    variantId: string | null;
    externalCategoryId: string | null;
    itemFxRateSnapshotId: string | null;
    variantFxRateSnapshotId: string | null;
  }>(
    `SELECT l.supplier_id AS "supplierId",l.catalogue_item_id AS "catalogueItemId",
            l.catalogue_variant_id AS "catalogueVariantId",l.variant_id AS "variantId",
            i.external_category_id AS "externalCategoryId",
            i.fx_rate_snapshot_id AS "itemFxRateSnapshotId",
            v.fx_rate_snapshot_id AS "variantFxRateSnapshotId"
       FROM supplier_product_links l
       JOIN supplier_catalogue_items i ON i.id=l.catalogue_item_id
       LEFT JOIN supplier_catalogue_variants v ON v.id=l.catalogue_variant_id
      WHERE l.product_id=$1
      ORDER BY l.id
      FOR UPDATE OF l`,
    [productId],
  );
  if (!links.rows.length) return;
  const supplierIds = [...new Set(links.rows.map((link) => link.supplierId))];
  const itemIds = [...new Set(links.rows.map((link) => link.catalogueItemId))];
  const variantIds = links.rows.flatMap((link) => link.catalogueVariantId ? [link.catalogueVariantId] : []);
  const productVariantIds = links.rows.flatMap((link) => link.variantId ? [link.variantId] : []);
  const categoryIds = [...new Set(links.rows.flatMap((link) => link.externalCategoryId ? [link.externalCategoryId] : []))];
  const fxIds = [...new Set(links.rows.flatMap((link) => [link.itemFxRateSnapshotId, link.variantFxRateSnapshotId].filter((id): id is string => Boolean(id))))];
  await client.query("SELECT id FROM suppliers WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE", [supplierIds]);
  await client.query("SELECT id FROM supplier_category_mappings WHERE supplier_id=ANY($1::uuid[]) AND external_category_id=ANY($2::text[]) ORDER BY id FOR UPDATE", [supplierIds, categoryIds]);
  await client.query("SELECT id FROM supplier_catalogue_items WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE", [itemIds]);
  if (variantIds.length) await client.query("SELECT id FROM supplier_catalogue_variants WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE", [variantIds]);
  if (fxIds.length) await client.query("SELECT id FROM fx_rate_snapshots WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE", [fxIds]);
  if (productVariantIds.length) await client.query("SELECT id FROM product_variants WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE", [productVariantIds]);
  await client.query(
    `SELECT c.id
       FROM categories c
      WHERE c.id IN (
        SELECT p.category_id FROM products p WHERE p.id=$1
        UNION
        SELECT parent.id FROM products p JOIN categories own ON own.id=p.category_id JOIN categories parent ON parent.id=own.parent_id WHERE p.id=$1
        UNION
        SELECT m.root_category_id FROM supplier_category_mappings m
         WHERE m.supplier_id=ANY($2::uuid[]) AND m.external_category_id=ANY($3::text[]) AND m.root_category_id IS NOT NULL
        UNION
        SELECT m.child_category_id FROM supplier_category_mappings m
         WHERE m.supplier_id=ANY($2::uuid[]) AND m.external_category_id=ANY($3::text[]) AND m.child_category_id IS NOT NULL
      )
      ORDER BY c.id
      FOR UPDATE`,
    [productId, supplierIds, categoryIds],
  );
  await client.query(
    "SELECT id FROM product_media WHERE product_id=$1 AND type='image' ORDER BY id FOR UPDATE",
    [productId],
  );
}

async function activateTooniesPublication(client: Queryable, productId: string): Promise<void> {
  const supplier = await client.query<{ id: string }>("SELECT id FROM suppliers WHERE slug='toonies' FOR UPDATE");
  if (!supplier.rows[0]) return;
  const warehouse = await client.query<{ id: string }>("SELECT id FROM warehouses WHERE code='TOONIES' FOR UPDATE");
  const warehouseId = warehouse.rows[0]?.id ?? (await client.query<{ id: string }>(
    "INSERT INTO warehouses(name,code,country_code,active) VALUES('Toonies Supplier','TOONIES','CN',true) RETURNING id",
  )).rows[0]?.id;
  if (!warehouseId) throw new Error("Toonies warehouse could not be initialized.");
  const links = await client.query<{
    productId: string;
    variantId: string | null;
    catalogueVariantId: string | null;
    itemStock: number | string;
    variantStock: number | string | null;
  }>(
    `SELECT l.product_id AS "productId",l.variant_id AS "variantId",l.catalogue_variant_id AS "catalogueVariantId",
            i.stock AS "itemStock",v.stock AS "variantStock"
       FROM supplier_product_links l
       JOIN supplier_catalogue_items i ON i.id=l.catalogue_item_id
       LEFT JOIN supplier_catalogue_variants v ON v.id=l.catalogue_variant_id
      WHERE l.product_id=$1 AND l.supplier_id=$2
      ORDER BY l.id`,
    [productId, supplier.rows[0].id],
  );
  for (const link of links.rows) {
    const stock = Math.max(0, Number(link.variantStock ?? link.itemStock ?? 0));
    if (link.variantId) {
      await client.query(
        `INSERT INTO inventory(warehouse_id,variant_id,quantity_on_hand,quantity_reserved,active)
         VALUES($1,$2,$3,0,true)
         ON CONFLICT(warehouse_id,variant_id) DO UPDATE
         SET quantity_on_hand=GREATEST(EXCLUDED.quantity_on_hand,inventory.quantity_reserved),
             active=true,updated_at=now()`,
        [warehouseId, link.variantId, stock],
      );
      await client.query("UPDATE product_variants SET active=true,updated_at=now() WHERE id=$1", [link.variantId]);
    } else {
      await client.query(
        `INSERT INTO inventory(warehouse_id,product_id,quantity_on_hand,quantity_reserved,active)
         VALUES($1,$2,$3,0,true)
         ON CONFLICT(warehouse_id,product_id) DO UPDATE
         SET quantity_on_hand=GREATEST(EXCLUDED.quantity_on_hand,inventory.quantity_reserved),
             active=true,updated_at=now()`,
        [warehouseId, link.productId, stock],
      );
    }
  }
}

async function releaseOwnedRedirectOrReject(
  client: Queryable,
  entityType: "product" | "category" | "brand",
  entityId: string | undefined,
  slug: string,
): Promise<void> {
  // Catalog mutations are infrequent; serializing slug claims per entity type
  // closes the live-slug versus redirect-history race across separate tables.
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`catalog-slug:${entityType}`]);
  const reserved = await client.query<{ entityId: string }>(
    `SELECT entity_id AS "entityId" FROM slug_redirects WHERE entity_type=$1 AND old_slug=$2 FOR UPDATE`,
    [entityType, slug],
  );
  if (!reserved.rows[0]) return;
  if (!entityId || reserved.rows[0].entityId !== entityId) {
    throw new AppError(409, "SLUG_RESERVED", "This slug is reserved by a prior catalog URL.");
  }
  await client.query("DELETE FROM slug_redirects WHERE entity_type=$1 AND old_slug=$2", [entityType, slug]);
}

async function upsertAttributeValue(client: Queryable, attributeName: string, value: string): Promise<{ attributeId: string; valueId: string }> {
  const attribute = await client.query<{ id: string }>(
    `INSERT INTO product_attributes (name, slug)
     VALUES ($1, $2)
     ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, updated_at = now()
     RETURNING id`,
    [attributeName.trim(), slugify(attributeName)],
  );
  const attributeId = attribute.rows[0]?.id;
  if (!attributeId) throw new Error("Product attribute could not be saved.");
  const attributeValue = await client.query<{ id: string }>(
    `INSERT INTO attribute_values (attribute_id, value)
     VALUES ($1, $2)
     ON CONFLICT (attribute_id, value) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
     RETURNING id`,
    [attributeId, value.trim()],
  );
  const valueId = attributeValue.rows[0]?.id;
  if (!valueId) throw new Error("Product attribute value could not be saved.");
  return { attributeId, valueId };
}

function validateVariantOptions(input: ProductInput): void {
  const declared = new Map(input.options.map((option) => [
    option.name.trim().toLowerCase(),
    new Set(option.values.map((value) => value.trim().toLowerCase())),
  ]));
  const combinations = new Set<string>();
  const skus = new Set<string>();
  for (const variant of input.variants) {
    const normalizedOptions = variant.optionValues
      .map((option) => [option.attribute.trim().toLowerCase(), option.value.trim().toLowerCase()] as const)
      .sort(([left], [right]) => left.localeCompare(right));
    const combination = JSON.stringify(normalizedOptions);
    if (combinations.has(combination)) throw new AppError(400, "DUPLICATE_VARIANT_COMBINATION", "Each variant option combination must be unique.");
    combinations.add(combination);
    const normalizedSku = variant.sku.trim().toLowerCase();
    if (skus.has(normalizedSku)) throw new AppError(400, "DUPLICATE_VARIANT_SKU", "Variant SKUs must be unique.");
    skus.add(normalizedSku);
    const seenAttributes = new Set<string>();
    for (const option of normalizedOptions) {
      if (seenAttributes.has(option[0])) throw new AppError(400, "DUPLICATE_VARIANT_OPTION", "A variant cannot repeat an option.");
      seenAttributes.add(option[0]);
      const allowedValues = declared.get(option[0]);
      if (declared.size && (!allowedValues || !allowedValues.has(option[1]))) {
        throw new AppError(400, "INVALID_VARIANT_OPTION", "Every variant option must be declared in the product options.");
      }
    }
  }
}

async function saveVariants(client: Queryable, productId: string, input: ProductInput): Promise<void> {
  validateVariantOptions(input);
  for (const variant of input.variants) {
    let variantId = variant.id;
    if (variantId) {
      const updated = await client.query(
        `UPDATE product_variants
            SET sku = $1, barcode = $2, title = $3, cost_price = $4, base_price = $5,
                weight = $6, minimum_order_quantity = $7, active = $8, updated_at = now()
          WHERE id = $9 AND product_id = $10`,
        [variant.sku.trim(), variant.barcode, variant.title.trim(), variant.costPrice ?? null, variant.basePrice ?? null, variant.weight ?? null, variant.minimumOrderQuantity, variant.active, variantId, productId],
      );
      if (updated.rowCount !== 1) throw new AppError(404, "VARIANT_NOT_FOUND", "The requested variant does not belong to this product.");
    } else {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO product_variants (product_id, sku, barcode, title, cost_price, base_price, weight, minimum_order_quantity, active)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING id`,
        [productId, variant.sku.trim(), variant.barcode, variant.title.trim(), variant.costPrice ?? null, variant.basePrice ?? null, variant.weight ?? null, variant.minimumOrderQuantity, variant.active],
      );
      variantId = inserted.rows[0]?.id;
    }
    if (!variantId) throw new Error("Variant could not be saved.");
    await client.query("DELETE FROM variant_attribute_values WHERE variant_id = $1", [variantId]);
    for (const option of variant.optionValues) {
      const pair = await upsertAttributeValue(client, option.attribute, option.value);
      await client.query(
        `INSERT INTO variant_attribute_values (variant_id, attribute_id, attribute_value_id)
         VALUES ($1, $2, $3)
         ON CONFLICT (variant_id, attribute_id) DO UPDATE SET attribute_value_id = EXCLUDED.attribute_value_id`,
        [variantId, pair.attributeId, pair.valueId],
      );
    }
  }
}

async function assertTooniesCatalogPricing(client: Queryable, productId: string, input: ProductInput): Promise<void> {
  await client.query(`SELECT l.id FROM supplier_product_links l JOIN suppliers s ON s.id=l.supplier_id
    WHERE l.product_id=$1 AND s.slug='toonies' ORDER BY l.id FOR UPDATE OF l`, [productId]);
  await client.query("SELECT id FROM products WHERE id=$1 FOR UPDATE", [productId]);
  await client.query(`SELECT i.id FROM supplier_product_links l JOIN suppliers s ON s.id=l.supplier_id
    JOIN supplier_catalogue_items i ON i.id=l.catalogue_item_id WHERE l.product_id=$1 AND s.slug='toonies' ORDER BY i.id FOR UPDATE OF i`, [productId]);
  await client.query(`SELECT v.id FROM supplier_product_links l JOIN suppliers s ON s.id=l.supplier_id
    JOIN supplier_catalogue_variants v ON v.id=l.catalogue_variant_id WHERE l.product_id=$1 AND s.slug='toonies' ORDER BY v.id FOR UPDATE OF v`, [productId]);
  const links = (await client.query<any>(`SELECT l.variant_id AS "variantId",pv.base_price AS "existingVariantBasePrice",
    p.parent_sku AS "parentSku",p.weight AS "productWeight",i.minimum_order_quantity AS "itemMoq",
    v.sku_code AS "supplierSkuCode",v.minimum_order_quantity AS "variantMoq",v.weight_kg AS "variantWeight",
    CASE WHEN l.catalogue_variant_id IS NULL THEN COALESCE(i.manual_cost_override_eur,i.normalized_eur)
         ELSE COALESCE(v.manual_cost_override_eur,v.normalized_eur) END AS "authoritativeCost",
    (CASE WHEN l.catalogue_variant_id IS NULL THEN COALESCE(i.manual_cost_override_eur,i.normalized_eur)
          ELSE COALESCE(v.manual_cost_override_eur,v.normalized_eur) END)::numeric(12,2) AS "commerceCost"
    FROM supplier_product_links l JOIN suppliers s ON s.id=l.supplier_id AND s.slug='toonies'
    JOIN supplier_catalogue_items i ON i.id=l.catalogue_item_id
    LEFT JOIN supplier_catalogue_variants v ON v.id=l.catalogue_variant_id
    LEFT JOIN product_variants pv ON pv.id=l.variant_id
    JOIN products p ON p.id=l.product_id WHERE l.product_id=$1`, [productId])).rows;
  if (!links.length) return;
  const parent = links.find((link: any) => !link.variantId);
  if (parent && (
    input.parentSku.trim() !== parent.parentSku
    || Number(input.weight) !== Number(parent.productWeight)
    || Number(input.minimumOrderQuantity) !== Number(parent.itemMoq)
  )) {
    throw new AppError(409, "TOONIES_OPERATIONAL_FIELDS_MANAGED", "Toonies SKU, weight, and minimum order quantity are supplier-managed.");
  }
  const linkedVariants = new Map(links.filter((link: any) => link.variantId).map((link: any) => [link.variantId, link]));
  if (input.variants.some((variant) => !variant.id || !linkedVariants.has(variant.id)) ||
      [...linkedVariants.keys()].some((id) => !input.variants.some((variant) => variant.id === id))) {
    throw new AppError(409, "TOONIES_VARIANTS_MANAGED", "Toonies variant identity and linkage are supplier-managed.");
  }
  for (const link of links) {
    const authoritativeCost = Number(link.authoritativeCost);
    if (!Number.isFinite(authoritativeCost) || authoritativeCost <= 0) throw new AppError(409, "TOONIES_AUTHORITATIVE_COST_UNAVAILABLE", "The current authoritative Toonies cost is unavailable.");
    if (!link.variantId) {
      if (Number(input.costPrice).toFixed(2) !== Number(link.commerceCost).toFixed(2)) throw new AppError(409, "TOONIES_COST_MANAGED", "Toonies merchandise cost is supplier-managed and cannot be changed in the product editor.");
      assertMerchandisePriceFloor({ unitCost: authoritativeCost, merchandiseRevenue: Number(input.basePrice), code: "MANUAL_PRICE_BELOW_COST", message: "The product base price cannot be below authoritative Toonies merchandise cost." });
      continue;
    }
    const variant = input.variants.find((candidate) => candidate.id === link.variantId);
    if (variant && (
      variant.sku.trim() !== `TOONIES-${link.supplierSkuCode}`.slice(0, 100)
      || Number(variant.minimumOrderQuantity) !== Number(link.variantMoq)
      || Number(variant.weight) !== Number(link.variantWeight)
    )) {
      throw new AppError(409, "TOONIES_OPERATIONAL_FIELDS_MANAGED", "Toonies SKU, weight, and minimum order quantity are supplier-managed.");
    }
    if (variant && (variant.costPrice == null || Number(variant.costPrice).toFixed(2) !== Number(link.commerceCost).toFixed(2))) throw new AppError(409, "TOONIES_COST_MANAGED", "Toonies variant cost is supplier-managed and cannot be changed in the product editor.");
    const effectiveBasePrice = variant ? variant.basePrice ?? input.basePrice : link.existingVariantBasePrice ?? input.basePrice;
    assertMerchandisePriceFloor({ unitCost: authoritativeCost, merchandiseRevenue: Number(effectiveBasePrice), code: "MANUAL_PRICE_BELOW_COST", message: "The variant base price cannot be below authoritative Toonies merchandise cost." });
  }
}

/**
 * Final publication boundary for supplier-linked products. This deliberately
 * accepts a transaction-compatible client so callers cannot publish first and
 * validate supplier state in a later transaction.
 */
export async function assertProductPublicationReady(client: Queryable, productId: string): Promise<void> {
  await lockTooniesPublicationDependencies(client, productId);
  const product = await client.query<{
    id: string;
    status: string;
    publishedAt: Date | string | null;
    basePrice: string | number | null;
    weight: string | number | null;
    displayWeightKg: string | number | null;
    vatClassifiedAt: Date | string | null;
    categoryActive: boolean;
    categoryParentId: string | null;
    parentActive: boolean | null;
    managedMedia: boolean;
  }>(
    `SELECT p.id,p.status,p.published_at AS "publishedAt",p.base_price AS "basePrice",
            p.weight,p.display_weight_kg AS "displayWeightKg",p.vat_classified_at AS "vatClassifiedAt",c.active AS "categoryActive",
            c.parent_id AS "categoryParentId",parent.active AS "parentActive",
            EXISTS (
              SELECT 1 FROM product_media pm
               WHERE pm.product_id=p.id AND pm.type='image'
                 AND pm.url LIKE '/catalog-media/%'
            ) AS "managedMedia"
       FROM products p
       JOIN categories c ON c.id=p.category_id
       LEFT JOIN categories parent ON parent.id=c.parent_id
      WHERE p.id=$1
      FOR UPDATE OF p`,
    [productId],
  );
  const row = product.rows[0];
  if (!row) throw new AppError(404, "PRODUCT_NOT_FOUND", "The requested product was not found.");
  const links = await client.query<{
    supplierActive: boolean;
    supplierPublicationEnabled: boolean;
    supplierComplianceExcluded: boolean;
    mappingStatus: string | null;
    mappingPublicationEnabled: boolean | null;
    mappingComplianceExcluded: boolean | null;
    rootId: string | null;
    rootActive: boolean | null;
    rootParentId: string | null;
    childId: string | null;
    childActive: boolean | null;
    childParentId: string | null;
    itemNeedsReview: boolean;
    itemState: string;
    itemStock: number | string;
    itemMoq: number | string;
    itemNormalizedEur: number | string | null;
    itemCurrency: string;
    itemFxFresh: boolean | null;
    itemFxRate: number | string | null;
    variantId: string | null;
    variantNeedsReview: boolean | null;
    variantState: string | null;
    variantStock: number | string | null;
    variantMoq: number | string | null;
    variantWeightKg: number | string | null;
    variantNormalizedEur: number | string | null;
    variantCurrency: string | null;
    variantFxFresh: boolean | null;
    variantFxRate: number | string | null;
    productVariantPrice: number | string | null;
    productVariantWeight: number | string | null;
    productVariantActive: boolean | null;
  }>(
    `SELECT s.active AS "supplierActive",s.publication_enabled AS "supplierPublicationEnabled",
            s.compliance_excluded AS "supplierComplianceExcluded",
            m.status AS "mappingStatus",m.publication_enabled AS "mappingPublicationEnabled",
            m.compliance_excluded AS "mappingComplianceExcluded",m.root_category_id AS "rootId",
            root.active AS "rootActive",root.parent_id AS "rootParentId",
            m.child_category_id AS "childId",child.active AS "childActive",child.parent_id AS "childParentId",
            i.needs_review AS "itemNeedsReview",i.state AS "itemState",i.stock AS "itemStock",
            i.minimum_order_quantity AS "itemMoq",i.normalized_eur AS "itemNormalizedEur",
            i.original_currency AS "itemCurrency",(itemFx.expires_at > now()) AS "itemFxFresh",
            itemFx.rate AS "itemFxRate",v.id AS "variantId",v.needs_review AS "variantNeedsReview",
            v.state AS "variantState",v.stock AS "variantStock",
            v.minimum_order_quantity AS "variantMoq",v.weight_kg AS "variantWeightKg",
            v.normalized_eur AS "variantNormalizedEur",v.original_currency AS "variantCurrency",
            (variantFx.expires_at > now()) AS "variantFxFresh",variantFx.rate AS "variantFxRate",
            pv.base_price AS "productVariantPrice",pv.weight AS "productVariantWeight",
            pv.active AS "productVariantActive"
       FROM supplier_product_links l
       JOIN suppliers s ON s.id=l.supplier_id AND s.slug='toonies'
       JOIN supplier_catalogue_items i ON i.id=l.catalogue_item_id
       LEFT JOIN supplier_category_mappings m
         ON m.supplier_id=i.supplier_id AND m.external_category_id=i.external_category_id
       LEFT JOIN categories root ON root.id=m.root_category_id
       LEFT JOIN categories child ON child.id=m.child_category_id
       LEFT JOIN fx_rate_snapshots itemFx ON itemFx.id=i.fx_rate_snapshot_id
       LEFT JOIN supplier_catalogue_variants v ON v.id=l.catalogue_variant_id
       LEFT JOIN fx_rate_snapshots variantFx ON variantFx.id=v.fx_rate_snapshot_id
       LEFT JOIN product_variants pv ON pv.id=l.variant_id
      WHERE l.product_id=$1
      FOR UPDATE OF l`,
    [productId],
  );
  if (!links.rows.length) return;
  if (!row.vatClassifiedAt) {
    throw new AppError(409, "TOONIES_VAT_CLASSIFICATION_REQUIRED", "Publication requires an explicit VAT classification. Intentional 0% must be saved by an administrator.");
  }
  if (row.status !== "active" || !row.publishedAt) {
    throw new AppError(409, "TOONIES_PUBLICATION_STATUS_INVALID", "A Toonies product must be active and published before supplier readiness can be evaluated.");
  }
  if (!row.categoryActive || (row.categoryParentId !== null && row.parentActive !== true)) {
    throw new AppError(409, "TOONIES_PUBLICATION_CATEGORY_INVALID", "Publication requires an active Lizzor category hierarchy.");
  }
  if (Number(row.basePrice) <= 0) {
    throw new AppError(409, "TOONIES_PUBLICATION_PRICE_INVALID", "Publication requires a positive selling price.");
  }
  if (!row.managedMedia) {
    throw new AppError(409, "TOONIES_PUBLICATION_MEDIA_REQUIRED", "Publication requires at least one managed product image.");
  }

  for (const link of links.rows) {
    if (!link.supplierActive || !link.supplierPublicationEnabled || link.supplierComplianceExcluded) {
      throw new AppError(409, "TOONIES_PUBLICATION_SUPPLIER_INVALID", "Publication requires an active, publication-enabled, compliant Toonies supplier.");
    }
    if (
      link.mappingStatus !== "mapped"
      || link.mappingPublicationEnabled !== true
      || link.mappingComplianceExcluded !== false
      || !link.rootId
      || link.rootActive !== true
      || link.rootParentId !== null
      || (link.childId !== null && (link.childActive !== true || link.childParentId !== link.rootId))
    ) {
      throw new AppError(409, "TOONIES_PUBLICATION_MAPPING_INVALID", "Publication requires a mapped, publication-enabled supplier category with active Lizzor targets.");
    }
    if (
      link.itemNeedsReview
      || ["Needs review", "Out of stock", "Error", "Supplier unavailable"].includes(link.itemState)
      || Number(link.itemStock) <= 0
    ) {
      throw new AppError(409, "TOONIES_PUBLICATION_REVIEW_REQUIRED", "Publication is blocked while supplier catalogue data is under review or out of stock.");
    }
    if (
      link.itemCurrency !== "CNY"
      || Number(link.itemNormalizedEur) <= 0
      || link.itemFxFresh !== true
      || Number(link.itemFxRate) <= 0
      || Number(link.itemMoq) <= 0
    ) {
      throw new AppError(409, "TOONIES_PUBLICATION_FX_INVALID", "Publication requires a fresh valid FX snapshot, normalized supplier cost, and positive MOQ.");
    }
    if (link.variantId !== null) {
      if (
        link.variantNeedsReview !== false
        || link.variantState === null
        || ["Needs review", "Out of stock", "Error", "Supplier unavailable"].includes(link.variantState)
        || Number(link.variantStock) <= 0
        || link.variantCurrency !== "CNY"
        || Number(link.variantNormalizedEur) <= 0
        || link.variantFxFresh !== true
        || Number(link.variantFxRate) <= 0
        || Number(link.variantMoq) <= 0
        || Number(link.variantWeightKg) <= 0
        || Number(link.productVariantWeight) <= 0
        || Number(link.productVariantPrice) <= 0
      ) {
        throw new AppError(409, "TOONIES_PUBLICATION_VARIANT_INVALID", "Publication requires every Toonies SKU to have fresh pricing, positive stock, MOQ, weight, and a sellable active variant.");
      }
    } else if (Number(row.weight) <= 0 && Number(row.displayWeightKg) <= 0) {
      throw new AppError(409, "TOONIES_PUBLICATION_WEIGHT_REQUIRED", "Publication requires a usable positive Toonies product weight.");
    }
  }
  await activateTooniesPublication(client, productId);
}

export async function saveProduct(input: ProductInput, id?: string): Promise<string> {
  const pool = getDatabasePool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await releaseOwnedRedirectOrReject(client, "product", id, input.slug);
    if (id) await assertTooniesCatalogPricing(client, id, input);
    let productId = id;
    let publishedAt: Date | string | null = input.status === "active" ? new Date() : null;
    if (id) {
      const existing = await client.query<{ slug: string; publishedAt: string | null }>("SELECT slug, published_at AS \"publishedAt\" FROM products WHERE id = $1 FOR UPDATE", [id]);
      if (!existing.rowCount) throw new AppError(404, "PRODUCT_NOT_FOUND", "The requested product was not found.");
      // Operational deactivation preserves the product's publication history.
      if (input.status === "inactive") publishedAt = existing.rows[0]!.publishedAt;
      const updated = await client.query(
        `UPDATE products
            SET name = $1, slug = $2, parent_sku = $3, barcode = $4, brand_id = $5, category_id = $6,
                short_description = $7, description = $8, status = $9, cost_price = $10, base_price = $11,
                 vat_rate = $12, tax_mode = $13, vat_classified_at=now(), weight = $14, minimum_order_quantity = $15, width = $16, height = $17, length = $18, featured = $19,
                   new_arrival = $20, homepage_wholesale = $21, published_at = $22, seo_title = $23, seo_description = $24, updated_at = now()
             WHERE id = $25`,
         [input.name, input.slug, input.parentSku, input.barcode, input.brandId, input.categoryId, input.shortDescription, input.description, input.status, input.costPrice, input.basePrice, input.vatRate, input.taxMode, input.weight, input.minimumOrderQuantity, input.width ?? null, input.height ?? null, input.length ?? null, input.featured, input.newArrival, input.homepageWholesale, publishedAt, input.seoTitle, input.seoDescription, id],
      );
      if (updated.rowCount !== 1) throw new AppError(404, "PRODUCT_NOT_FOUND", "The requested product was not found.");
      if (existing.rows[0]!.slug !== input.slug && input.status === "active") {
        await client.query(`INSERT INTO slug_redirects (entity_type, entity_id, old_slug)
          VALUES ('product', $1, $2)`, [id, existing.rows[0]!.slug]);
      }
    } else {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO products
           (name, slug, parent_sku, barcode, brand_id, category_id, short_description, description, status,
             cost_price, base_price, vat_rate, tax_mode, weight, minimum_order_quantity, width, height, length, featured, new_arrival, homepage_wholesale, published_at, seo_title, seo_description)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24)
         RETURNING id`,
         [input.name, input.slug, input.parentSku, input.barcode, input.brandId, input.categoryId, input.shortDescription, input.description, input.status, input.costPrice, input.basePrice, input.vatRate, input.taxMode, input.weight, input.minimumOrderQuantity, input.width ?? null, input.height ?? null, input.length ?? null, input.featured, input.newArrival, input.homepageWholesale, publishedAt, input.seoTitle, input.seoDescription],
      );
      productId = inserted.rows[0]?.id;
    }
    if (!productId) throw new Error("Product could not be saved.");
    await saveVariants(client, productId, input);
    if (input.status === "active") await assertProductPublicationReady(client, productId);
    await client.query("COMMIT");
    return productId;
  } catch (error) {
    await client.query("ROLLBACK");
    catalogConflict(error);
  } finally {
    client.release();
  }
}

function mapProduct(row: ProductRow, includeCost: boolean) {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    seoTitle: row.seoTitle,
    seoDescription: row.seoDescription,
    parentSku: row.parentSku,
    barcode: row.barcode,
    brand: row.brandId ? { id: row.brandId, name: row.brandName, slug: row.brandSlug } : null,
    category: { id: row.categoryId, name: row.categoryName, slug: row.categorySlug },
    shortDescription: row.shortDescription,
    description: row.description,
    status: row.status,
    ...(includeCost ? { costPrice: numeric(row.costPrice) } : {}),
    basePrice: numeric(row.basePrice),
    vatRate: numeric(row.vatRate),
    taxMode: row.taxMode,
    vatClassifiedAt: row.vatClassifiedAt,
    isToonies: row.isToonies,
    weight: numeric(row.weight),
    displayWeightKg: numeric(row.displayWeightKg),
    minimumOrderQuantity: Number(row.minimumOrderQuantity),
    dimensions: { width: numeric(row.width), height: numeric(row.height), length: numeric(row.length) },
    featured: row.featured,
    newArrival: row.newArrival,
    homepageWholesale: row.homepageWholesale,
    hasActiveWholesaleTier: row.hasActiveWholesaleTier ?? false,
    published: Boolean(row.publishedAt),
    publishedAt: row.publishedAt,
    variantCount: Number(row.variantCount),
    thumbnailUrl: row.thumbnailUrl,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

const sortColumns: Record<string, string> = {
  updated: "p.updated_at",
  name: "p.name",
  price: "p.base_price",
  status: "p.status",
  created: "p.created_at",
};

export interface ProductListFilters {
  page?: number;
  pageSize?: number;
  search?: string;
  status?: string;
  categoryId?: string;
  brandId?: string;
  featured?: boolean;
  newArrival?: boolean;
  homepageWholesale?: boolean;
  published?: boolean;
  hasVariants?: boolean;
  sort?: string;
  direction?: "asc" | "desc";
  ids?: string[];
  /** Expand a public category filter to its descendants while retaining the
   * exact category filter used by admin operations. */
  includeCategoryDescendants?: boolean;
  /** Internal, parameterized predicates for bounded storefront listing filters. */
  additionalWhere?: { clauses: string[]; values: unknown[] };
  /** Apply storefront category visibility in addition to product status/publication. */
  publicOnly?: boolean;
}

function productWhere(filters: ProductListFilters): { clause: string; values: unknown[] } {
  const clauses = ["1 = 1"];
  const values: unknown[] = [];
  if (filters.publicOnly) {
    clauses.push("c.active = true AND (c.parent_id IS NULL OR EXISTS (SELECT 1 FROM categories public_parent WHERE public_parent.id = c.parent_id AND public_parent.active = true))");
  }
  if (filters.search?.trim()) {
    values.push(`%${filters.search.trim()}%`);
    clauses.push(`(
      p.name ILIKE $${values.length} OR p.parent_sku ILIKE $${values.length} OR p.barcode ILIKE $${values.length}
      OR b.name ILIKE $${values.length} OR c.name ILIKE $${values.length}
      OR EXISTS (SELECT 1 FROM product_variants sv WHERE sv.product_id = p.id AND (sv.sku ILIKE $${values.length} OR sv.barcode ILIKE $${values.length}))
    )`);
  }
  if (filters.status) {
    values.push(filters.status);
    clauses.push(`p.status = $${values.length}`);
  }
  if (filters.categoryId) {
    values.push(filters.categoryId);
    clauses.push(filters.includeCategoryDescendants
      ? `p.category_id IN (WITH RECURSIVE category_tree AS (
           SELECT c.id FROM categories c WHERE c.id = $${values.length} AND c.active = true
           UNION ALL
           SELECT child.id FROM categories child JOIN category_tree parent ON child.parent_id = parent.id
            WHERE child.active = true
         ) SELECT id FROM category_tree)`
      : `p.category_id = $${values.length}`);
  }
  if (filters.brandId) {
    values.push(filters.brandId);
    clauses.push(`p.brand_id = $${values.length}`);
  }
  if (filters.featured !== undefined) {
    values.push(filters.featured);
    clauses.push(`p.featured = $${values.length}`);
  }
  if (filters.newArrival !== undefined) {
    values.push(filters.newArrival);
    clauses.push(`p.new_arrival = $${values.length}`);
  }
  if (filters.homepageWholesale !== undefined) {
    values.push(filters.homepageWholesale);
    clauses.push(`p.homepage_wholesale = $${values.length}`);
  }
  if (filters.published !== undefined) clauses.push(filters.published ? "p.published_at IS NOT NULL" : "p.published_at IS NULL");
  if (filters.hasVariants !== undefined) clauses.push(filters.hasVariants
    ? "EXISTS (SELECT 1 FROM product_variants hv WHERE hv.product_id = p.id)"
    : "NOT EXISTS (SELECT 1 FROM product_variants hv WHERE hv.product_id = p.id)");
  if (filters.ids?.length) {
    values.push(filters.ids);
    clauses.push(`p.id = ANY($${values.length}::uuid[])`);
  }
  if (filters.additionalWhere) {
    const offset = values.length;
    for (const clause of filters.additionalWhere.clauses) {
      clauses.push(clause.replace(/\$(\d+)/g, (_match, index: string) => `$${Number(index) + offset}`));
    }
    values.push(...filters.additionalWhere.values);
  }
  return { clause: clauses.join(" AND "), values };
}

export async function listProducts(filters: ProductListFilters = {}, includeCost = false) {
  const pool = getDatabasePool();
  const page = Math.max(1, Math.floor(filters.page ?? 1));
  const pageSize = Math.min(100, Math.max(1, Math.floor(filters.pageSize ?? 25)));
  const where = productWhere(filters);
  const count = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count
       FROM products p
       LEFT JOIN brands b ON b.id = p.brand_id
       JOIN categories c ON c.id = p.category_id
      WHERE ${where.clause}`,
    where.values,
  );
  const sort = sortColumns[filters.sort ?? "updated"] ?? sortColumns.updated;
  const direction = filters.direction === "asc" ? "ASC" : "DESC";
  const offset = (page - 1) * pageSize;
  const values = [...where.values, pageSize, offset];
  const rows = await pool.query<ProductRow>(
    `SELECT p.id, p.name, p.slug, p.seo_title AS "seoTitle", p.seo_description AS "seoDescription", p.parent_sku AS "parentSku", p.barcode, p.brand_id AS "brandId",
            b.name AS "brandName", b.slug AS "brandSlug", p.category_id AS "categoryId", c.name AS "categoryName", c.slug AS "categorySlug",
            p.short_description AS "shortDescription", p.description, p.status,
              p.cost_price AS "costPrice", p.base_price AS "basePrice", p.vat_rate AS "vatRate", p.tax_mode AS "taxMode", p.vat_classified_at AS "vatClassifiedAt",
              EXISTS(SELECT 1 FROM supplier_product_links spl JOIN suppliers sp ON sp.id=spl.supplier_id WHERE spl.product_id=p.id AND sp.slug='toonies') AS "isToonies",
              p.weight, p.display_weight_kg AS "displayWeightKg", p.minimum_order_quantity AS "minimumOrderQuantity", p.width, p.height, p.length, p.featured, p.new_arrival AS "newArrival", p.homepage_wholesale AS "homepageWholesale",
             EXISTS (
               SELECT 1 FROM price_tiers pt
                WHERE pt.active=true AND pt.min_quantity>1
                  AND (pt.product_id=p.id OR pt.variant_id IN (
                    SELECT pv.id FROM product_variants pv WHERE pv.product_id=p.id AND pv.active=true
                  ))
             ) AS "hasActiveWholesaleTier",
            p.published_at AS "publishedAt", p.created_at AS "createdAt", p.updated_at AS "updatedAt",
            (SELECT count(*)::text FROM product_variants pv WHERE pv.product_id = p.id) AS "variantCount",
            (SELECT pm.url FROM product_media pm WHERE pm.product_id = p.id AND pm.type = 'image'
             ORDER BY pm.is_primary DESC, pm.sort_order ASC, pm.created_at ASC LIMIT 1) AS "thumbnailUrl"
       FROM products p
       LEFT JOIN brands b ON b.id = p.brand_id
       JOIN categories c ON c.id = p.category_id
      WHERE ${where.clause}
      ORDER BY ${sort} ${direction}, p.id
      LIMIT $${values.length - 1} OFFSET $${values.length}`,
    values,
  );
  return {
    items: rows.rows.map((row) => mapProduct(row, includeCost)),
    meta: { page, pageSize, total: Number(count.rows[0]?.count ?? 0), hasNext: offset + rows.rows.length < Number(count.rows[0]?.count ?? 0) },
  };
}

export type HomepageProductCard = {
  id: string;
  name: string;
  slug: string;
  parentSku: string;
  brand: { id: string; name: string; slug: string } | null;
  category: { id: string; name: string; slug: string };
  shortDescription: string | null;
  price: number;
  nextTier: { minQuantity: number; unitPrice: number; additionalQuantity: number } | null;
  available: number;
  availability: "in_stock" | "low_stock" | "out_of_stock";
  featured: boolean;
  newArrival: boolean;
  homepageWholesale: boolean;
  homepageWholesaleOffer: { minQuantity: number; unitPrice: number; additionalQuantity: number } | null;
  thumbnailUrl: string | null;
  variantCount: number;
};

/**
 * Retrieves both homepage rails in one bounded, set-based query.  The two
 * candidate CTEs are deliberately capped before the detail joins, so media,
 * tiers and inventory work is limited to at most ten product ids.
 */
type HomepageSelectedCard = HomepageProductCard & { bestSeller: boolean; liveWholesale: boolean };

export const homepageProductsSql = `WITH merchandised AS (
       SELECT p.id, p.featured, p.homepage_wholesale, p.updated_at
         FROM products p
         WHERE p.featured = true AND p.status = 'active' AND p.published_at IS NOT NULL
           AND EXISTS (SELECT 1 FROM categories pc WHERE pc.id=p.category_id AND pc.active=true
             AND (pc.parent_id IS NULL OR EXISTS (SELECT 1 FROM categories pp WHERE pp.id=pc.parent_id AND pp.active=true)))
       UNION ALL
       SELECT p.id, p.featured, p.homepage_wholesale, p.updated_at
         FROM products p
         WHERE p.homepage_wholesale = true AND p.status = 'active' AND p.published_at IS NOT NULL
           AND EXISTS (SELECT 1 FROM categories pc WHERE pc.id=p.category_id AND pc.active=true
             AND (pc.parent_id IS NULL OR EXISTS (SELECT 1 FROM categories pp WHERE pp.id=pc.parent_id AND pp.active=true)))
     ), merchandise AS (
       SELECT id, bool_or(featured) AS featured, bool_or(homepage_wholesale) AS homepage_wholesale, max(updated_at) AS updated_at
         FROM merchandised GROUP BY id
     ), direct_stock AS (
       SELECT m.id AS product_id, sum(i.quantity_on_hand-i.quantity_reserved) AS available
         FROM merchandise m JOIN inventory i ON i.product_id=m.id AND i.active=true GROUP BY m.id
     ), active_variant_stock AS (
       SELECT pv.id AS variant_id, pv.product_id, sum(i.quantity_on_hand-i.quantity_reserved) AS available
         FROM merchandise m JOIN product_variants pv ON pv.product_id=m.id AND pv.active=true
         JOIN inventory i ON i.variant_id=pv.id AND i.active=true GROUP BY pv.id,pv.product_id
     ), stock AS (
       SELECT product_id, sum(available)::text AS available
         FROM (SELECT * FROM direct_stock UNION ALL SELECT product_id,available FROM active_variant_stock) sources
        GROUP BY product_id HAVING sum(available)>0
     ), wholesale_offer_candidates AS (
       SELECT m.id AS product_id, pt.min_quantity, pt.unit_price
         FROM merchandise m JOIN price_tiers pt ON pt.product_id=m.id AND pt.variant_id IS NULL
        WHERE pt.active=true AND pt.min_quantity>1
       UNION ALL
       SELECT avs.product_id, pt.min_quantity, pt.unit_price
         FROM active_variant_stock avs JOIN price_tiers pt ON pt.variant_id=avs.variant_id
        WHERE avs.available>0 AND pt.active=true AND pt.min_quantity>1
     ), wholesale_offers AS (
       SELECT DISTINCT ON (product_id) product_id,min_quantity,unit_price
         FROM wholesale_offer_candidates ORDER BY product_id,min_quantity,unit_price
     ), featured_candidates AS (
       SELECT m.id, 'best'::text AS section
         FROM merchandise m JOIN stock ON stock.product_id=m.id
        WHERE m.featured=true ORDER BY m.updated_at DESC,m.id LIMIT 6
     ), wholesale_candidates AS (
       SELECT m.id, 'wholesale'::text AS section
         FROM merchandise m JOIN stock ON stock.product_id=m.id JOIN wholesale_offers wo ON wo.product_id=m.id
        WHERE m.homepage_wholesale=true ORDER BY m.updated_at DESC,m.id LIMIT 4
     ), selected AS (
       SELECT id,
              bool_or(section = 'best') AS "bestSeller",
              bool_or(section = 'wholesale') AS "liveWholesale"
         FROM (SELECT * FROM featured_candidates UNION ALL SELECT * FROM wholesale_candidates) rails
        GROUP BY id
      )
     SELECT selected."bestSeller", selected."liveWholesale",
            p.id, p.name, p.slug, p.parent_sku AS "parentSku",
            p.brand_id AS "brandId", b.name AS "brandName", b.slug AS "brandSlug",
            p.category_id AS "categoryId", c.name AS "categoryName", c.slug AS "categorySlug",
            p.short_description AS "shortDescription", p.featured, p.new_arrival AS "newArrival",
            p.homepage_wholesale AS "homepageWholesale", stock.available,
            COALESCE(normal_tier.unit_price, p.base_price)::text AS price,
            next_tier.min_quantity AS "nextTierMinQuantity",
            next_tier.unit_price AS "nextTierUnitPrice",
            media.url AS "thumbnailUrl",
            COALESCE(variants.count, 0)::text AS "variantCount",
            wholesale_offer.min_quantity AS "offerMinQuantity",
            wholesale_offer.unit_price AS "offerUnitPrice"
       FROM selected
       JOIN products p ON p.id = selected.id
       JOIN categories c ON c.id = p.category_id
       LEFT JOIN brands b ON b.id = p.brand_id
       JOIN stock ON stock.product_id = p.id
       LEFT JOIN LATERAL (
         SELECT pt.min_quantity, pt.unit_price
           FROM price_tiers pt
          WHERE pt.product_id = p.id AND pt.variant_id IS NULL AND pt.active = true
            AND pt.min_quantity <= 1 AND (pt.max_quantity IS NULL OR pt.max_quantity >= 1)
          ORDER BY pt.min_quantity, pt.id
          LIMIT 1
       ) normal_tier ON true
       LEFT JOIN LATERAL (
         SELECT pt.min_quantity, pt.unit_price
           FROM price_tiers pt
          WHERE pt.product_id = p.id AND pt.variant_id IS NULL AND pt.active = true AND pt.min_quantity > 1
          ORDER BY pt.min_quantity, pt.id
          LIMIT 1
       ) next_tier ON true
       LEFT JOIN LATERAL (
         SELECT pm.url
           FROM product_media pm
          WHERE pm.product_id = p.id AND pm.type = 'image'
          ORDER BY pm.is_primary DESC, pm.sort_order, pm.created_at
          LIMIT 1
       ) media ON true
       LEFT JOIN LATERAL (
         SELECT count(*) AS count FROM product_variants pv WHERE pv.product_id = p.id
       ) variants ON true
       LEFT JOIN wholesale_offers wholesale_offer ON wholesale_offer.product_id=p.id
      ORDER BY selected."bestSeller" DESC, selected."liveWholesale" DESC, p.updated_at DESC, p.id`;

export async function homepageProducts(): Promise<{ bestSellers: HomepageSelectedCard[]; liveWholesalePricing: HomepageSelectedCard[] }> {
  const rows = await getDatabasePool().query<any>(homepageProductsSql);
  const cards: HomepageSelectedCard[] = rows.rows.map((row: any): HomepageSelectedCard => {
    const available = Math.max(0, Number(row.available));
    const nextTier = row.nextTierMinQuantity === null ? null : {
      minQuantity: Number(row.nextTierMinQuantity),
      unitPrice: Number(row.nextTierUnitPrice),
      additionalQuantity: Number(row.nextTierMinQuantity) - 1,
    };
    return {
      id: row.id, name: row.name, slug: row.slug, parentSku: row.parentSku,
      brand: row.brandId ? { id: row.brandId, name: row.brandName, slug: row.brandSlug } : null,
      category: { id: row.categoryId, name: row.categoryName, slug: row.categorySlug },
      shortDescription: row.shortDescription, price: Number(row.price), nextTier, available,
      availability: available <= 5 ? "low_stock" : "in_stock",
      featured: row.featured, newArrival: row.newArrival, homepageWholesale: row.homepageWholesale,
      homepageWholesaleOffer: row.offerMinQuantity === null ? null : {
        minQuantity: Number(row.offerMinQuantity), unitPrice: Number(row.offerUnitPrice),
        additionalQuantity: Number(row.offerMinQuantity) - 1,
      },
      thumbnailUrl: row.thumbnailUrl, variantCount: Number(row.variantCount),
      bestSeller: row.bestSeller, liveWholesale: row.liveWholesale,
    };
  });
  return {
    bestSellers: cards.filter((card) => card.bestSeller).slice(0, 6),
    liveWholesalePricing: cards.filter((card) => card.liveWholesale).slice(0, 4),
  };
}

export async function getProduct(id: string, includeCost = false, publicOnly = false) {
  const pool = getDatabasePool();
  const row = await pool.query<ProductRow>(
    `SELECT p.id, p.name, p.slug, p.seo_title AS "seoTitle", p.seo_description AS "seoDescription", p.parent_sku AS "parentSku", p.barcode, p.brand_id AS "brandId",
            b.name AS "brandName", b.slug AS "brandSlug", p.category_id AS "categoryId", c.name AS "categoryName", c.slug AS "categorySlug",
            p.short_description AS "shortDescription", p.description, p.status,
              p.cost_price AS "costPrice", p.base_price AS "basePrice", p.vat_rate AS "vatRate", p.tax_mode AS "taxMode", p.vat_classified_at AS "vatClassifiedAt",
              EXISTS(SELECT 1 FROM supplier_product_links spl JOIN suppliers sp ON sp.id=spl.supplier_id WHERE spl.product_id=p.id AND sp.slug='toonies') AS "isToonies",
             p.weight, p.display_weight_kg AS "displayWeightKg", p.minimum_order_quantity AS "minimumOrderQuantity", p.width, p.height, p.length, p.featured, p.new_arrival AS "newArrival", p.homepage_wholesale AS "homepageWholesale",
             EXISTS (
               SELECT 1 FROM price_tiers pt
                WHERE pt.active=true AND pt.min_quantity>1
                  AND (pt.product_id=p.id OR pt.variant_id IN (
                    SELECT pv.id FROM product_variants pv WHERE pv.product_id=p.id AND pv.active=true
                  ))
             ) AS "hasActiveWholesaleTier",
            p.published_at AS "publishedAt", p.created_at AS "createdAt", p.updated_at AS "updatedAt",
            (SELECT count(*)::text FROM product_variants pv WHERE pv.product_id = p.id) AS "variantCount",
            (SELECT pm.url FROM product_media pm WHERE pm.product_id = p.id AND pm.type = 'image'
             ORDER BY pm.is_primary DESC, pm.sort_order ASC, pm.created_at ASC LIMIT 1) AS "thumbnailUrl"
       FROM products p
       LEFT JOIN brands b ON b.id = p.brand_id
       JOIN categories c ON c.id = p.category_id
       WHERE p.id = $1${publicOnly ? ` AND p.status = 'active' AND p.published_at IS NOT NULL
         AND c.active = true AND (c.parent_id IS NULL OR EXISTS (SELECT 1 FROM categories public_parent WHERE public_parent.id=c.parent_id AND public_parent.active=true))` : ""}`,
    [id],
  );
  const product = row.rows[0];
  if (!product) throw new AppError(404, "PRODUCT_NOT_FOUND", "The requested product was not found.");
  const [variants, media, options] = await Promise.all([
    pool.query(`SELECT id, sku, barcode, title, cost_price AS "costPrice", base_price AS "basePrice", weight, minimum_order_quantity AS "minimumOrderQuantity", active,
                       created_at AS "createdAt", updated_at AS "updatedAt"
                  FROM product_variants WHERE product_id = $1 ORDER BY created_at, id`, [id]),
    pool.query(`SELECT id, variant_id AS "variantId", type, url, alt_text AS "altText", is_primary AS "isPrimary", sort_order AS "sortOrder", source_url AS "sourceUrl", source_sha256 AS "sourceSha256", source_workflow AS "sourceWorkflow", source_supplier_id AS "sourceSupplierId", source_catalogue_item_id AS "sourceCatalogueItemId", source_catalogue_variant_id AS "sourceCatalogueVariantId", created_at AS "createdAt"
                  FROM product_media WHERE product_id = $1 ORDER BY is_primary DESC, sort_order, created_at`, [id]),
    pool.query(`SELECT vav.variant_id AS "variantId", pa.name AS attribute, av.value
                  FROM variant_attribute_values vav
                  JOIN product_attributes pa ON pa.id = vav.attribute_id
                  JOIN attribute_values av ON av.id = vav.attribute_value_id
                 WHERE vav.variant_id IN (SELECT id FROM product_variants WHERE product_id = $1)
                 ORDER BY pa.name, av.value`, [id]),
  ]);
  const optionMap = new Map<string, Array<{ attribute: string; value: string }>>();
  for (const option of options.rows as Array<{ variantId: string; attribute: string; value: string }>) {
    const list = optionMap.get(option.variantId) ?? [];
    list.push({ attribute: option.attribute, value: option.value });
    optionMap.set(option.variantId, list);
  }
  return {
    ...mapProduct(product, includeCost),
    variants: variants.rows.map((variant) => ({
      id: variant.id,
      sku: variant.sku,
      barcode: variant.barcode,
      title: variant.title,
      ...(includeCost ? { costPrice: numeric(variant.costPrice) } : {}),
      basePrice: numeric(variant.basePrice),
      weight: numeric(variant.weight),
      minimumOrderQuantity: Number(variant.minimumOrderQuantity),
      active: variant.active,
      optionValues: optionMap.get(variant.id) ?? [],
    })),
    media: media.rows,
    options: [...new Set((options.rows as Array<{ attribute: string }>).map((option) => option.attribute))],
  };
}

export async function archiveProduct(id: string, restore = false): Promise<void> {
  const pool = getDatabasePool();
  if (!restore) {
    const result = await pool.query(
      `UPDATE products SET status = 'archived', published_at = NULL, updated_at = now() WHERE id = $1`,
      [id],
    );
    if (result.rowCount !== 1) throw new AppError(404, "PRODUCT_NOT_FOUND", "The requested product was not found.");
    return;
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(
      `UPDATE products SET status = 'active', published_at = now(), updated_at = now() WHERE id = $1`,
      [id],
    );
    if (result.rowCount !== 1) throw new AppError(404, "PRODUCT_NOT_FOUND", "The requested product was not found.");
    await assertProductPublicationReady(client, id);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** Reversible operational lifecycle; archive/restore remains a separate workflow. */
export async function setProductOperationalStatus(id: string, status: "active" | "inactive"): Promise<void> {
  const pool = getDatabasePool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(
      `UPDATE products
          SET status=$1::product_status,
              published_at=CASE WHEN $1::product_status='active'::product_status THEN COALESCE(published_at, now()) ELSE published_at END,
              updated_at=now()
        WHERE id=$2 AND status=$3::product_status`,
      [status, id, status === "active" ? "inactive" : "active"],
    );
    if (result.rowCount !== 1) {
      const product = await client.query<{ status: string }>("SELECT status FROM products WHERE id=$1 FOR UPDATE", [id]);
      if (!product.rowCount) throw new AppError(404, "PRODUCT_NOT_FOUND", "The requested product was not found.");
      throw new AppError(409, "INVALID_PRODUCT_LIFECYCLE_TRANSITION", "Only active products can be deactivated and only inactive products can be reactivated.");
    }
    if (status === "active") await assertProductPublicationReady(client, id);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export interface ProductDeletionEligibility {
  eligible: boolean;
  product: { id: string; name: string; parentSku: string; status: string };
  blockers: {
    cartItems: number;
    orderItems: number;
    inventoryReservations: number;
    inventoryMovements: number;
    promotionUsages: number;
  };
  removable: {
    variants: number;
    media: number;
    priceTiers: number;
    inventoryRecords: number;
    promotionLinks: number;
    wishlistItems: number;
    recentlyViewed: number;
    slugRedirects: number;
  };
}

async function productDeletionEligibility(client: Queryable, id: string, lock = false): Promise<ProductDeletionEligibility> {
  const product = await client.query<{ id: string; name: string; parentSku: string; status: string }>(
    `SELECT id, name, parent_sku AS "parentSku", status
       FROM products WHERE id=$1${lock ? " FOR UPDATE" : ""}`,
    [id],
  );
  if (!product.rows[0]) throw new AppError(404, "PRODUCT_NOT_FOUND", "The requested product was not found.");
  const counts = await client.query<Record<string, string>>(
    `WITH variants AS (SELECT id FROM product_variants WHERE product_id=$1),
          product_inventory AS (
            SELECT id FROM inventory
             WHERE product_id=$1 OR variant_id IN (SELECT id FROM variants)
          )
     SELECT
       (SELECT count(*) FROM cart_items WHERE product_id=$1 OR variant_id IN (SELECT id FROM variants))::text AS "cartItems",
       (SELECT count(*) FROM order_items WHERE product_id=$1 OR variant_id IN (SELECT id FROM variants))::text AS "orderItems",
       (SELECT count(*) FROM inventory_reservations WHERE inventory_id IN (SELECT id FROM product_inventory))::text AS "inventoryReservations",
       (SELECT count(*) FROM inventory_movements WHERE product_id=$1 OR variant_id IN (SELECT id FROM variants))::text AS "inventoryMovements",
       (SELECT count(*) FROM promotion_usages pu
         WHERE pu.campaign_id IN (SELECT pp.campaign_id FROM promotion_products pp WHERE pp.product_id=$1))::text AS "promotionUsages",
       (SELECT count(*) FROM variants)::text AS "variants",
       (SELECT count(*) FROM product_media WHERE product_id=$1)::text AS "media",
       (SELECT count(*) FROM price_tiers WHERE product_id=$1 OR variant_id IN (SELECT id FROM variants))::text AS "priceTiers",
       (SELECT count(*) FROM product_inventory)::text AS "inventoryRecords",
       (SELECT count(*) FROM promotion_products WHERE product_id=$1)::text AS "promotionLinks",
       (SELECT count(*) FROM wishlist_items WHERE product_id=$1)::text AS "wishlistItems",
       (SELECT count(*) FROM recently_viewed_products WHERE product_id=$1)::text AS "recentlyViewed",
       (SELECT count(*) FROM slug_redirects WHERE entity_type='product' AND entity_id=$1)::text AS "slugRedirects"`,
    [id],
  );
  const row = counts.rows[0]!;
  const blockers = {
    cartItems: Number(row.cartItems),
    orderItems: Number(row.orderItems),
    inventoryReservations: Number(row.inventoryReservations),
    inventoryMovements: Number(row.inventoryMovements),
    promotionUsages: Number(row.promotionUsages),
  };
  return {
    eligible: product.rows[0].status === "archived" && Object.values(blockers).every((count) => count === 0),
    product: product.rows[0],
    blockers,
    removable: {
      variants: Number(row.variants),
      media: Number(row.media),
      priceTiers: Number(row.priceTiers),
      inventoryRecords: Number(row.inventoryRecords),
      promotionLinks: Number(row.promotionLinks),
      wishlistItems: Number(row.wishlistItems),
      recentlyViewed: Number(row.recentlyViewed),
      slugRedirects: Number(row.slugRedirects),
    },
  };
}

export async function getProductDeletionEligibility(id: string): Promise<ProductDeletionEligibility> {
  return productDeletionEligibility(getDatabasePool(), id);
}

export async function permanentlyDeleteProduct(id: string, confirmationName: string): Promise<ProductDeletionEligibility> {
  const client = await getDatabasePool().connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`catalog-product-delete:${id}`]);
    const eligibility = await productDeletionEligibility(client, id, true);
    if (confirmationName !== eligibility.product.name) {
      throw new AppError(400, "PRODUCT_DELETE_CONFIRMATION_MISMATCH", "Enter the exact product name to confirm permanent deletion.");
    }
    if (eligibility.product.status !== "archived") {
      throw new AppError(409, "PRODUCT_DELETE_REQUIRES_ARCHIVE", "Archive this product before deleting it permanently.");
    }
    if (!eligibility.eligible) {
      throw new AppError(
        409,
        "PRODUCT_DELETE_BLOCKED",
        "This product must remain archived to preserve order, accounting, reservation, or inventory history.",
        { blockers: eligibility.blockers },
      );
    }
    const media = await client.query<{ url: string }>("SELECT url FROM product_media WHERE product_id=$1", [id]);
    for (const item of media.rows) await enqueueMediaCleanup(client, item.url, "product_permanent_delete");
    await client.query("DELETE FROM slug_redirects WHERE entity_type='product' AND entity_id=$1", [id]);
    const deleted = await client.query("DELETE FROM products WHERE id=$1", [id]);
    if (deleted.rowCount !== 1) throw new AppError(409, "PRODUCT_DELETE_CONFLICT", "The product changed before it could be deleted.");
    await client.query("COMMIT");
    return eligibility;
  } catch (error) {
    await client.query("ROLLBACK");
    if (typeof error === "object" && error !== null && "code" in error && error.code === "23503") {
      throw new AppError(409, "PRODUCT_DELETE_BLOCKED", "This product must remain archived because another protected record still references it.");
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function bulkUpdateProducts(filters: ProductListFilters, action: string, categoryId?: string, brandId?: string | null): Promise<number> {
  const pool = getDatabasePool();
  const where = productWhere(filters);
  if (!filters.ids?.length) throw new AppError(400, "PRODUCT_IDS_REQUIRED", "Select at least one product.");
  const values = [...where.values];
  if (action === "publish") {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const matches = await client.query<{ id: string }>(
        `SELECT p.id
           FROM products p
           LEFT JOIN brands b ON b.id=p.brand_id
           JOIN categories c ON c.id=p.category_id
          WHERE ${where.clause}
          FOR UPDATE OF p`,
        values,
      );
      for (const match of matches.rows) {
        await client.query("UPDATE products SET status='active',published_at=now(),updated_at=now() WHERE id=$1", [match.id]);
        await assertProductPublicationReady(client, match.id);
      }
      await client.query("COMMIT");
      return matches.rowCount ?? 0;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  let statement: string;
  switch (action) {
    case "publish": statement = `status = 'active', published_at = now()`; break;
    case "unpublish": statement = `status = 'inactive', published_at = NULL`; break;
    case "archive": statement = `status = 'archived', published_at = NULL`; break;
    case "feature": statement = "featured = true"; break;
    case "unfeature": statement = "featured = false"; break;
    case "new_arrival": statement = "new_arrival = true"; break;
    case "not_new_arrival": statement = "new_arrival = false"; break;
    case "assign_category":
      if (!categoryId) throw new AppError(400, "CATEGORY_REQUIRED", "A category is required.");
      values.push(categoryId); statement = `category_id = $${values.length}`; break;
    case "assign_brand":
      values.push(brandId ?? null); statement = `brand_id = $${values.length}`; break;
    default: throw new AppError(400, "INVALID_BULK_ACTION", "That bulk action is not supported.");
  }
  const result = await pool.query(`UPDATE products p SET ${statement}, updated_at = now() WHERE ${where.clause}`, values);
  return result.rowCount ?? 0;
}

export async function listCategories() {
  const result = await getDatabasePool().query(
    `SELECT id, parent_id AS "parentId", name, slug, seo_title AS "seoTitle", seo_description AS "seoDescription", description, image_url AS "imageUrl",
            sort_order AS "sortOrder", active, canonical_key AS "canonicalKey", created_at AS "createdAt", updated_at AS "updatedAt",
            (SELECT count(*)::text FROM products p WHERE p.category_id = categories.id) AS "productCount",
            (SELECT count(*)::text FROM categories child WHERE child.parent_id = categories.id) AS "childCount",
            ((SELECT count(*) FROM promotion_categories pc WHERE pc.category_id = categories.id)
              + (SELECT count(*) FROM slug_redirects sr WHERE sr.entity_type = 'category' AND sr.entity_id = categories.id))::text AS "protectedDependencyCount"
       FROM categories ORDER BY parent_id NULLS FIRST, sort_order, name`,
  );
  return result.rows.map((row) => ({
    ...row,
    imageUrl: resolveCategoryImageUrl(String(row.slug), row.imageUrl),
    productCount: Number(row.productCount),
    childCount: Number(row.childCount),
    protectedDependencyCount: Number(row.protectedDependencyCount),
  }));
}

export async function saveCategory(input: CategoryInput, id?: string): Promise<string> {
  const pool = getDatabasePool();
  const canonicalKey = input.canonicalKey ?? input.slug;
  if (id && input.parentId) {
    const cycle = await pool.query(
      `WITH RECURSIVE descendants AS (
         SELECT id FROM categories WHERE id = $1
         UNION ALL
         SELECT c.id FROM categories c JOIN descendants d ON c.parent_id = d.id
       )
       SELECT 1 FROM descendants WHERE id = $2 LIMIT 1`,
      [id, input.parentId],
    );
    if (cycle.rowCount) throw new AppError(400, "CATEGORY_CYCLE", "A category cannot be assigned beneath itself or one of its descendants.");
  }
  if (input.parentId) {
    const parent = await pool.query<{ parentId: string | null; active: boolean }>(
      `SELECT parent_id AS "parentId", active FROM categories WHERE id = $1`,
      [input.parentId],
    );
    if (!parent.rows[0]) throw new AppError(404, "CATEGORY_PARENT_NOT_FOUND", "The parent category was not found.");
    if (parent.rows[0].parentId) throw new AppError(400, "CATEGORY_DEPTH_EXCEEDED", "Categories may only have a root and one child level.");
    if (!parent.rows[0].active) throw new AppError(409, "CATEGORY_PARENT_INACTIVE", "An active child requires an active parent category.");
  }
  try {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await releaseOwnedRedirectOrReject(client, "category", id, input.slug);
      if (id) {
      const existing = await client.query<{ slug: string; canonicalKey: string | null }>("SELECT slug, canonical_key AS \"canonicalKey\" FROM categories WHERE id = $1 FOR UPDATE", [id]);
      if (!existing.rowCount) throw new AppError(404, "CATEGORY_NOT_FOUND", "The requested category was not found.");
      const mappings = await client.query<{ rootCategoryId: string | null; childCategoryId: string | null }>(
        `SELECT root_category_id AS "rootCategoryId", child_category_id AS "childCategoryId"
           FROM supplier_category_mappings
          WHERE root_category_id=$1 OR child_category_id=$1`,
        [id],
      );
      for (const mapping of mappings.rows) {
        if (!input.active) throw new AppError(409, "CATEGORY_MAPPING_TARGET_INACTIVE", "A category targeted by a supplier mapping cannot be deactivated.");
        if (mapping.rootCategoryId === id && input.parentId) throw new AppError(409, "CATEGORY_MAPPING_ROOT_INVALID", "A mapped root category cannot be moved beneath another category.");
        if (mapping.childCategoryId === id && mapping.rootCategoryId !== input.parentId) throw new AppError(409, "CATEGORY_MAPPING_CHILD_INVALID", "A mapped child category must remain beneath its mapped root.");
      }
      if (input.parentId) {
        const children = await client.query("SELECT 1 FROM categories WHERE parent_id=$1 LIMIT 1", [id]);
        if (children.rows[0]) throw new AppError(400, "CATEGORY_HAS_CHILDREN", "A category with children cannot be moved beneath another category.");
      }
      if (!input.active) {
        const activeChild = await client.query("SELECT 1 FROM categories WHERE parent_id=$1 AND active=true LIMIT 1", [id]);
        if (activeChild.rows[0]) throw new AppError(409, "CATEGORY_HAS_ACTIVE_CHILDREN", "Archive or deactivate child categories before deactivating this parent.");
      }
      const result = await client.query(
        `UPDATE categories SET parent_id = $1, name = $2, slug = $3, canonical_key = $4, description = $5, image_url = $6,
                sort_order = $7, active = $8, seo_title = $9, seo_description = $10, updated_at = now() WHERE id = $11`,
        [input.parentId, input.name, input.slug, input.canonicalKey ?? existing.rows[0]!.canonicalKey, input.description, input.imageUrl, input.sortOrder, input.active, input.seoTitle, input.seoDescription, id],
      );
      if (result.rowCount !== 1) throw new AppError(404, "CATEGORY_NOT_FOUND", "The requested category was not found.");
      if (existing.rows[0]!.slug !== input.slug && input.active) await client.query(
        `INSERT INTO slug_redirects (entity_type, entity_id, old_slug) VALUES ('category', $1, $2)`, [id, existing.rows[0]!.slug],
      );
      await client.query("COMMIT");
      return id;
      }
      const result = await client.query<{ id: string }>(
      `INSERT INTO categories (parent_id, name, slug, canonical_key, description, image_url, sort_order, active, seo_title, seo_description)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
      [input.parentId, input.name, input.slug, canonicalKey, input.description, input.imageUrl, input.sortOrder, input.active, input.seoTitle, input.seoDescription],
    );
      await client.query("COMMIT");
    return result.rows[0]!.id;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  } catch (error) {
    catalogConflict(error);
  }
}

export async function archiveCategory(id: string, active: boolean): Promise<void> {
  if (!active) {
    const child = await getDatabasePool().query<{ id: string }>(
      "SELECT id FROM categories WHERE parent_id = $1 AND active = true LIMIT 1",
      [id],
    );
    if (child.rows[0]) throw new AppError(409, "CATEGORY_HAS_ACTIVE_CHILDREN", "Archive or deactivate child categories before deactivating this parent.");
  }
  const result = await getDatabasePool().query("UPDATE categories SET active = $1, updated_at = now() WHERE id = $2", [active, id]);
  if (result.rowCount !== 1) throw new AppError(404, "CATEGORY_NOT_FOUND", "The requested category was not found.");
}

export async function deleteCategory(id: string, reassignToCategoryId?: string): Promise<{
  name: string;
  productCount: number;
  reassignedToCategoryId: string | null;
}> {
  const client = await getDatabasePool().connect();
  try {
    await client.query("BEGIN");
    const category = await client.query<{ name: string }>("SELECT name FROM categories WHERE id = $1 FOR UPDATE", [id]);
    if (!category.rows[0]) throw new AppError(404, "CATEGORY_NOT_FOUND", "The requested category was not found.");
    const dependencies = await client.query<{ productCount: string; childCount: string; protectedDependencyCount: string }>(
      `SELECT
         (SELECT count(*)::text FROM products WHERE category_id = $1) AS "productCount",
         (SELECT count(*)::text FROM categories WHERE parent_id = $1) AS "childCount",
         ((SELECT count(*) FROM promotion_categories WHERE category_id = $1)
           + (SELECT count(*) FROM slug_redirects WHERE entity_type = 'category' AND entity_id = $1))::text AS "protectedDependencyCount"`,
      [id],
    );
    const productCount = Number(dependencies.rows[0]?.productCount ?? 0);
    const childCount = Number(dependencies.rows[0]?.childCount ?? 0);
    const protectedDependencyCount = Number(dependencies.rows[0]?.protectedDependencyCount ?? 0);
    if (childCount > 0) throw new AppError(409, "CATEGORY_HAS_CHILDREN", "Move or remove this category's child categories before deleting it.", { childCount });
    if (protectedDependencyCount > 0) throw new AppError(409, "CATEGORY_HAS_PROTECTED_DEPENDENCIES", "This category has promotion or SEO history and can only be archived.", { protectedDependencyCount });
    if (productCount > 0 && !reassignToCategoryId) {
      throw new AppError(409, "CATEGORY_HAS_PRODUCTS", `This category contains ${productCount} product${productCount === 1 ? "" : "s"}. Reassign them or archive the category.`, { productCount });
    }
    if (reassignToCategoryId) {
      if (reassignToCategoryId === id) throw new AppError(400, "CATEGORY_REASSIGN_SELF", "Choose a different destination category.");
      const destination = await client.query<{ active: boolean }>("SELECT active FROM categories WHERE id = $1 FOR UPDATE", [reassignToCategoryId]);
      if (!destination.rows[0]) throw new AppError(404, "CATEGORY_DESTINATION_NOT_FOUND", "The destination category was not found.");
      if (!destination.rows[0].active) throw new AppError(409, "CATEGORY_DESTINATION_INACTIVE", "Choose an active destination category.");
      await client.query("UPDATE products SET category_id = $1, updated_at = now() WHERE category_id = $2", [reassignToCategoryId, id]);
    }
    const removed = await client.query("DELETE FROM categories WHERE id = $1", [id]);
    if (removed.rowCount !== 1) throw new AppError(404, "CATEGORY_NOT_FOUND", "The requested category was not found.");
    await client.query("COMMIT");
    return { name: category.rows[0].name, productCount, reassignedToCategoryId: reassignToCategoryId ?? null };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function listBrands(page = 1, pageSize = 25, search = "") {
  const safePage = Math.max(1, Math.floor(page));
  const safeSize = Math.min(100, Math.max(1, Math.floor(pageSize)));
  const values: unknown[] = [];
  const where = search.trim() ? (() => { values.push(`%${search.trim()}%`); return "WHERE name ILIKE $1 OR slug ILIKE $1"; })() : "";
  const count = await getDatabasePool().query<{ count: string }>(`SELECT count(*)::text AS count FROM brands ${where}`, values);
  values.push(safeSize, (safePage - 1) * safeSize);
  const rows = await getDatabasePool().query(
    `SELECT id, name, slug, seo_title AS "seoTitle", seo_description AS "seoDescription", logo_url AS "logoUrl", description, active, created_at AS "createdAt", updated_at AS "updatedAt"
       FROM brands ${where} ORDER BY name LIMIT $${values.length - 1} OFFSET $${values.length}`,
    values,
  );
  const total = Number(count.rows[0]?.count ?? 0);
  return { items: rows.rows, meta: { page: safePage, pageSize: safeSize, total, hasNext: safePage * safeSize < total } };
}

export async function saveBrand(input: BrandInput, id?: string): Promise<string> {
  const pool = getDatabasePool();
  try {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await releaseOwnedRedirectOrReject(client, "brand", id, input.slug);
    if (id) {
      const existing = await client.query<{ slug: string }>("SELECT slug FROM brands WHERE id = $1 FOR UPDATE", [id]);
      if (!existing.rowCount) throw new AppError(404, "BRAND_NOT_FOUND", "The requested brand was not found.");
      const result = await client.query(
        `UPDATE brands SET name = $1, slug = $2, logo_url = $3, description = $4, active = $5, seo_title = $6, seo_description = $7, updated_at = now() WHERE id = $8`,
        [input.name, input.slug, input.logoUrl, input.description, input.active, input.seoTitle, input.seoDescription, id],
      );
      if (result.rowCount !== 1) throw new AppError(404, "BRAND_NOT_FOUND", "The requested brand was not found.");
      if (existing.rows[0]!.slug !== input.slug && input.active) await client.query(
        `INSERT INTO slug_redirects (entity_type, entity_id, old_slug) VALUES ('brand', $1, $2)`, [id, existing.rows[0]!.slug],
      );
      await client.query("COMMIT");
      return id;
    }
    const result = await client.query<{ id: string }>(
      `INSERT INTO brands (name, slug, logo_url, description, active, seo_title, seo_description) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [input.name, input.slug, input.logoUrl, input.description, input.active, input.seoTitle, input.seoDescription],
    );
    await client.query("COMMIT");
    return result.rows[0]!.id;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  } catch (error) {
    catalogConflict(error);
  }
}

export async function archiveBrand(id: string, active: boolean): Promise<void> {
  const result = await getDatabasePool().query("UPDATE brands SET active = $1, updated_at = now() WHERE id = $2", [active, id]);
  if (result.rowCount !== 1) throw new AppError(404, "BRAND_NOT_FOUND", "The requested brand was not found.");
}

export async function createMedia(input: { productId: string; variantId: string | null; type: "image" | "video"; url: string; altText: string | null; isPrimary: boolean; sortOrder: number }) {
  const pool = getDatabasePool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const product = await client.query("SELECT 1 FROM products WHERE id = $1 FOR UPDATE", [input.productId]);
    if (!product.rowCount) throw new AppError(404, "PRODUCT_NOT_FOUND", "The requested product was not found.");
    if (input.variantId) {
      const variant = await client.query("SELECT 1 FROM product_variants WHERE id = $1 AND product_id = $2", [input.variantId, input.productId]);
      if (!variant.rowCount) throw new AppError(400, "VARIANT_PRODUCT_MISMATCH", "The media variant must belong to the selected product.");
    }
    if (input.isPrimary && input.type === "image") {
      await client.query("UPDATE product_media SET is_primary=false WHERE product_id=$1 AND variant_id IS NOT DISTINCT FROM $2 AND type='image'", [input.productId, input.variantId]);
    }
    const result = await client.query(
      `INSERT INTO product_media (product_id, variant_id, type, url, alt_text, is_primary, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, variant_id AS "variantId", type, url, alt_text AS "altText", is_primary AS "isPrimary", sort_order AS "sortOrder", created_at AS "createdAt"`,
      [input.productId, input.variantId, input.type, input.url, input.altText, input.isPrimary, input.sortOrder],
    );
    if (input.type === "image" && input.variantId === null) {
      await client.query(
        `UPDATE product_media SET is_primary=true
          WHERE id=(SELECT id FROM product_media WHERE product_id=$1 AND variant_id IS NULL AND type='image' ORDER BY is_primary DESC,sort_order,created_at,id LIMIT 1)
            AND NOT EXISTS(SELECT 1 FROM product_media WHERE product_id=$1 AND variant_id IS NULL AND type='image' AND is_primary=true)`,
        [input.productId],
      );
    }
    const finalRow = await client.query(
      `SELECT id,variant_id AS "variantId",type,url,alt_text AS "altText",is_primary AS "isPrimary",
              sort_order AS "sortOrder",created_at AS "createdAt"
         FROM product_media WHERE id=$1`,
      [result.rows[0]!.id],
    );
    await client.query("COMMIT");
    return finalRow.rows[0];
  } catch (error) {
    await client.query("ROLLBACK");
    catalogConflict(error);
  } finally {
    client.release();
  }
}

export async function updateMedia(id: string, input: { variantId?: string | null; altText?: string | null; isPrimary?: boolean; sortOrder?: number }) {
  const pool = getDatabasePool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const current = await client.query<{ productId: string; variantId: string | null; type: "image" | "video"; isPrimary: boolean }>(
      "SELECT product_id AS \"productId\",variant_id AS \"variantId\",type,is_primary AS \"isPrimary\" FROM product_media WHERE id=$1 FOR UPDATE", [id],
    );
    const row = current.rows[0];
    if (!row) throw new AppError(404, "MEDIA_NOT_FOUND", "The requested media was not found.");
    await client.query("SELECT 1 FROM products WHERE id=$1 FOR UPDATE", [row.productId]);
    const targetVariantId = input.variantId === undefined ? row.variantId : input.variantId;
    if (targetVariantId) {
      const variant = await client.query("SELECT 1 FROM product_variants WHERE id=$1 AND product_id=$2", [targetVariantId, row.productId]);
      if (!variant.rowCount) throw new AppError(400, "VARIANT_PRODUCT_MISMATCH", "The media variant must belong to the selected product.");
    }
    const effectivePrimary = input.isPrimary ?? row.isPrimary;
    if (effectivePrimary && row.type === "image") {
      await client.query("UPDATE product_media SET is_primary=false WHERE product_id=$1 AND variant_id IS NOT DISTINCT FROM $2 AND type='image' AND id<>$3", [row.productId, targetVariantId, id]);
    }
    await client.query(
      `UPDATE product_media SET variant_id=$1,alt_text=CASE WHEN $2::boolean THEN $3 ELSE alt_text END,
              is_primary=COALESCE($4,is_primary),sort_order=COALESCE($5,sort_order) WHERE id=$6`,
      [targetVariantId, input.altText !== undefined, input.altText ?? null, input.isPrimary, input.sortOrder, id],
    );
    if (row.variantId === null || targetVariantId === null) {
      await client.query(
        `UPDATE product_media SET is_primary=true
          WHERE id=(SELECT id FROM product_media WHERE product_id=$1 AND variant_id IS NULL AND type='image' ORDER BY sort_order,created_at,id LIMIT 1)
            AND NOT EXISTS(SELECT 1 FROM product_media WHERE product_id=$1 AND variant_id IS NULL AND type='image' AND is_primary=true)`,
        [row.productId],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    catalogConflict(error);
  } finally {
    client.release();
  }
}

export async function deleteMedia(id: string): Promise<string> {
  const client = await getDatabasePool().connect();
  try {
    await client.query("BEGIN");
    const current = await client.query<{ productId: string; variantId: string | null; type: "image" | "video"; url: string }>(
      `SELECT product_id AS "productId",variant_id AS "variantId",type,url FROM product_media WHERE id=$1 FOR UPDATE`,
      [id],
    );
    const row = current.rows[0];
    const url = row?.url;
    if (!url) throw new AppError(404, "MEDIA_NOT_FOUND", "The requested media was not found.");
    await client.query("SELECT 1 FROM products WHERE id=$1 FOR UPDATE", [row.productId]);
    await client.query("DELETE FROM product_media WHERE id=$1", [id]);
    if (row.type === "image" && row.variantId === null) {
      await client.query(
        `UPDATE product_media SET is_primary=true
          WHERE id=(SELECT id FROM product_media WHERE product_id=$1 AND variant_id IS NULL AND type='image' ORDER BY sort_order,created_at,id LIMIT 1)
            AND NOT EXISTS(SELECT 1 FROM product_media WHERE product_id=$1 AND variant_id IS NULL AND type='image' AND is_primary=true)`,
        [row.productId],
      );
    }
    await enqueueMediaCleanup(client, url, "catalog_media_deleted");
    await client.query("COMMIT");
    return url;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}