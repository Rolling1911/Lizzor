import { Router, type Request } from "express";
import { z } from "zod";
import { auditSecurityEvent } from "../auth/service.js";
import { getDatabasePool } from "../db/client.js";
import { requireAdmin, requireCsrf, requirePermission } from "../middleware/auth.js";
import { AppError } from "../middleware/error-handler.js";

const inputSchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).nullable().optional(),
  promotionType: z.enum(["product", "category", "brand", "order"]),
  discountType: z.enum(["percentage", "fixed"]).nullable().optional(),
  discountValue: z.number().finite().min(0).max(1_000_000).nullable().optional(),
  minimumOrderValue: z.number().finite().min(0).nullable().optional(),
  freeShipping: z.boolean().default(false),
  automatic: z.boolean().default(true),
  couponCode: z.string().trim().max(80).nullable().optional(),
  usageLimit: z.number().int().positive().nullable().optional(),
  usageLimitPerCustomer: z.number().int().positive().nullable().optional(),
  allowStacking: z.boolean().default(false),
  priority: z.number().int().min(-10000).max(10000).default(0),
  startAt: z.string().datetime(),
  endAt: z.string().datetime().nullable().optional(),
  active: z.boolean().default(false),
  productIds: z.array(z.string().uuid()).default([]),
  categoryIds: z.array(z.string().uuid()).default([]),
  brandIds: z.array(z.string().uuid()).default([]),
}).superRefine((value, ctx) => {
  if (!value.freeShipping && (!value.discountType || value.discountValue === null || value.discountValue === undefined)) ctx.addIssue({ code: "custom", message: "A discount value is required." });
  if (value.discountType === "percentage" && Number(value.discountValue) > 100) ctx.addIssue({ code: "custom", message: "Percentage discounts cannot exceed 100." });
  if (value.endAt && new Date(value.endAt) < new Date(value.startAt)) ctx.addIssue({ code: "custom", message: "End time must be after start time." });
  if (!value.automatic && !value.couponCode?.trim()) ctx.addIssue({ code: "custom", message: "Coupon promotions require a code." });
  const targets = value.promotionType === "product" ? value.productIds : value.promotionType === "category" ? value.categoryIds : value.promotionType === "brand" ? value.brandIds : ["order"];
  if (!targets.length) ctx.addIssue({ code: "custom", message: `Choose at least one eligible ${value.promotionType}.` });
});

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new AppError(400, "VALIDATION_ERROR", "The promotion could not be validated.", result.error.flatten());
  return result.data;
}
function id(request: Request) {
  const value = request.params.id;
  if (!value || Array.isArray(value) || !z.string().uuid().safeParse(value).success) throw new AppError(400, "INVALID_ID", "A valid promotion identifier is required.");
  return value;
}
async function audit(request: Request, action: string, entityId: string) {
  await auditSecurityEvent({ actorUserId: request.auth!.userId, action, entityType: "promotion", entityId, request });
}

async function listPromotions() {
  const result = await getDatabasePool().query(
    `SELECT c.id,c.name,c.description,c.promotion_type AS "promotionType",c.discount_type AS "discountType",c.discount_value AS "discountValue",
            c.minimum_order_value AS "minimumOrderValue",c.free_shipping AS "freeShipping",c.automatic,c.coupon_code AS "couponCode",
            c.usage_limit AS "usageLimit",c.usage_limit_per_customer AS "usageLimitPerCustomer",c.allow_stacking AS "allowStacking",
            c.priority,c.start_at AS "startAt",c.end_at AS "endAt",c.active,c.archived_at AS "archivedAt",
            CASE WHEN c.archived_at IS NOT NULL OR NOT c.active THEN 'disabled' WHEN c.start_at>now() THEN 'scheduled' WHEN c.end_at IS NOT NULL AND c.end_at<now() THEN 'expired' ELSE 'active' END AS status,
            (SELECT count(*)::int FROM promotion_usages u WHERE u.campaign_id=c.id) AS "usageCount",
            COALESCE((SELECT json_agg(product_id) FROM promotion_products WHERE campaign_id=c.id),'[]') AS "productIds",
            COALESCE((SELECT json_agg(category_id) FROM promotion_categories WHERE campaign_id=c.id),'[]') AS "categoryIds",
            COALESCE((SELECT json_agg(brand_id) FROM promotion_brands WHERE campaign_id=c.id),'[]') AS "brandIds"
       FROM promotion_campaigns c ORDER BY c.archived_at NULLS FIRST,c.created_at DESC`,
  );
  return result.rows.map((row) => ({ ...row, discountValue: row.discountValue === null ? null : Number(row.discountValue), minimumOrderValue: row.minimumOrderValue === null ? null : Number(row.minimumOrderValue) }));
}

async function savePromotion(request: Request, promotionId?: string) {
  const input = parse(inputSchema, request.body);
  const client = await getDatabasePool().connect();
  const code = input.couponCode?.trim().toUpperCase() || null;
  try {
    await client.query("BEGIN");
    const values = [input.name,input.description ?? null,input.promotionType,input.discountType ?? null,input.discountValue ?? null,input.minimumOrderValue ?? null,input.freeShipping,input.automatic,code,input.usageLimit ?? null,input.usageLimitPerCustomer ?? null,input.allowStacking,input.priority,input.startAt,input.endAt ?? null,input.active];
    const row = promotionId
      ? (await client.query(`UPDATE promotion_campaigns SET name=$1,description=$2,promotion_type=$3,discount_type=$4,discount_value=$5,minimum_order_value=$6,free_shipping=$7,automatic=$8,coupon_code=$9,usage_limit=$10,usage_limit_per_customer=$11,allow_stacking=$12,priority=$13,start_at=$14,end_at=$15,active=$16,updated_at=now() WHERE id=$17 AND archived_at IS NULL RETURNING id`, [...values,promotionId])).rows[0]
      : (await client.query(`INSERT INTO promotion_campaigns (name,description,promotion_type,discount_type,discount_value,minimum_order_value,free_shipping,automatic,coupon_code,usage_limit,usage_limit_per_customer,allow_stacking,priority,start_at,end_at,active) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id`, values)).rows[0];
    if (!row) throw new AppError(404, "PROMOTION_NOT_FOUND", "The promotion was not found.");
    await Promise.all(["promotion_products","promotion_categories","promotion_brands"].map((table) => client.query(`DELETE FROM ${table} WHERE campaign_id=$1`, [row.id])));
    for (const productId of input.productIds) await client.query("INSERT INTO promotion_products (campaign_id,product_id) VALUES ($1,$2)", [row.id,productId]);
    for (const categoryId of input.categoryIds) await client.query("INSERT INTO promotion_categories (campaign_id,category_id) VALUES ($1,$2)", [row.id,categoryId]);
    for (const brandId of input.brandIds) await client.query("INSERT INTO promotion_brands (campaign_id,brand_id) VALUES ($1,$2)", [row.id,brandId]);
    await client.query("COMMIT");
    await audit(request, promotionId ? "promotion.edited" : "promotion.created", row.id);
    return row.id;
  } catch (error: any) {
    await client.query("ROLLBACK");
    if (error?.code === "23505") throw new AppError(409, "COUPON_CODE_EXISTS", "That coupon code is already in use.");
    throw error;
  } finally { client.release(); }
}

export const promotionsRouter = Router();
promotionsRouter.get("/admin/promotions", requireAdmin, requirePermission("promotions.view"), async (_request, response) => response.json({ data: await listPromotions() }));
promotionsRouter.get("/admin/promotions/lookups", requireAdmin, requirePermission("promotions.view"), async (_request, response) => {
  const [products,categories,brands] = await Promise.all([
    getDatabasePool().query("SELECT id,name FROM products WHERE status <> 'archived' ORDER BY name"),
    getDatabasePool().query("SELECT id,name FROM categories WHERE active=true ORDER BY name"),
    getDatabasePool().query("SELECT id,name FROM brands WHERE active=true ORDER BY name"),
  ]);
  response.json({ data: { products: products.rows, categories: categories.rows, brands: brands.rows } });
});
promotionsRouter.post("/admin/promotions", requireCsrf, requireAdmin, requirePermission("promotions.create"), async (request, response) => response.status(201).json({ data: { id: await savePromotion(request) } }));
promotionsRouter.put("/admin/promotions/:id", requireCsrf, requireAdmin, requirePermission("promotions.edit"), async (request, response) => response.json({ data: { id: await savePromotion(request, id(request)) } }));
promotionsRouter.post("/admin/promotions/:id/archive", requireCsrf, requireAdmin, requirePermission("promotions.archive"), async (request, response) => {
  const promotionId = id(request);
  const result = await getDatabasePool().query("UPDATE promotion_campaigns SET archived_at=now(),active=false,updated_at=now() WHERE id=$1 AND archived_at IS NULL", [promotionId]);
  if (!result.rowCount) throw new AppError(404, "PROMOTION_NOT_FOUND", "The promotion was not found.");
  await audit(request, "promotion.archived", promotionId);
  response.json({ data: { id: promotionId } });
});