import { Router, type RequestHandler } from "express";
import { z } from "zod";
import { requireAdmin, requireCsrf, requirePermission } from "../middleware/auth.js";
import { AppError } from "../middleware/error-handler.js";
import {
  calculateSupplierPrice,
  getTooniesCatalogueDetail,
  importTooniesCatalogue,
  listShippingRules,
  listPricingRules,
  listPriceChangeReviews,
  listTooniesCategoryMappings,
  listActiveShippingZones,
  listTooniesSyncRuns,
  listTooniesCatalogue,
  reconcileLinkedCatalogueStructuredOptions,
  saveShippingRule,
  savePricingRule,
  setTooniesNormalizedCost,
  setTooniesVariantNormalizedCost,
  setTooniesSellingPrice,
  setTooniesVariantSellingPrice,
  syncTooniesDetail,
  syncTooniesSearch,
  tooniesOverview,
  resolveTooniesShipping,
  decidePriceChangeReview,
  resumeTooniesSync,
} from "../suppliers/toonies-service.js";
import { updateSupplierCategoryMapping } from "../catalog/supplier-mapping.js";
import { getDatabasePool } from "../db/client.js";
import { getEuropeanCountry } from "../../shared/europeanCountries.js";
import { getFxStatus, refreshFxRate } from "../fx/service.js";
import { auditSecurityEvent } from "../auth/service.js";
import { assertTooniesProcurementEnabled } from "../suppliers/toonies-procurement-gate.js";
import {
  createTooniesProcurementAttempt,
  getTooniesProcurementAttempt,
  listTooniesProcurementAttempts,
  pollTooniesProcurementAttempt,
} from "../suppliers/toonies-procurement-service.js";
import {
  listTooniesSettlements,
  markTooniesSettlementManualReview,
  reconcileTooniesSettlement,
  replayTooniesSettlement,
  settleTooniesProcurementAttempt,
} from "../suppliers/toonies-settlement-service.js";

export const tooniesRouter = Router();

function access(permission: string): RequestHandler[] {
  return [requireAdmin, requirePermission(permission)];
}
function mutate(permission: string): RequestHandler[] {
  return [requireCsrf, requireAdmin, requirePermission(permission)];
}
function body<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new AppError(400, "VALIDATION_ERROR", "The Toonies request could not be validated.", result.error.flatten());
  return result.data;
}
function param(request: Parameters<RequestHandler>[0], key: string): string {
  const value = request.params[key];
  if (!value || Array.isArray(value)) throw new AppError(400, "INVALID_ID", "A valid supplier identifier is required.");
  if (!z.string().uuid().safeParse(value).success) throw new AppError(400, "INVALID_ID", "A valid supplier identifier is required.");
  return value;
}

tooniesRouter.get("/admin/suppliers/toonies/overview", ...access("supplier_integrations.view"), async (_request, response) => {
  response.json({ data: await tooniesOverview() });
});

tooniesRouter.get("/admin/suppliers/toonies/fx", ...access("supplier_integrations.view"), async (_request, response) => {
  response.json({ data: await getFxStatus() });
});

tooniesRouter.post("/admin/suppliers/toonies/fx/refresh", ...mutate("supplier_integrations.pricing"), async (_request, response) => {
  response.json({ data: await refreshFxRate() });
});

tooniesRouter.get("/admin/suppliers/toonies/catalogue", ...access("supplier_integrations.view"), async (request, response) => {
  const query = body(z.object({
    page: z.coerce.number().int().min(1).optional(),
    pageSize: z.coerce.number().int().min(1).max(100).optional(),
    state: z.string().optional(),
    search: z.string().max(200).optional(),
    mapping: z.enum(["all", "mapped", "unmapped"]).optional(),
    categoryId: z.string().uuid().optional(),
  }).strict(), request.query);
  response.json({ data: await listTooniesCatalogue(query) });
});

tooniesRouter.get("/admin/suppliers/toonies/catalogue/:id", ...access("supplier_integrations.view"), async (request, response) => {
  response.json({ data: await getTooniesCatalogueDetail(param(request, "id")) });
});

tooniesRouter.post("/admin/suppliers/toonies/categories/sync", ...mutate("supplier_integrations.sync"), async (request, response) => {
  const input = body(z.object({ keyword: z.string().min(1).max(100), pageSize: z.number().int().min(1).max(20).optional(), categoryId: z.string().min(1).max(255).optional() }).strict(), request.body);
  response.status(202).json({ data: await syncTooniesSearch(input) });
});

tooniesRouter.get("/admin/suppliers/toonies/categories", ...access("supplier_integrations.view"), async (request, response) => {
  const query = body(z.object({
    page: z.coerce.number().int().min(1).optional(),
    pageSize: z.coerce.number().int().min(1).max(50).optional(),
    search: z.string().max(200).optional(),
    status: z.enum(["mapped", "unmapped", "ignored", "needs_review"]).optional(),
  }).strict(), request.query);
  response.json({ data: await listTooniesCategoryMappings(query) });
});

tooniesRouter.patch("/admin/suppliers/toonies/categories/:id", ...mutate("supplier_integrations.manage"), async (request, response) => {
  const input = body(z.object({
    rootCategoryId: z.string().uuid().nullable().optional(),
    childCategoryId: z.string().uuid().nullable().optional(),
    status: z.enum(["mapped", "unmapped", "ignored", "needs_review"]).optional(),
    publicationEnabled: z.boolean().optional(),
    complianceExcluded: z.boolean().optional(),
    reason: z.string().max(1000).nullable().optional(),
  }).strict(), request.body);
  const mapping = await getDatabasePool().query<{ supplierId: string }>("SELECT m.supplier_id AS \"supplierId\" FROM supplier_category_mappings m JOIN suppliers s ON s.id=m.supplier_id WHERE m.id=$1 AND s.slug='toonies'", [param(request, "id")]);
  if (!mapping.rows[0]) throw new AppError(404, "SUPPLIER_MAPPING_NOT_FOUND", "The supplier category mapping was not found.");
  response.json({ data: await updateSupplierCategoryMapping(param(request, "id"), input, request.auth!.userId) });
});

tooniesRouter.post("/admin/suppliers/toonies/catalogue/sync", ...mutate("supplier_integrations.sync"), async (request, response) => {
  const input = body(z.object({ keyword: z.string().min(1).max(100), pageSize: z.number().int().min(1).max(20).optional(), categoryId: z.string().min(1).max(255).optional() }).strict(), request.body);
  response.status(202).json({ data: await syncTooniesSearch(input) });
});

tooniesRouter.post("/admin/suppliers/toonies/catalogue/import", ...mutate("supplier_integrations.import"), async (request, response) => {
  const input = body(z.object({ ids: z.array(z.string().uuid()).min(1).max(500) }).strict(), request.body);
  response.status(202).json({ data: await importTooniesCatalogue(input.ids) });
});

tooniesRouter.post("/admin/suppliers/toonies/catalogue/:id/reconcile-structured-options", ...mutate("supplier_integrations.sync"), async (request, response) => {
  const input = body(z.object({ productId: z.string().uuid() }).strict(), request.body);
  response.json({
    data: await reconcileLinkedCatalogueStructuredOptions({
      catalogueItemId: param(request, "id"),
      productId: input.productId,
      actorAdminId: request.auth!.userId,
    }),
  });
});

tooniesRouter.patch("/admin/suppliers/toonies/catalogue/:id/normalized-cost", ...mutate("supplier_integrations.pricing"), async (request, response) => {
  const input = body(z.object({ normalizedEur: z.number().finite().min(0) }).strict(), request.body);
  response.json({ data: await setTooniesNormalizedCost(param(request, "id"), input.normalizedEur) });
});

tooniesRouter.patch("/admin/suppliers/toonies/variants/:id/normalized-cost", ...mutate("supplier_integrations.pricing"), async (request, response) => {
  const input = body(z.object({ normalizedEur: z.number().finite().min(0) }).strict(), request.body);
  response.json({ data: await setTooniesVariantNormalizedCost(param(request, "id"), input.normalizedEur) });
});

tooniesRouter.patch("/admin/suppliers/toonies/catalogue/:id/selling-price", ...mutate("supplier_integrations.pricing"), async (request, response) => {
  const input = body(z.object({ sellingPriceEur: z.number().finite().min(0).nullable() }).strict(), request.body);
  const id = param(request, "id");
  try {
    response.json({ data: await setTooniesSellingPrice(id, input.sellingPriceEur) });
  } catch (error) {
    if (error instanceof AppError && error.code === "MANUAL_PRICE_BELOW_COST") await auditSecurityEvent({ actorUserId: request.auth!.userId, action: "supplier.manual_price_rejected_below_cost", entityType: "supplier_catalogue_item", entityId: id, request });
    throw error;
  }
});

tooniesRouter.patch("/admin/suppliers/toonies/variants/:id/selling-price", ...mutate("supplier_integrations.pricing"), async (request, response) => {
  const input = body(z.object({ sellingPriceEur: z.number().finite().min(0).nullable() }).strict(), request.body);
  const id = param(request, "id");
  try {
    response.json({ data: await setTooniesVariantSellingPrice(id, input.sellingPriceEur) });
  } catch (error) {
    if (error instanceof AppError && error.code === "MANUAL_PRICE_BELOW_COST") await auditSecurityEvent({ actorUserId: request.auth!.userId, action: "supplier.variant_manual_price_rejected_below_cost", entityType: "supplier_catalogue_variant", entityId: id, request });
    throw error;
  }
});

tooniesRouter.post("/admin/suppliers/toonies/catalogue/detail", ...mutate("supplier_integrations.sync"), async (request, response) => {
  const input = body(z.object({ productCode: z.string().min(1).max(64) }).strict(), request.body);
  response.status(202).json({ data: await syncTooniesDetail(input.productCode) });
});

tooniesRouter.get("/admin/suppliers/toonies/pricing", ...access("supplier_integrations.view"), async (_request, response) => {
  response.json({ data: await listPricingRules() });
});

tooniesRouter.get("/admin/commercial-profit/pricing-bands", ...access("analytics.view"), async (_request, response) => {
  const rules = await listPricingRules();
  response.json({
    data: rules
      .filter((rule: any) => rule.active)
      .map((rule: any) => ({
        id: rule.id,
        name: rule.name,
        ruleType: rule.ruleType,
        minCostEur: String(rule.minCostEur),
        maxCostEur: rule.maxCostEur === null ? null : String(rule.maxCostEur),
        value: String(rule.value),
        roundingMode: rule.roundingMode,
        priority: rule.priority,
      })),
  });
});

tooniesRouter.get("/admin/suppliers/toonies/pricing/reviews", ...access("supplier_integrations.view"), async (_request, response) => {
  response.json({ data: await listPriceChangeReviews() });
});

tooniesRouter.post("/admin/suppliers/toonies/pricing/reviews/:id/decision", ...mutate("supplier_integrations.pricing"), async (request, response) => {
  const input = body(z.object({ decision: z.enum(["accept", "reject"]), note: z.string().trim().max(1000).nullable().optional() }).strict(), request.body);
  response.json({ data: await decidePriceChangeReview(param(request, "id"), input.decision, request.auth!.userId, input.note) });
});

const pricingSchema = z.object({
  name: z.string().trim().min(1).max(150),
  ruleType: z.enum(["markup_percent", "markup_fixed", "margin_percent"]),
  minCostEur: z.number().finite().min(0).default(0),
  maxCostEur: z.number().finite().min(0).nullable().default(null),
  value: z.number().finite().min(0),
  roundingMode: z.enum(["none", "whole", "99"]).default("none"),
  priority: z.number().int().min(0).max(1_000_000).default(0),
  active: z.boolean().default(true),
  significantCostIncreasePercent: z.number().finite().min(0).max(1000).default(20),
}).strict();

tooniesRouter.post("/admin/suppliers/toonies/pricing", ...mutate("supplier_integrations.pricing"), async (request, response) => {
  const input = body(pricingSchema, request.body);
  response.status(201).json({ data: await savePricingRule(input) });
});

tooniesRouter.patch("/admin/suppliers/toonies/pricing/:id", ...mutate("supplier_integrations.pricing"), async (request, response) => {
  const input = body(pricingSchema, request.body);
  response.json({ data: await savePricingRule(input, param(request, "id")) });
});

tooniesRouter.post("/admin/suppliers/toonies/pricing/preview", ...access("supplier_integrations.pricing"), async (request, response) => {
  const input = body(z.object({
    cost: z.number().finite().min(0),
    ruleType: z.enum(["markup_percent", "markup_fixed", "margin_percent"]),
    value: z.number().finite().min(0),
    roundingMode: z.enum(["none", "whole", "99"]).optional(),
  }).strict(), request.body);
  response.json({ data: { price: calculateSupplierPrice(input.cost, input) } });
});

tooniesRouter.post("/admin/suppliers/toonies/synchronization", ...mutate("supplier_integrations.sync"), async (request, response) => {
  const input = body(z.object({ productCode: z.string().min(1).max(64).optional(), keyword: z.string().min(1).max(100).optional(), pageSize: z.number().int().min(1).max(20).optional(), categoryId: z.string().min(1).max(255).optional() }).strict().refine((value) => Boolean(value.productCode || value.keyword)), request.body);
  response.status(202).json({ data: input.productCode ? await syncTooniesDetail(input.productCode) : await syncTooniesSearch({ keyword: input.keyword!, pageSize: input.pageSize, categoryId: input.categoryId }) });
});

tooniesRouter.get("/admin/suppliers/toonies/synchronization", ...access("supplier_integrations.view"), async (_request, response) => {
  response.json({ data: await listTooniesSyncRuns() });
});

tooniesRouter.post("/admin/suppliers/toonies/synchronization/:id/resume", ...mutate("supplier_integrations.sync"), async (request, response) => {
  const input = body(z.object({ keyword: z.string().min(1).max(100).optional(), pageSize: z.number().int().min(1).max(20).optional(), categoryId: z.string().min(1).max(255).optional() }).strict(), request.body);
  response.status(202).json({ data: await resumeTooniesSync(param(request, "id"), input) });
});

// Admin requests are manual and orderless. Paid-order binding is reserved for
// the fingerprint-checked durable command worker.
tooniesRouter.post("/admin/suppliers/toonies/procurement/precheck", ...mutate("supplier_integrations.sync"), async (request, response) => {
  await assertTooniesProcurementEnabled();
  const input = body(z.object({ lines: z.array(z.object({
      productId: z.string().uuid(),
      variantId: z.string().uuid(),
      quantity: z.number().int().positive().max(2_147_483_647),
    }).strict()).min(1).max(200) }).strict(),
  request.body);
  const data = await createTooniesProcurementAttempt(input, request.auth!.userId);
  await auditSecurityEvent({ actorUserId: request.auth!.userId, action: "supplier.toonies_precheck_started", entityType: "toonies_procurement_attempt", entityId: data.id, request });
  response.status(202).json({ data });
});

tooniesRouter.post("/admin/suppliers/toonies/procurement/:id/poll", ...mutate("supplier_integrations.sync"), async (request, response) => {
  await assertTooniesProcurementEnabled();
  const id = param(request, "id");
  const input = body(z.object({ maxPolls: z.number().int().min(1).max(10).optional() }).strict(), request.body);
  const data = await pollTooniesProcurementAttempt(id, input.maxPolls);
  await auditSecurityEvent({ actorUserId: request.auth!.userId, action: "supplier.toonies_task_polled", entityType: "toonies_procurement_attempt", entityId: id, request });
  response.json({ data });
});

tooniesRouter.get("/admin/suppliers/toonies/procurement", ...access("supplier_integrations.view"), async (request, response) => {
  const input = body(z.object({ limit: z.coerce.number().int().min(1).max(100).optional() }).strict(), request.query);
  response.json({ data: await listTooniesProcurementAttempts(input.limit) });
});

tooniesRouter.get("/admin/suppliers/toonies/procurement/:id", ...access("supplier_integrations.view"), async (request, response) => {
  response.json({ data: await getTooniesProcurementAttempt(param(request, "id")) });
});

tooniesRouter.get("/admin/suppliers/toonies/settlements", ...access("supplier_integrations.view"), async (request, response) => {
  const input = body(z.object({ limit: z.coerce.number().int().min(1).max(100).optional() }).strict(), request.query);
  response.json({ data: await listTooniesSettlements(input.limit) });
});

tooniesRouter.post("/admin/suppliers/toonies/settlements/:id/replay", ...mutate("supplier_integrations.sync"), async (request, response) => {
  const id = param(request, "id");
  const data = await replayTooniesSettlement(id);
  await auditSecurityEvent({ actorUserId: request.auth!.userId, action: "supplier.toonies_settlement_replayed_same_identity", entityType: "toonies_settlement", entityId: id, request });
  response.json({ data });
});

tooniesRouter.post("/admin/suppliers/toonies/settlements/:id/reconcile", ...mutate("supplier_integrations.sync"), async (request, response) => {
  const id = param(request, "id");
  const data = await reconcileTooniesSettlement(id);
  await auditSecurityEvent({ actorUserId: request.auth!.userId, action: "supplier.toonies_settlement_reconciled", entityType: "toonies_settlement", entityId: id, request });
  response.json({ data });
});

tooniesRouter.post("/admin/suppliers/toonies/settlements/:id/manual-review", ...mutate("supplier_integrations.sync"), async (request, response) => {
  const id = param(request, "id");
  const input = body(z.object({ reason: z.string().trim().min(1).max(2000) }).strict(), request.body);
  const data = await markTooniesSettlementManualReview(id, input.reason);
  await auditSecurityEvent({ actorUserId: request.auth!.userId, action: "supplier.toonies_settlement_manual_review", entityType: "toonies_settlement", entityId: id, request });
  response.json({ data });
});

tooniesRouter.get("/admin/suppliers/toonies/shipping", ...access("supplier_shipping.view"), async (_request, response) => {
  response.json({ data: await listShippingRules() });
});

tooniesRouter.get("/admin/suppliers/toonies/shipping/zones", ...access("supplier_shipping.view"), async (_request, response) => {
  response.json({ data: await listActiveShippingZones() });
});

const shippingSchema = z.object({
  countryCode: z.string().trim().transform((value) => value.toUpperCase()).refine((value) => Boolean(getEuropeanCountry(value)), "Select a supported ISO country code.").nullable().optional(),
  destinationZoneId: z.string().uuid().nullable().optional(),
  minWeightKg: z.number().finite().min(0).optional(),
  maxWeightKg: z.number().finite().min(0).nullable().optional(),
  amountEur: z.number().finite().min(0),
  minDeliveryDays: z.number().int().min(0).nullable().optional(),
  maxDeliveryDays: z.number().int().min(0).nullable().optional(),
  temporary: z.literal(true),
  active: z.boolean().optional(),
  expiresAt: z.string().datetime().nullable().optional(),
}).strict().refine((value) => Boolean(value.countryCode) !== Boolean(value.destinationZoneId), "Select exactly one country or active shipping zone.");

tooniesRouter.post("/admin/suppliers/toonies/shipping", ...mutate("supplier_shipping.manage"), async (request, response) => {
  const input = body(shippingSchema, request.body);
  response.status(201).json({ data: await saveShippingRule(input, undefined, request.auth!.userId) });
});

tooniesRouter.post("/admin/suppliers/toonies/shipping/quote", ...access("supplier_shipping.view"), async (request, response) => {
  const input = body(z.object({ countryCode: z.string().trim().transform((value) => value.toUpperCase()).refine((value) => Boolean(getEuropeanCountry(value)), "Select a supported ISO country code."), weightKg: z.number().finite().min(0) }).strict(), request.body);
  response.json({ data: await resolveTooniesShipping(input) });
});

tooniesRouter.patch("/admin/suppliers/toonies/shipping/:id", ...mutate("supplier_shipping.manage"), async (request, response) => {
  const input = body(shippingSchema, request.body);
  response.json({ data: await saveShippingRule(input, param(request, "id"), request.auth!.userId) });
});