import { Router, type RequestHandler } from "express";
import multer from "multer";
import { z } from "zod";
import { canUser, auditSecurityEvent } from "../auth/service.js";
import { getDatabasePool } from "../db/client.js";
import { requireAdmin, requireCsrf, requirePermission } from "../middleware/auth.js";
import { AppError } from "../middleware/error-handler.js";
import { resolveCategoryImageUrl } from "../catalog/category-media.js";
import {
  archiveBrand,
  archiveCategory,
  archiveProduct,
  bulkUpdateProducts,
  createMedia,
  deleteCategory,
  getProductDeletionEligibility,
  deleteMedia,
  getProduct,
  homepageProducts,
  listBrands,
  listCategories,
  listProducts,
  permanentlyDeleteProduct,
  saveBrand,
  saveCategory,
  saveProduct,
  setProductOperationalStatus,
  updateMedia,
} from "../catalog/service.js";
import {
  getHomepageWholesaleOffer,
  getTiers,
  getPricing,
} from "../pricing/service.js";
import {
  brandInputSchema,
  bulkActionSchema,
  categoryInputSchema,
  mediaInputSchema,
  productInputSchema,
  supplierCategoryMappingBulkSchema,
  supplierCategoryMappingUpdateSchema,
} from "../catalog/validation.js";
import { wishlistMembership } from "../wishlist/service.js";
import { evaluatePromotions } from "../promotions/service.js";
import { assertMinimumOrderQuantity, getMinimumOrderQuantity } from "../catalog/moq.js";
import {
  bulkUpdateSupplierCategoryMappings,
  listSupplierCategoryMappings,
  listSupplierMappingCategoryOptions,
  updateSupplierCategoryMapping,
} from "../catalog/supplier-mapping.js";

function publicAvailability(available: number): "in_stock" | "low_stock" | "out_of_stock" {
  if (available <= 0) return "out_of_stock";
  if (available <= 5) return "low_stock";
  return "in_stock";
}

async function publicStock(productId: string, variantId?: string | null): Promise<number> {
  const result = await getDatabasePool().query<{ available: string }>(
    `SELECT COALESCE(sum(quantity_on_hand - quantity_reserved), 0)::text AS available
       FROM inventory i
       LEFT JOIN product_variants pv ON pv.id = i.variant_id
       WHERE i.active=true AND ${variantId ? "i.variant_id = $1" : "(i.product_id = $1 OR pv.product_id = $1)"}`,
    [variantId ?? productId],
  );
  return Math.max(0, Number(result.rows[0]?.available ?? 0));
}

async function publicProduct(productId: string) {
  const product = await getProduct(productId, false, true);
  if (product.status !== "active" || !product.published) throw new AppError(404, "PRODUCT_NOT_FOUND", "The requested product was not found.");
  const productTiers = (await getTiers(product.id, null)).filter((tier) => tier.active);
  const variants = await Promise.all(product.variants.filter((variant) => variant.active).map(async (variant) => {
    const pricing = await getPricing(product.id, variant.id, 1);
    const promotion = await evaluatePromotions([{ key: variant.id, productId: product.id, categoryId: product.category.id, brandId: product.brand?.id, quantity: 1, lineTotal: pricing.totalPrice }]);
    const promotionDiscount = promotion.lines[variant.id]?.discount ?? 0;
    const tiers = (await getTiers(null, variant.id)).filter((tier) => tier.active);
    const available = await publicStock(product.id, variant.id);
    return {
      id: variant.id,
      sku: variant.sku,
      title: variant.title,
      basePrice: variant.basePrice,
      weight: variant.weight,
      minimumOrderQuantity: variant.minimumOrderQuantity,
      optionValues: variant.optionValues,
      price: pricing.unitPrice,
      promotionalPrice: promotionDiscount > 0 ? Number((pricing.unitPrice - promotionDiscount).toFixed(2)) : null,
      promotion: promotionDiscount > 0 ? { name: promotion.lines[variant.id]?.promotionName, discount: promotionDiscount } : null,
      tiers,
      available,
      availability: publicAvailability(available),
      media: product.media.filter((item) => item.variantId === variant.id),
    };
  }));
  const pricing = await getPricing(product.id, null, 1);
  const promotion = await evaluatePromotions([{ key: product.id, productId: product.id, categoryId: product.category.id, brandId: product.brand?.id, quantity: 1, lineTotal: pricing.totalPrice }]);
  const promotionDiscount = promotion.lines[product.id]?.discount ?? 0;
  const available = await publicStock(product.id);
  return {
    id: product.id,
    name: product.name,
    slug: product.slug,
    seoTitle: product.seoTitle,
    seoDescription: product.seoDescription,
    parentSku: product.parentSku,
    brand: product.brand,
    category: product.category,
    shortDescription: product.shortDescription,
    description: product.description,
    basePrice: product.basePrice,
    weight: product.weight,
    displayWeightKg: product.displayWeightKg,
    minimumOrderQuantity: product.minimumOrderQuantity,
    vatRate: product.vatRate,
    taxMode: product.taxMode,
    featured: product.featured,
    newArrival: product.newArrival,
    homepageWholesale: product.homepageWholesale,
    thumbnailUrl: product.thumbnailUrl,
    media: product.media,
    options: product.options,
    tiers: productTiers,
    price: pricing.unitPrice,
    promotionalPrice: promotionDiscount > 0 ? Number((pricing.unitPrice - promotionDiscount).toFixed(2)) : null,
    promotion: promotionDiscount > 0 ? { name: promotion.lines[product.id]?.promotionName, discount: promotionDiscount } : null,
    nextTier: pricing.nextTier,
    available,
    availability: publicAvailability(available),
    variants,
  };
}

const publicProductQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(48).default(12),
  search: z.string().trim().max(120).optional(),
  categoryId: z.string().uuid().optional(),
  brandId: z.string().uuid().optional(),
  minPrice: z.coerce.number().min(0).optional(),
  maxPrice: z.coerce.number().min(0).optional(),
  availability: z.enum(["in_stock", "low_stock", "out_of_stock"]).optional(),
  featured: z.coerce.boolean().optional(),
  newArrival: z.coerce.boolean().optional(),
  homepageWholesale: z.enum(["true", "false"]).transform((value) => value === "true").optional(),
  deals: z.coerce.boolean().optional(),
  sort: z.enum(["updated", "created", "name", "price"]).default("updated"),
  direction: z.enum(["asc", "desc"]).default("desc"),
});

import {
  getPreview,
  parseCatalogFile,
  previewSummary,
  removePreview,
  storePreview,
  toProductInput,
  type ImportableProduct,
} from "../catalog/import.js";
import { catalogUploadLimits, getAcceptedMediaType, isAcceptedMediaPayload, removeCatalogUpload, storeCatalogUpload } from "../catalog/storage.js";
import { scheduleMediaCleanup } from "../catalog/media-cleanup.js";

const uuid = z.string().uuid();

const mediaUpload = multer({
  storage: multer.memoryStorage(),
  limits: catalogUploadLimits,
  fileFilter: (_request, file, callback) => {
    callback(null, Boolean(getAcceptedMediaType(file.mimetype)));
  },
});
const importUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
  fileFilter: (_request, file, callback) => {
    const accepted = new Set([
      "text/csv",
      "application/csv",
      "application/vnd.ms-excel",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/octet-stream",
    ]);
    callback(null, accepted.has(file.mimetype) || /\.(csv|xlsx)$/i.test(file.originalname));
  },
});

const importCommitSchema = z.object({
  previewId: z.string().uuid(),
  resolution: z.object({
    brands: z.record(z.string(), z.string().uuid()).default({}),
    categories: z.record(z.string(), z.string().uuid()).default({}),
  }).default({ brands: {}, categories: {} }),
});

const categoryDeleteSchema = z.object({
  reassignToCategoryId: z.string().uuid().optional(),
});

const permanentProductDeleteSchema = z.object({
  confirmationName: z.string().min(1).max(250),
});

function middleware(permission: string): RequestHandler[] {
  return [requireAdmin, requirePermission(permission)];
}

function mutationMiddleware(permission: string): RequestHandler[] {
  return [requireCsrf, requireAdmin, requirePermission(permission)];
}

function idParam(request: Parameters<RequestHandler>[0], name = "id"): string {
  const value = request.params[name];
  if (!value || Array.isArray(value)) throw new AppError(400, "INVALID_ID", "A valid catalog identifier is required.");
  return value;
}

function bodyFrom<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) throw new AppError(400, "VALIDATION_ERROR", "The request could not be validated.", result.error.flatten());
  return result.data;
}

function queryString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function queryBoolean(value: unknown): boolean | undefined {
  if (value === undefined) return undefined;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new AppError(400, "INVALID_FILTER", "Boolean filters must be true or false.");
}

function productFilters(request: Parameters<RequestHandler>[0]) {
  const query = request.query;
  const statusQuery = queryString(query.status);
  const filters = {
    page: queryString(query.page) ? Number(query.page) : undefined,
    pageSize: queryString(query.pageSize) ? Number(query.pageSize) : undefined,
    search: queryString(query.search),
    status: statusQuery === "all" ? undefined : statusQuery === undefined ? "active" : statusQuery,
    // Admin catalog defaults to operationally active products; `all` is an
    // explicit opt-out rather than conflating it with a missing filter.
    categoryId: queryString(query.categoryId),
    brandId: queryString(query.brandId),
    featured: queryBoolean(query.featured),
    newArrival: queryBoolean(query.newArrival),
    homepageWholesale: queryBoolean(query.homepageWholesale),
    published: queryBoolean(query.published),
    hasVariants: queryBoolean(query.hasVariants),
    sort: queryString(query.sort),
    direction: queryString(query.direction) === "asc" ? "asc" as const : "desc" as const,
  };
  if (filters.page !== undefined && (!Number.isInteger(filters.page) || filters.page < 1)) throw new AppError(400, "INVALID_PAGINATION", "Page must be a positive integer.");
  return filters;
}

function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll("\"", "\"\"")}"` : text;
}

async function audit(
  request: Parameters<RequestHandler>[0],
  action: string,
  entityType: string,
  entityId?: string,
  oldValues?: Record<string, unknown>,
  newValues?: Record<string, unknown>,
): Promise<void> {
  if (request.auth) await auditSecurityEvent({ actorUserId: request.auth.userId, action, entityType, entityId, oldValues, newValues, request });
}

export const catalogRouter = Router();

function mappingFilters(request: Parameters<RequestHandler>[0]) {
  const value = (key: string) => queryString(request.query[key]);
  const page = value("page") ? Number(value("page")) : undefined;
  const pageSize = value("pageSize") ? Number(value("pageSize")) : undefined;
  if (page !== undefined && (!Number.isInteger(page) || page < 1)) throw new AppError(400, "INVALID_PAGINATION", "Page must be a positive integer.");
  if (pageSize !== undefined && (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100)) throw new AppError(400, "INVALID_PAGINATION", "Page size must be between 1 and 100.");
  const status = value("status");
  if (status && !["mapped", "unmapped", "ignored", "needs_review"].includes(status)) throw new AppError(400, "INVALID_MAPPING_STATUS", "The mapping status is invalid.");
  return { page, pageSize, supplierId: value("supplierId"), status, search: value("search") };
}

for (const prefix of ["/admin/catalog/supplier-category-mappings", "/admin/supplier-category-mappings"]) {
  catalogRouter.get(prefix, ...middleware("supplier_category_mappings.view"), async (request, response) => {
    response.json({ data: await listSupplierCategoryMappings(mappingFilters(request)) });
  });
  catalogRouter.get(`${prefix}/categories`, ...middleware("supplier_category_mappings.view"), async (_request, response) => {
    response.json({ data: await listSupplierMappingCategoryOptions() });
  });
  catalogRouter.patch(`${prefix}/:id`, ...mutationMiddleware("supplier_category_mappings.manage"), async (request, response) => {
    const id = idParam(request);
    const item = await updateSupplierCategoryMapping(id, bodyFrom(supplierCategoryMappingUpdateSchema, request.body), request.auth!.userId);
    await audit(request, "catalog.supplier_category_mapping_updated", "supplier_category_mapping", id, undefined, item);
    response.json({ data: item });
  });
  catalogRouter.post(`${prefix}/bulk`, ...mutationMiddleware("supplier_category_mappings.manage"), async (request, response) => {
    const result = await bulkUpdateSupplierCategoryMappings(bodyFrom(supplierCategoryMappingBulkSchema, request.body), request.auth!.userId);
    await audit(request, "catalog.supplier_category_mappings_bulk_updated", "supplier_category_mapping", undefined, undefined, result);
    response.json({ data: result });
  });
}

catalogRouter.get("/storefront/homepage-products", async (request, response) => {
  const rails = await homepageProducts();
  const unique = [...new Map(
    [...rails.bestSellers, ...rails.liveWholesalePricing].map((item) => [item.id, item]),
  ).values()];
  // Homepage promotions are intentionally evaluated as one bounded cart-like
  // batch rather than once for every card.
  const promotionLines = unique.length
    ? await evaluatePromotions(unique.map((item) => ({
      key: item.id,
      productId: item.id,
      categoryId: item.category.id,
      brandId: item.brand?.id,
      quantity: 1,
      lineTotal: item.price,
    })), null, { userId: request.auth?.userId })
    : null;
  const savedIds = request.auth
    ? await wishlistMembership(request.auth.userId, unique.map((item) => item.id))
    : new Set<string>();
  const present = (item: typeof unique[number]) => {
    const discount = promotionLines?.lines[item.id]?.discount ?? 0;
    const { bestSeller: _bestSeller, liveWholesale: _liveWholesale, ...card } = item;
    return {
      ...card,
      promotionalPrice: discount > 0 ? Number((item.price - discount).toFixed(2)) : null,
      promotion: discount > 0 ? { name: promotionLines?.lines[item.id]?.promotionName, discount } : null,
      wishlisted: savedIds.has(item.id),
    };
  };
  response.json({
    data: {
      bestSellers: rails.bestSellers.map(present),
      liveWholesalePricing: rails.liveWholesalePricing.map(present),
    },
  });
});

catalogRouter.get("/catalog/products", async (request, response) => {
  const query = publicProductQuery.safeParse(request.query);
  if (!query.success) throw new AppError(400, "INVALID_CATALOG_QUERY", "The catalog filters could not be validated.", query.error.flatten());
  if (query.data.minPrice !== undefined && query.data.maxPrice !== undefined && query.data.minPrice > query.data.maxPrice) throw new AppError(400, "INVALID_PRICE_RANGE", "Minimum price cannot exceed maximum price.");
  const publicCategorySafety = "c.active = true AND (c.parent_id IS NULL OR EXISTS (SELECT 1 FROM categories public_parent WHERE public_parent.id = c.parent_id AND public_parent.active = true))";
  let additionalWhere: { clauses: string[]; values: unknown[] } = { clauses: [publicCategorySafety], values: [] };
  if (query.data.minPrice !== undefined || query.data.maxPrice !== undefined || query.data.availability || query.data.deals) {
    const conditions = [...additionalWhere.clauses, "p.status = 'active'", "p.published_at IS NOT NULL"];
    const values: unknown[] = [...additionalWhere.values];
    if (query.data.minPrice !== undefined) { values.push(query.data.minPrice); conditions.push(`p.base_price >= $${values.length}`); }
    if (query.data.maxPrice !== undefined) { values.push(query.data.maxPrice); conditions.push(`p.base_price <= $${values.length}`); }
    if (query.data.availability) {
      const stock = `COALESCE((SELECT sum(i.quantity_on_hand-i.quantity_reserved) FROM inventory i LEFT JOIN product_variants pv ON pv.id=i.variant_id WHERE i.active=true AND (i.product_id=p.id OR pv.product_id=p.id)),0)`;
      conditions.push(query.data.availability === "out_of_stock" ? `${stock} <= 0` : query.data.availability === "low_stock" ? `${stock} BETWEEN 1 AND 5` : `${stock} > 5`);
    }
    if (query.data.deals) conditions.push(`EXISTS (
      SELECT 1 FROM promotion_campaigns pc
      WHERE pc.active=true AND pc.automatic=true AND pc.archived_at IS NULL AND pc.start_at<=now() AND (pc.end_at IS NULL OR pc.end_at>=now())
        AND (pc.discount_value>0 OR pc.free_shipping=true)
        AND (pc.promotion_type='order'
          OR (pc.promotion_type='product' AND EXISTS (SELECT 1 FROM promotion_products pp WHERE pp.campaign_id=pc.id AND pp.product_id=p.id))
          OR (pc.promotion_type='category' AND EXISTS (SELECT 1 FROM promotion_categories pcat WHERE pcat.campaign_id=pc.id AND pcat.category_id=p.category_id))
          OR (pc.promotion_type='brand' AND EXISTS (SELECT 1 FROM promotion_brands pb WHERE pb.campaign_id=pc.id AND pb.brand_id=p.brand_id))))`);
    additionalWhere = { clauses: conditions, values };
  }
  const result = await listProducts({
    ...query.data,
    additionalWhere,
    includeCategoryDescendants: true,
    published: true,
    status: "active",
  }, false);
  const publicItems = await Promise.all(result.items.map(async (item) => {
    const [pricing, available, homepageWholesaleOffer] = await Promise.all([
      getPricing(item.id, null, 1),
      publicStock(item.id),
      item.homepageWholesale ? getHomepageWholesaleOffer(item.id) : Promise.resolve(null),
    ]);
    const promotion = await evaluatePromotions([{ key: item.id, productId: item.id, categoryId: item.category.id, brandId: item.brand?.id, quantity: 1, lineTotal: pricing.totalPrice }], null, { userId: request.auth?.userId });
    const promotionDiscount = promotion.lines[item.id]?.discount ?? 0;
    return {
      id: item.id,
      name: item.name,
      slug: item.slug,
      parentSku: item.parentSku,
      brand: item.brand,
      category: item.category,
      shortDescription: item.shortDescription,
      price: pricing.unitPrice,
      promotionalPrice: promotionDiscount > 0 ? Number((pricing.unitPrice - promotionDiscount).toFixed(2)) : null,
      promotion: promotionDiscount > 0 ? { name: promotion.lines[item.id]?.promotionName, discount: promotionDiscount } : null,
      nextTier: pricing.nextTier,
      available,
      availability: publicAvailability(available),
      featured: item.featured,
      newArrival: item.newArrival,
       homepageWholesale: item.homepageWholesale,
       minimumOrderQuantity: item.minimumOrderQuantity,
       homepageWholesaleOffer,
      thumbnailUrl: item.thumbnailUrl,
      variantCount: item.variantCount,
    };
  }));
  const savedIds = request.auth ? await wishlistMembership(request.auth.userId, publicItems.map((item) => item.id)) : new Set<string>();
  const items = publicItems.map((item) => ({ ...item, wishlisted: savedIds.has(item.id) }));
  response.json({ data: { items, meta: result.meta } });
});

catalogRouter.get("/catalog/products/:slug", async (request, response) => {
  const result = await getDatabasePool().query<{ id: string }>(
    `SELECT p.id FROM products p JOIN categories c ON c.id=p.category_id
      WHERE p.slug = $1 AND p.status = 'active' AND p.published_at IS NOT NULL
        AND c.active=true AND (c.parent_id IS NULL OR EXISTS (SELECT 1 FROM categories parent WHERE parent.id=c.parent_id AND parent.active=true))`,
    [request.params.slug],
  );
  const productId = result.rows[0]?.id;
  if (!productId) throw new AppError(404, "PRODUCT_NOT_FOUND", "The requested product was not found.");
  const product = await publicProduct(productId);
  const savedIds = request.auth ? await wishlistMembership(request.auth.userId, [productId]) : new Set<string>();
  response.json({ data: { ...product, wishlisted: savedIds.has(productId) } });
});

catalogRouter.get("/catalog/products/:slug/quote", async (request, response) => {
  const query = z.object({ variantId: z.string().uuid().optional(), quantity: z.coerce.number().int().min(1).max(100000) }).safeParse(request.query);
  if (!query.success) throw new AppError(400, "INVALID_QUOTE_QUERY", "The quote request could not be validated.", query.error.flatten());
  const product = await getDatabasePool().query<{ id: string }>(
    `SELECT p.id FROM products p JOIN categories c ON c.id=p.category_id
      WHERE p.slug=$1 AND p.status='active' AND p.published_at IS NOT NULL
        AND c.active=true AND (c.parent_id IS NULL OR EXISTS (SELECT 1 FROM categories parent WHERE parent.id=c.parent_id AND parent.active=true))`,
    [request.params.slug],
  );
  if (!product.rows[0]) throw new AppError(404, "PRODUCT_NOT_FOUND", "The requested product was not found.");
   const minimum = await getMinimumOrderQuantity(getDatabasePool(), product.rows[0].id, query.data.variantId ?? null);
   assertMinimumOrderQuantity(query.data.quantity, minimum);
   const pricing = await getPricing(product.rows[0].id, query.data.variantId ?? null, query.data.quantity);
  const info = await getDatabasePool().query("SELECT category_id AS \"categoryId\",brand_id AS \"brandId\" FROM products WHERE id=$1", [product.rows[0].id]);
  const promotion = await evaluatePromotions([{ key: product.rows[0].id, productId: product.rows[0].id, categoryId: info.rows[0]?.categoryId, brandId: info.rows[0]?.brandId, quantity: query.data.quantity, lineTotal: pricing.totalPrice }], null, { userId: request.auth?.userId });
  const discount = promotion.lines[product.rows[0].id]?.discount ?? 0;
   response.json({ data: { unitPrice: pricing.unitPrice, totalPrice: pricing.totalPrice, source: pricing.source, nextTier: pricing.nextTier ?? null, minimumOrderQuantity: minimum.minimumOrderQuantity, promotionDiscount: discount, promotionName: promotion.lines[product.rows[0].id]?.promotionName ?? null, finalUnitPrice: Number(((pricing.totalPrice - discount) / query.data.quantity).toFixed(2)), finalTotalPrice: Number((pricing.totalPrice - discount).toFixed(2)) } });
});

catalogRouter.get("/catalog/categories", async (_request, response) => {
  const result = await getDatabasePool().query(
    `SELECT id, parent_id AS "parentId", name, slug, canonical_key AS "canonicalKey", seo_title AS "seoTitle", seo_description AS "seoDescription", description, image_url AS "imageUrl"
       FROM categories c WHERE active = true
         AND (c.parent_id IS NULL OR EXISTS (SELECT 1 FROM categories parent WHERE parent.id=c.parent_id AND parent.active=true))
       ORDER BY parent_id NULLS FIRST, sort_order, name`,
  );
  response.json({
    data: result.rows.map((row) => ({
      ...row,
      imageUrl: resolveCategoryImageUrl(String(row.slug), row.imageUrl),
    })),
  });
});

catalogRouter.get("/catalog/categories/:slug", async (request, response) => {
  const pool = getDatabasePool();
  const category = await pool.query<{ id: string; slug: string; parentId: string | null; name: string; active: boolean }>(
    `SELECT c.id, c.slug, c.parent_id AS "parentId", c.name, c.active
       FROM categories c
      WHERE c.slug=$1 AND c.active=true
        AND (c.parent_id IS NULL OR EXISTS (SELECT 1 FROM categories p WHERE p.id=c.parent_id AND p.active=true))`,
    [request.params.slug],
  );
  if (!category.rows[0]) {
    const redirect = await pool.query<{ slug: string }>(
      `SELECT c.slug FROM slug_redirects sr JOIN categories c ON c.id=sr.entity_id
        WHERE sr.entity_type='category' AND sr.old_slug=$1 AND c.active=true`,
      [request.params.slug],
    );
    if (redirect.rows[0]) {
      response.redirect(301, `/api/v1/catalog/categories/${redirect.rows[0].slug}`);
      return;
    }
    throw new AppError(404, "CATEGORY_NOT_FOUND", "The requested category was not found.");
  }
  const result = await listProducts({
    categoryId: category.rows[0].id,
    includeCategoryDescendants: true,
    status: "active",
    published: true,
    publicOnly: true,
    page: 1,
    pageSize: 48,
  }, false);
  response.json({ data: { category: category.rows[0], products: result } });
});

catalogRouter.get("/catalog/brands", async (_request, response) => {
  const result = await getDatabasePool().query(
    `SELECT id, name, slug, seo_title AS "seoTitle", seo_description AS "seoDescription", logo_url AS "logoUrl", description
       FROM brands b WHERE active = true
         AND EXISTS (SELECT 1 FROM products p WHERE p.brand_id=b.id AND p.status='active' AND p.published_at IS NOT NULL)
       ORDER BY name`,
  );
  response.json({ data: result.rows });
});

catalogRouter.get("/admin/catalog/lookups", ...middleware("products.view"), async (_request, response) => {
  const [categories, brands] = await Promise.all([listCategories(), listBrands(1, 100, "")]);
  response.json({ data: { categories, brands: brands.items } });
});

catalogRouter.get("/admin/products", ...middleware("products.view"), async (request, response) => {
  const includeCost = await canUser(request.auth!.userId, "product_cost.view");
  const filters = productFilters(request);
  response.json({ data: await listProducts(filters, includeCost) });
});

catalogRouter.post("/admin/products/:id/lifecycle", ...mutationMiddleware("products.edit"), async (request, response) => {
  const id = idParam(request);
  const status = bodyFrom(z.object({ status: z.enum(["active", "inactive"]) }), request.body).status;
  const current = await getProduct(id, false);
  await setProductOperationalStatus(id, status);
  await audit(request, status === "active" ? "catalog.product_reactivated" : "catalog.product_deactivated", "product", id,
    { name: current.name, sku: current.parentSku, status: current.status },
    { name: current.name, sku: current.parentSku, status });
  response.json({ data: await getProduct(id, await canUser(request.auth!.userId, "product_cost.view")) });
});

catalogRouter.get("/admin/products/export", ...middleware("products.export"), async (request, response) => {
  const filters = productFilters(request);
  const ids = queryString(request.query.ids)?.split(",").filter(Boolean);
  const includeCost = await canUser(request.auth!.userId, "product_cost.view");
  const rows: Array<Record<string, unknown>> = [];
  let page = 1;
  do {
    const result = await listProducts({ ...filters, ids, page, pageSize: 100 }, includeCost);
    rows.push(...result.items as Array<Record<string, unknown>>);
    if (!result.meta.hasNext) break;
    page += 1;
  } while (page <= 100);
  const headers = ["product_name", "slug", "parent_sku", "barcode", ...(includeCost ? ["cost_price"] : []), "base_price", "vat_rate", "weight", "brand", "category", "variant_count", "status", "published", "featured", "new_arrival", "updated_at"];
  const lines = [headers.join(",")];
  for (const product of rows) {
    lines.push([
      product.name, product.slug, product.parentSku, product.barcode,
      ...(includeCost ? [product.costPrice] : []),
      product.basePrice, product.vatRate, product.weight,
      (product.brand as { name?: string } | null)?.name ?? "",
      (product.category as { name?: string } | null)?.name ?? "",
      product.variantCount, product.status, product.published, product.featured, product.newArrival, product.updatedAt,
    ].map(csvCell).join(","));
  }
  response.setHeader("content-type", "text/csv; charset=utf-8");
  response.setHeader("content-disposition", "attachment; filename=\"lizzor-products.csv\"");
  response.send(`${lines.join("\n")}\n`);
});

catalogRouter.get("/admin/products/import/template", ...middleware("products.import"), (_request, response) => {
  const headers = [
    "product_name", "slug", "parent_sku", "barcode", "brand", "category", "short_description", "description",
    "cost_price", "base_price", "vat_rate", "weight", "width", "height", "length", "status", "featured", "new_arrival",
    "variant_sku", "variant_barcode", "variant_title", "variant_cost_price", "variant_base_price", "variant_weight",
    "variant_active", "option_color", "option_size",
  ];
  response.setHeader("content-type", "text/csv; charset=utf-8");
  response.setHeader("content-disposition", "attachment; filename=\"lizzor-product-import-template.csv\"");
  response.send(`${headers.join(",")}\n`);
});

catalogRouter.post("/admin/products/import/preview", ...mutationMiddleware("products.import"), importUpload.single("file"), async (request, response) => {
  if (!request.file) throw new AppError(400, "IMPORT_FILE_REQUIRED", "Choose a CSV or XLSX file to preview.");
  try {
    const parsed = await parseCatalogFile(request.file.buffer, request.file.originalname);
    const [brandRows, categoryRows] = await Promise.all([
      getDatabasePool().query<{ key: string }>("SELECT lower(name) AS key FROM brands"),
      getDatabasePool().query<{ key: string; slug: string; name_count: string }>(
        "SELECT lower(name) AS key, lower(slug) AS slug, count(*) OVER (PARTITION BY lower(name))::text AS name_count FROM categories",
      ),
    ]);
    const brandKeys = new Set(brandRows.rows.map((row) => row.key));
    const categoryKeys = new Set(categoryRows.rows.flatMap((row) => Number(row.name_count) === 1 ? [row.key, row.slug] : [row.slug]));
    const unresolvedBrands = [...new Set(parsed.products.map((product) => product.brandName?.toLowerCase()).filter((name): name is string => Boolean(name && !brandKeys.has(name))))];
    const unresolvedCategories = [...new Set(parsed.products.map((product) => product.categoryName.toLowerCase()).filter((name) => !categoryKeys.has(name)))];
    const previewId = storePreview({ products: parsed.products, errors: parsed.errors, unresolvedBrands, unresolvedCategories });
    response.status(202).json({
      data: {
        previewId,
        products: previewSummary(parsed.products),
        errors: parsed.errors,
        unresolvedBrands,
        unresolvedCategories,
        counts: { rows: parsed.products.reduce((count, product) => count + product.sourceRows.length, 0), products: parsed.products.length, errors: parsed.errors.length },
      },
    });
  } catch (error) {
    throw new AppError(400, "IMPORT_PARSE_ERROR", error instanceof Error ? error.message : "The import file could not be parsed.");
  }
});

catalogRouter.post("/admin/products/import/commit", ...mutationMiddleware("products.import"), async (request, response) => {
  const input = bodyFrom(importCommitSchema, request.body);
  const preview = getPreview(input.previewId);
  if (!preview) throw new AppError(404, "IMPORT_PREVIEW_EXPIRED", "The import preview has expired. Upload the file again.");
  if (preview.errors.length) throw new AppError(400, "IMPORT_HAS_ERRORS", "Fix all preview errors before confirming the import.", { errors: preview.errors });
  const pool = getDatabasePool();
  const categoryRows = await pool.query<{ id: string; key: string; slug: string; name_count: string }>(
    "SELECT id, lower(name) AS key, lower(slug) AS slug, count(*) OVER (PARTITION BY lower(name))::text AS name_count FROM categories",
  );
  const brandRows = await pool.query<{ id: string; key: string }>("SELECT id, lower(name) AS key FROM brands");
  const categories = new Map(categoryRows.rows.flatMap((row) => Number(row.name_count) === 1 ? [[row.key, row.id], [row.slug, row.id]] : [[row.slug, row.id]]));
  const brands = new Map(brandRows.rows.map((row) => [row.key, row.id]));
  const categoryIds = new Set(categoryRows.rows.map((row) => row.id));
  const brandIds = new Set(brandRows.rows.map((row) => row.id));
  const errors: Array<{ rows: number[]; message: string }> = [];
  const importable: ImportableProduct[] = [];
  for (const product of preview.products) {
    const selectedCategoryId = input.resolution.categories[product.categoryName.toLowerCase()];
    const selectedBrandId = product.brandName ? input.resolution.brands[product.brandName.toLowerCase()] : undefined;
    const categoryId = selectedCategoryId && categoryIds.has(selectedCategoryId) ? selectedCategoryId : categories.get(product.categoryName.toLowerCase());
    const brandId = product.brandName
      ? selectedBrandId && brandIds.has(selectedBrandId) ? selectedBrandId : brands.get(product.brandName.toLowerCase())
      : null;
    if (!categoryId) errors.push({ rows: product.sourceRows, message: `Category "${product.categoryName}" could not be resolved.` });
    if (product.brandName && !brandId) errors.push({ rows: product.sourceRows, message: `Brand "${product.brandName}" could not be resolved.` });
    if (categoryId && (!product.brandName || brandId)) importable.push({ ...product, categoryId, brandId: brandId ?? null });
  }
  if (errors.length) throw new AppError(400, "IMPORT_UNRESOLVED_REFERENCES", "Resolve all brands and categories before confirming the import.", { errors });
  let imported = 0;
  const canViewCost = await canUser(request.auth!.userId, "product_cost.view");
  const failed: Array<{ rows: number[]; message: string }> = [];
  for (let index = 0; index < importable.length; index += 25) {
    const batch = importable.slice(index, index + 25);
    for (const product of batch) {
      try {
        const parsed = bodyFrom(productInputSchema, toProductInput(product));
        const validated = canViewCost ? parsed : { ...parsed, costPrice: 0, variants: parsed.variants.map((variant) => ({ ...variant, costPrice: null })) };
        const productId = await saveProduct(validated);
        await audit(request, "catalog.product_imported", "product", productId);
        imported += 1;
      } catch (error) {
        failed.push({ rows: product.sourceRows, message: error instanceof Error ? error.message : "Product could not be imported." });
      }
    }
  }
  removePreview(input.previewId);
  await audit(request, "catalog.import_completed", "product_import", undefined);
  response.json({ data: { imported, failed, total: importable.length } });
});

catalogRouter.get("/admin/products/:id", ...middleware("products.view"), async (request, response) => {
  const includeCost = await canUser(request.auth!.userId, "product_cost.view");
  response.json({ data: await getProduct(idParam(request), includeCost) });
});

catalogRouter.post("/admin/products", ...mutationMiddleware("products.create"), async (request, response) => {
  const canViewCost = await canUser(request.auth!.userId, "product_cost.view");
  const parsed = bodyFrom(productInputSchema, request.body);
  const input = canViewCost ? parsed : { ...parsed, costPrice: 0, variants: parsed.variants.map((variant) => ({ ...variant, costPrice: null })) };
  const id = await saveProduct(input);
  await audit(request, "catalog.product_created", "product", id);
  response.status(201).json({ data: await getProduct(id, await canUser(request.auth!.userId, "product_cost.view")) });
});

catalogRouter.patch("/admin/products/:id", ...mutationMiddleware("products.edit"), async (request, response) => {
  const id = idParam(request);
  const parsed = bodyFrom(productInputSchema, request.body);
  const current = await getProduct(id, true);
  if ((current.status === "archived") !== (parsed.status === "archived")) {
    throw new AppError(400, "ARCHIVE_ENDPOINT_REQUIRED", "Use the dedicated archive or restore action to change archived status.");
  }
  if ((current.status === "active" && parsed.status === "inactive") || (current.status === "inactive" && parsed.status === "active")) {
    throw new AppError(400, "LIFECYCLE_ENDPOINT_REQUIRED", "Use the dedicated deactivate or reactivate action to change active or inactive status.");
  }
  const canViewCost = await canUser(request.auth!.userId, "product_cost.view");
  let input = parsed;
  if (!canViewCost) {
    const currentVariants = new Map(current.variants.map((variant) => [variant.id, variant]));
    input = {
      ...parsed,
      costPrice: current.costPrice ?? 0,
      variants: parsed.variants.map((variant) => ({
        ...variant,
        costPrice: variant.id ? currentVariants.get(variant.id)?.costPrice ?? null : null,
      })),
    };
  }
  await saveProduct(input, id);
  await audit(request, "catalog.product_updated", "product", id);
  response.json({ data: await getProduct(id, await canUser(request.auth!.userId, "product_cost.view")) });
});

catalogRouter.post("/admin/products/:id/archive", ...mutationMiddleware("products.archive"), async (request, response) => {
  const id = idParam(request);
  const restore = request.body?.restore === true;
  const current = await getProduct(id, false);
  await archiveProduct(id, restore);
  await audit(
    request,
    restore ? "catalog.product_restored" : "catalog.product_archived",
    "product",
    id,
    { name: current.name, sku: current.parentSku, status: current.status },
    { name: current.name, sku: current.parentSku, status: restore ? "active" : "archived" },
  );
  response.json({ data: await getProduct(id, await canUser(request.auth!.userId, "product_cost.view")) });
});

catalogRouter.get("/admin/products/:id/deletion-eligibility", ...middleware("products.delete"), async (request, response) => {
  response.json({ data: await getProductDeletionEligibility(idParam(request)) });
});

catalogRouter.delete("/admin/products/:id", ...mutationMiddleware("products.delete"), async (request, response) => {
  const id = idParam(request);
  const input = bodyFrom(permanentProductDeleteSchema, request.body);
  const deleted = await permanentlyDeleteProduct(id, input.confirmationName);
  await audit(
    request,
    "catalog.product_permanently_deleted",
    "product",
    id,
    { name: deleted.product.name, sku: deleted.product.parentSku, status: deleted.product.status },
    { deleted: true, removed: deleted.removable },
  );
  response.json({ data: { deleted: true, product: deleted.product, removed: deleted.removable } });
});

catalogRouter.post("/admin/products/bulk", requireCsrf, requireAdmin, async (request, response) => {
  const input = bodyFrom(bulkActionSchema, request.body);
  const requiredPermission: Record<string, string> = {
    publish: "products.edit", unpublish: "products.edit", archive: "products.archive",
    assign_category: "products.edit", assign_brand: "products.edit",
    feature: "products.edit", unfeature: "products.edit", new_arrival: "products.edit", not_new_arrival: "products.edit",
  };
  if (!await canUser(request.auth!.userId, requiredPermission[input.action])) throw new AppError(403, "PERMISSION_REQUIRED", "You do not have permission to perform this action.");
  const archivedProducts = input.action === "archive" ? (await listProducts({ ids: input.ids, pageSize: 100 }, false)).items : [];
  const count = await bulkUpdateProducts({ ids: input.ids }, input.action, input.categoryId, input.brandId);
  for (const product of archivedProducts) {
    await audit(
      request,
      "catalog.product_archived",
      "product",
      product.id,
      { name: product.name, sku: product.parentSku, status: product.status },
      { name: product.name, sku: product.parentSku, status: "archived" },
    );
  }
  await audit(request, "catalog.products_bulk_updated", "product");
  response.json({ data: { updated: count } });
});

catalogRouter.post("/admin/products/:id/media", ...mutationMiddleware("products.edit"), mediaUpload.single("file"), async (request, response) => {
  const productId = idParam(request);
  const file = request.file;
  if (!file) throw new AppError(400, "MEDIA_FILE_REQUIRED", "Choose an image or video file.");
  if (!isAcceptedMediaPayload(file)) throw new AppError(400, "MEDIA_CONTENT_INVALID", "The uploaded file content does not match an allowed image or video format.");
  const stored = await storeCatalogUpload(file);
  try {
    const media = await createMedia({
      productId,
      variantId: typeof request.body.variantId === "string" && request.body.variantId ? request.body.variantId : null,
      type: stored.type,
      url: stored.url,
      altText: typeof request.body.altText === "string" ? request.body.altText : null,
      isPrimary: request.body.isPrimary === "true",
      sortOrder: Number(request.body.sortOrder ?? 0),
    });
    await audit(request, "catalog.media_added", "product_media", media.id);
    response.status(201).json({ data: media });
  } catch (error) {
    await removeCatalogUpload(stored.url).catch(async () => scheduleMediaCleanup(stored.url, "catalog_upload_rollback"));
    throw error;
  }
});

catalogRouter.patch("/admin/media/:id", ...mutationMiddleware("products.edit"), async (request, response) => {
  const input = bodyFrom(mediaInputSchema.partial().omit({ productId: true, type: true, url: true }), request.body);
  await updateMedia(idParam(request), input);
  await audit(request, "catalog.media_updated", "product_media", idParam(request));
  response.status(204).end();
});

catalogRouter.delete("/admin/media/:id", ...mutationMiddleware("products.edit"), async (request, response) => {
  const id = idParam(request);
  await deleteMedia(id);
  await audit(request, "catalog.media_removed", "product_media", id);
  response.status(204).end();
});

catalogRouter.get("/admin/categories", ...middleware("categories.view"), async (_request, response) => {
  response.json({ data: await listCategories() });
});

catalogRouter.post("/admin/categories", ...mutationMiddleware("categories.create"), async (request, response) => {
  const id = await saveCategory(bodyFrom(categoryInputSchema, request.body));
  await audit(request, "catalog.category_created", "category", id);
  response.status(201).json({ data: { id } });
});

catalogRouter.patch("/admin/categories/:id", ...mutationMiddleware("categories.edit"), async (request, response) => {
  const id = idParam(request);
  await saveCategory(bodyFrom(categoryInputSchema, request.body), id);
  await audit(request, "catalog.category_updated", "category", id);
  response.json({ data: { id } });
});

catalogRouter.post("/admin/categories/:id/archive", ...mutationMiddleware("categories.edit"), async (request, response) => {
  const id = idParam(request);
  const active = request.body?.active === true;
  const current = await getDatabasePool().query<{ name: string; active: boolean }>("SELECT name, active FROM categories WHERE id=$1", [id]);
  if (!current.rows[0]) throw new AppError(404, "CATEGORY_NOT_FOUND", "The requested category was not found.");
  await archiveCategory(id, active);
  await audit(
    request,
    active ? "catalog.category_restored" : "catalog.category_archived",
    "category",
    id,
    { name: current.rows[0].name, active: current.rows[0].active },
    { name: current.rows[0].name, active },
  );
  response.status(204).end();
});

catalogRouter.delete("/admin/categories/:id", ...mutationMiddleware("categories.edit"), async (request, response) => {
  const id = idParam(request);
  const input = bodyFrom(categoryDeleteSchema, request.body ?? {});
  const result = await deleteCategory(id, input.reassignToCategoryId);
  await audit(
    request,
    result.reassignedToCategoryId ? "catalog.category_reassigned_deleted" : "catalog.category_deleted",
    "category",
    id,
    { name: result.name, productCount: result.productCount },
    result.reassignedToCategoryId ? { reassignedToCategoryId: result.reassignedToCategoryId } : undefined,
  );
  response.json({ data: result });
});

catalogRouter.get("/admin/brands", ...middleware("brands.view"), async (request, response) => {
  response.json({ data: await listBrands(Number(queryString(request.query.page) ?? 1), Number(queryString(request.query.pageSize) ?? 25), queryString(request.query.search) ?? "") });
});

catalogRouter.post("/admin/brands", ...mutationMiddleware("brands.create"), async (request, response) => {
  const id = await saveBrand(bodyFrom(brandInputSchema, request.body));
  await audit(request, "catalog.brand_created", "brand", id);
  response.status(201).json({ data: { id } });
});

catalogRouter.patch("/admin/brands/:id", ...mutationMiddleware("brands.edit"), async (request, response) => {
  const id = idParam(request);
  await saveBrand(bodyFrom(brandInputSchema, request.body), id);
  await audit(request, "catalog.brand_updated", "brand", id);
  response.json({ data: { id } });
});

catalogRouter.post("/admin/brands/:id/archive", ...mutationMiddleware("brands.edit"), async (request, response) => {
  const id = idParam(request);
  await archiveBrand(id, request.body?.active === true);
  await audit(request, request.body?.active === true ? "catalog.brand_restored" : "catalog.brand_deactivated", "brand", id);
  response.status(204).end();
});