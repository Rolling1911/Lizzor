import { Router } from "express";
import multer from "multer";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { auditSecurityEvent, canUser } from "../auth/service.js";
import { requireAdmin, requireCsrf, requirePermission } from "../middleware/auth.js";
import { AppError } from "../middleware/error-handler.js";
import { getDatabasePool } from "../db/client.js";
import { copyTiers, exportPricingTiers, getPricing, getTiers, listPricingItems, replaceTierGroups, replaceTiers, validateTierGroup, type TierGroup } from "../pricing/service.js";

const tierSchema = z.object({ id: z.string().uuid().optional(), minQuantity: z.number().int().min(1), maxQuantity: z.number().int().min(1).nullable(), unitPrice: z.number().finite().min(0), active: z.boolean().default(true) });
const tiersSchema = z.object({ productId: z.string().uuid().nullable().optional(), variantId: z.string().uuid().nullable().optional(), tiers: z.array(tierSchema) });
const copySchema = z.object({ sourceProductId: z.string().uuid().nullable().optional(), sourceVariantId: z.string().uuid().nullable().optional(), targets: z.array(z.object({ productId: z.string().uuid().nullable().optional(), variantId: z.string().uuid().nullable().optional() })).min(1) });
const bulkSchema = z.object({ targets: z.array(z.object({ productId: z.string().uuid().nullable().optional(), variantId: z.string().uuid().nullable().optional() })).min(1), adjustmentType: z.enum(["percent", "amount"]), value: z.number().finite() });
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1 } });
const bulkPreviews = new Map<string, { expiresAt: number; targets: Array<{ productId: string | null; variantId: string | null; tiers: Array<{ minQuantity: number; maxQuantity: number | null; unitPrice: number; active: boolean }> }> }>();
const importPreviews = new Map<string, { expiresAt: number; groups: TierGroup[]; rows: number }>();

function middleware(permission: string) { return [requireAdmin, requirePermission(permission)]; }
function mutation(permission: string) { return [requireCsrf, requireAdmin, requirePermission(permission)]; }
function valid<T>(schema: z.ZodType<T>, value: unknown): T { const result = schema.safeParse(value); if (!result.success) throw new AppError(400, "VALIDATION_ERROR", "The request could not be validated.", result.error.flatten()); return result.data; }
function query(value: unknown): string | undefined { return typeof value === "string" && value.trim() ? value : undefined; }
function idParam(value: string | string[]): string { if (Array.isArray(value) || !value) throw new AppError(400, "INVALID_ID", "A valid identifier is required."); return value; }
async function audit(request: Parameters<typeof requireAdmin>[0], action: string, entityType: string, entityId?: string) { if (request.auth) await auditSecurityEvent({ actorUserId: request.auth.userId, action, entityType, entityId, request }); }

export const pricingRouter = Router();

pricingRouter.get("/pricing/quote", async (request, response) => {
  const productId = query(request.query.productId) ?? null;
  const variantId = query(request.query.variantId) ?? null;
  const quantity = Number(request.query.quantity);
  const visible = await getDatabasePool().query<{ id: string }>(
    `SELECT p.id
       FROM products p
       JOIN categories c ON c.id=p.category_id
      WHERE (p.id=$1 OR EXISTS (SELECT 1 FROM product_variants pv WHERE pv.id=$2 AND pv.product_id=p.id))
        AND p.status='active' AND p.published_at IS NOT NULL
        AND c.active=true
        AND (c.parent_id IS NULL OR EXISTS (SELECT 1 FROM categories parent WHERE parent.id=c.parent_id AND parent.active=true))`,
    [productId, variantId],
  );
  if (!visible.rows[0]) throw new AppError(404, "PRODUCT_NOT_FOUND", "The requested product was not found.");
  const quote = await getPricing(productId, variantId, quantity);
  response.json({ data: { productId: quote.productId, variantId: quote.variantId, quantity: quote.quantity, unitPrice: quote.unitPrice, totalPrice: quote.totalPrice, source: quote.source } });
});

pricingRouter.get("/admin/pricing", ...middleware("pricing.view"), async (request, response) => {
  response.json({ data: await listPricingItems({ page: Number(request.query.page ?? 1), pageSize: Number(request.query.pageSize ?? 25), search: query(request.query.search), productId: query(request.query.productId), hasTiers: request.query.hasTiers === undefined ? undefined : request.query.hasTiers === "true" }, await canUser(request.auth!.userId, "product_cost.view")) });
});

pricingRouter.get("/admin/pricing/quote", ...middleware("pricing.view"), async (request, response) => {
  const quote = await getPricing(query(request.query.productId) ?? null, query(request.query.variantId) ?? null, Number(request.query.quantity));
  const includeCost = await canUser(request.auth!.userId, "product_cost.view");
  response.json({ data: includeCost ? quote : { productId: quote.productId, variantId: quote.variantId, quantity: quote.quantity, unitPrice: quote.unitPrice, totalPrice: quote.totalPrice, source: quote.source } });
});

pricingRouter.get("/admin/pricing/product/:id/tiers", ...middleware("pricing.view"), async (request, response) => {
  response.json({ data: await getTiers(idParam(request.params.id), null) });
});

pricingRouter.get("/admin/pricing/variant/:id/tiers", ...middleware("pricing.view"), async (request, response) => {
  response.json({ data: await getTiers(null, idParam(request.params.id)) });
});

pricingRouter.put("/admin/pricing/tiers", ...mutation("pricing.edit"), async (request, response) => {
  const input = valid(tiersSchema, request.body);
  let tiers;
  try {
    tiers = await replaceTiers(input.productId ?? null, input.variantId ?? null, input.tiers);
  } catch (error) {
    if (error instanceof AppError && error.code === "PRICE_TIER_BELOW_COST") await audit(request, "pricing.tiers_rejected_below_cost", "price_tiers", input.variantId ?? input.productId ?? undefined);
    throw error;
  }
  await audit(request, "pricing.tiers_replaced", "price_tiers", input.variantId ?? input.productId ?? undefined);
  response.json({ data: tiers });
});

pricingRouter.post("/admin/pricing/copy", ...mutation("pricing.edit"), async (request, response) => {
  const input = valid(copySchema, request.body);
  const result = await copyTiers(input.sourceProductId ?? null, input.sourceVariantId ?? null, input.targets.map((target) => ({ productId: target.productId ?? null, variantId: target.variantId ?? null })));
  await audit(request, "pricing.tiers_copied", "price_tiers");
  response.json({ data: result });
});

pricingRouter.post("/admin/pricing/bulk/preview", ...mutation("pricing.bulk"), async (request, response) => {
  const input = valid(bulkSchema, request.body);
  const targets = [];
  let affectedTiers = 0;
  for (const target of input.targets) {
    const tiers = await getTiers(target.productId ?? null, target.variantId ?? null);
    const adjusted = tiers.map((tier) => {
      const unitPrice = input.adjustmentType === "percent" ? tier.unitPrice * (1 + input.value / 100) : tier.unitPrice + input.value;
      if (unitPrice < 0) throw new AppError(400, "NEGATIVE_BULK_PRICE", "The adjustment would create a negative tier price.");
      return { minQuantity: tier.minQuantity, maxQuantity: tier.maxQuantity, unitPrice: Number(unitPrice.toFixed(2)), active: tier.active };
    });
    await validateTierGroup(target.productId ?? null, target.variantId ?? null, adjusted);
    affectedTiers += adjusted.length;
    targets.push({ productId: target.productId ?? null, variantId: target.variantId ?? null, tiers: adjusted });
  }
  const previewId = randomUUID();
  bulkPreviews.set(previewId, { expiresAt: Date.now() + 15 * 60 * 1000, targets });
  response.status(202).json({ data: { previewId, targetCount: targets.length, affectedTiers, adjustmentType: input.adjustmentType, value: input.value } });
});

pricingRouter.post("/admin/pricing/bulk/commit", ...mutation("pricing.bulk"), async (request, response) => {
  const input = valid(z.object({ previewId: z.string().uuid() }), request.body);
  const preview = bulkPreviews.get(input.previewId);
  bulkPreviews.delete(input.previewId);
  if (!preview || preview.expiresAt < Date.now()) throw new AppError(404, "PRICING_PREVIEW_EXPIRED", "The bulk pricing preview has expired.");
  await replaceTierGroups(preview.targets);
  await audit(request, "pricing.bulk_adjusted", "price_tiers");
  response.json({ data: { updatedTargets: preview.targets.length } });
});

pricingRouter.post("/admin/pricing/import/preview", ...mutation("pricing.import"), upload.single("file"), async (request, response) => {
  if (!request.file) throw new AppError(400, "IMPORT_FILE_REQUIRED", "Choose a pricing CSV file.");
  const lines = request.file.buffer.toString("utf8").replace(/^\uFEFF/, "").split(/\r?\n/).filter(Boolean);
  const headers = lines.shift()?.split(",").map((header) => header.trim().toLowerCase()) ?? [];
  const groups = new Map<string, { productId: string | null; variantId: string | null; tiers: Array<{ minQuantity: number; maxQuantity: number | null; unitPrice: number; active: boolean }> }>();
  for (let index = 0; index < lines.length; index += 1) {
    const values = lines[index]!.split(",").map((value) => value.trim());
    const row = Object.fromEntries(headers.map((header, position) => [header, values[position] ?? ""]));
    const scopeId = row.scope_id;
    const scopeType = row.scope_type;
    if (!scopeId || !["product", "variant"].includes(scopeType)) throw new AppError(400, "INVALID_PRICING_IMPORT", `Row ${index + 2} has an invalid scope.`);
    const key = `${scopeType}:${scopeId}`;
    const group = groups.get(key) ?? { productId: scopeType === "product" ? scopeId : null, variantId: scopeType === "variant" ? scopeId : null, tiers: [] };
    group.tiers.push({ minQuantity: Number(row.min_quantity), maxQuantity: row.max_quantity ? Number(row.max_quantity) : null, unitPrice: Number(row.unit_price), active: row.active.toLowerCase() !== "false" });
    groups.set(key, group);
  }
  for (const group of groups.values()) await validateTierGroup(group.productId, group.variantId, group.tiers);
  const previewId = randomUUID();
  importPreviews.set(previewId, { expiresAt: Date.now() + 15 * 60 * 1000, groups: [...groups.values()], rows: lines.length });
  response.status(202).json({ data: { previewId, scopes: groups.size, rows: lines.length } });
});

pricingRouter.post("/admin/pricing/import/commit", ...mutation("pricing.import"), async (request, response) => {
  const input = valid(z.object({ previewId: z.string().uuid() }), request.body);
  const preview = importPreviews.get(input.previewId);
  importPreviews.delete(input.previewId);
  if (!preview || preview.expiresAt < Date.now()) throw new AppError(404, "PRICING_IMPORT_PREVIEW_EXPIRED", "The pricing import preview has expired.");
  await replaceTierGroups(preview.groups);
  await audit(request, "pricing.import_completed", "pricing_import");
  response.json({ data: { updatedScopes: preview.groups.length, rows: preview.rows } });
});

pricingRouter.get("/admin/pricing/export", ...middleware("pricing.export"), async (request, response) => {
  const tiers = await exportPricingTiers({ search: query(request.query.search), productId: query(request.query.productId) });
  const rows: string[] = ["scope_id,scope_type,sku,min_quantity,max_quantity,unit_price,active"];
  for (const tier of tiers as any[]) rows.push([tier.scopeId, tier.scopeType, tier.sku, tier.minQuantity, tier.maxQuantity ?? "", tier.unitPrice, tier.active].join(","));
  response.setHeader("content-type", "text/csv; charset=utf-8");
  response.setHeader("content-disposition", "attachment; filename=\"lizzor-pricing.csv\"");
  response.send(`${rows.join("\n")}\n`);
});