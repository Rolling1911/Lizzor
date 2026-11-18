import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { getCookie, GUEST_CART_COOKIE, setGuestCartCookie } from "../auth/cookies.js";
import { requireAdmin, requireAuth, requireCsrf, requirePermission } from "../middleware/auth.js";
import { AppError } from "../middleware/error-handler.js";
import { addItem, applyCoupon, clearCart, getCart, getOrCreateGuestSession, removeCoupon, removeItem, updateItem, type CartOwner } from "../cart/service.js";
import { buyAgain, cancelOrder, createOrder, getAdminOrder, getGuestEmailOrder, getOrder, listAdminOrders, listCustomerOrders, releaseExpiredReservations, validateCheckout } from "../orders/service.js";
import { auditSecurityEvent } from "../auth/service.js";
import { getDatabasePool } from "../db/client.js";
import { getPricing } from "../pricing/service.js";
import { expirePaymentReservations } from "../payments/service.js";
import { guestBearerLimiter } from "../middleware/security.js";
import { getEuropeanCountry } from "../../shared/europeanCountries.js";
import { logger } from "../lib/logger.js";

const uuid = z.string().uuid();
const optionalText = (max: number) => z.preprocess(
  (value) => typeof value === "string" && !value.trim() ? null : value,
  z.string().trim().max(max).nullable().optional(),
);
const optionalPhone = z.preprocess(
  (value) => typeof value === "string" && !value.trim() ? null : value,
  z.string().trim().regex(/^\+[1-9]\d{6,14}$/, "Use a valid international phone number.").nullable().optional(),
);
const addressSchema = z.object({
  firstName: z.string().trim().min(1).max(100),
  lastName: z.string().trim().min(1).max(100),
  companyName: optionalText(200),
  addressLine1: z.string().trim().min(1).max(200),
  addressLine2: optionalText(200),
  city: z.string().trim().min(1).max(100),
  postalCode: z.string().trim().min(1).max(30),
  region: optionalText(100),
  countryCode: z.string().trim().length(2).transform((value) => value.toUpperCase()).refine(getEuropeanCountry, "Choose a supported country."),
  phone: optionalPhone,
});
const itemSchema = z.object({ productId: uuid, variantId: uuid.nullable().optional(), quantity: z.number().int().min(1).max(1_000_000) });
const quantitySchema = z.object({ quantity: z.number().int().min(1).max(1_000_000) });
const checkoutSchema = z.object({
  email: z.string().trim().email().max(320),
  phone: optionalPhone,
  billingAddress: addressSchema,
  shippingAddress: addressSchema,
  idempotencyKey: z.string().trim().min(8).max(160),
  expectedGrandTotal: z.number().finite().min(0).optional(),
  purchaseScope: z.enum(["b2c", "b2b"]).default("b2c"),
  legalAcceptance: z.array(z.string().uuid()).max(2).optional(),
});
const validateSchema = z.object({ shippingAddress: addressSchema, expectedGrandTotal: z.number().finite().min(0).optional() });
const couponSchema = z.object({ code: z.string().trim().min(1).max(80) });

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new AppError(400, "VALIDATION_ERROR", "The request could not be validated.", result.error.flatten());
  return result.data;
}

function parseCheckout<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  logger.warn("checkout request validation failed", {
    issues: result.error.issues.map((issue) => ({ path: issue.path.join("."), code: issue.code, message: issue.message })),
  });
  const issue = result.error.issues[0];
  const field = String(issue?.path.at(-1) ?? "details");
  const labels: Record<string, string> = {
    email: "email address", phone: "contact phone", firstName: "first name", lastName: "last name",
    companyName: "company name", addressLine1: "address line", addressLine2: "apartment or suite",
    city: "city", postalCode: "postal code", region: "region", countryCode: "country", idempotencyKey: "checkout session",
  };
  throw new AppError(400, "VALIDATION_ERROR", `Check the ${labels[field] ?? "checkout details"}. ${issue?.message ?? "The value is invalid."}`);
}

async function owner(request: Request, response: Response): Promise<CartOwner> {
  const guestSessionId = getCookie(request, GUEST_CART_COOKIE);
  if (request.auth) return { userId: request.auth.userId, guestSessionId };
  if (guestSessionId) return { guestSessionId };
  const token = await getOrCreateGuestSession();
  setGuestCartCookie(response, token);
  return { guestSessionId: token };
}

function id(value: string | string[]): string {
  const parsed = uuid.safeParse(value);
  if (!parsed.success) throw new AppError(400, "INVALID_ID", "A valid identifier is required.");
  return parsed.data;
}

export const commerceRouter = Router();

commerceRouter.get("/shop/products", async (_request, response) => {
  const rows = (await getDatabasePool().query(
    `SELECT p.id AS "productId", p.name AS "productName", p.parent_sku AS "parentSku", p.minimum_order_quantity AS "productMinimumOrderQuantity", pv.id AS "variantId", pv.title AS "variantTitle", pv.sku AS "variantSku", pv.minimum_order_quantity AS "variantMinimumOrderQuantity"
       FROM products p
       JOIN categories c ON c.id=p.category_id
       LEFT JOIN product_variants pv ON pv.product_id=p.id AND pv.active=true
       WHERE p.status='active' AND p.published_at IS NOT NULL
         AND c.active=true AND (c.parent_id IS NULL OR EXISTS (SELECT 1 FROM categories parent WHERE parent.id=c.parent_id AND parent.active=true))
      ORDER BY p.name,pv.title NULLS FIRST LIMIT 100`,
  )).rows;
  const items = await Promise.all(rows.map(async (row) => {
    const price = await getPricing(row.productId, row.variantId, 1);
    const stock = await getDatabasePool().query(
      `SELECT COALESCE(sum(quantity_on_hand-quantity_reserved),0)::text AS available FROM inventory WHERE active=true AND ${row.variantId ? "variant_id=$1" : "variant_id IS NULL AND product_id=$1"}`,
      [row.variantId ?? row.productId],
    );
    return { productId: row.productId, variantId: row.variantId, productName: row.productName, variantTitle: row.variantTitle, sku: row.variantSku ?? row.parentSku, unitPrice: price.unitPrice, currency: "EUR", available: Number(stock.rows[0]?.available ?? 0), minimumOrderQuantity: Math.max(1, Number(row.variantMinimumOrderQuantity ?? row.productMinimumOrderQuantity)) };
  }));
  response.json({ data: { items } });
});

commerceRouter.get("/cart", async (request, response) => {
  response.json({ data: await getCart(await owner(request, response)) });
});

commerceRouter.post("/cart/items", requireCsrf, async (request, response) => {
  response.status(201).json({ data: await addItem(await owner(request, response), parse(itemSchema, request.body)) });
});

commerceRouter.patch("/cart/items/:id", requireCsrf, async (request, response) => {
  response.json({ data: await updateItem(await owner(request, response), id(request.params.id), parse(quantitySchema, request.body).quantity) });
});

commerceRouter.delete("/cart/items/:id", requireCsrf, async (request, response) => {
  response.json({ data: await removeItem(await owner(request, response), id(request.params.id)) });
});

commerceRouter.delete("/cart", requireCsrf, async (request, response) => {
  response.json({ data: await clearCart(await owner(request, response)) });
});

commerceRouter.post("/cart/coupon", requireCsrf, async (request, response) => {
  response.json({ data: await applyCoupon(await owner(request, response), parse(couponSchema, request.body).code) });
});

commerceRouter.delete("/cart/coupon", requireCsrf, async (request, response) => {
  response.json({ data: await removeCoupon(await owner(request, response)) });
});

commerceRouter.post("/checkout/validate", requireCsrf, async (request, response) => {
  await expirePaymentReservations();
  await releaseExpiredReservations();
  const input = parseCheckout(validateSchema, request.body);
  response.json({ data: await validateCheckout(await owner(request, response), input.shippingAddress, input.expectedGrandTotal) });
});

commerceRouter.post("/checkout/order", requireCsrf, async (request, response) => {
  await expirePaymentReservations();
  await releaseExpiredReservations();
  const input = parseCheckout(checkoutSchema, request.body);
  const result = await createOrder(await owner(request, response), input);
  response.status(result.replayed ? 200 : 201).json({ data: result });
});

commerceRouter.get("/account/orders", requireAuth, async (request, response) => {
  const parsedScope = z.enum(["all", "personal", "placed", "company"]).safeParse(request.query.scope ?? "all");
  if (!parsedScope.success) throw new AppError(400, "INVALID_ORDER_SCOPE", "Order scope must be all, personal, placed, or company.");
  const companyId = typeof request.query.companyId === "string" ? id(request.query.companyId) : undefined;
  response.json({ data: await listCustomerOrders(request.auth!.userId, Number(request.query.page ?? 1), Number(request.query.pageSize ?? 20), parsedScope.data, companyId) });
});

commerceRouter.get("/account/orders/:id", requireAuth, async (request, response) => {
  response.json({ data: await getOrder(id(request.params.id), { userId: request.auth!.userId }) });
});

commerceRouter.post("/account/orders/:id/buy-again", requireCsrf, requireAuth, async (request, response) => {
  const orderId = id(request.params.id);
  const result = await buyAgain(orderId, request.auth!.userId);
  await auditSecurityEvent({ actorUserId: request.auth!.userId, action: "order.buy_again", entityType: "order", entityId: orderId, request });
  response.json({ data: result });
});

commerceRouter.post("/account/orders/:id/cancel", requireCsrf, requireAuth, async (request, response) => {
  response.json({ data: await cancelOrder(id(request.params.id), { userId: request.auth!.userId }) });
});

commerceRouter.get("/guest/orders/:id", guestBearerLimiter, async (request, response) => {
  const guestSessionId = getCookie(request, GUEST_CART_COOKIE);
  const guestAccessToken = request.get("x-order-access-token");
  if (!guestSessionId || !guestAccessToken) throw new AppError(404, "ORDER_NOT_FOUND", "The order was not found.");
  response.json({ data: await getOrder(id(request.params.id), { guestSessionId, guestAccessToken }) });
});

commerceRouter.get("/guest/email-orders/:id", guestBearerLimiter, async (request, response) => {
  const token = request.get("x-guest-order-email-token");
  if (!token) throw new AppError(404, "ORDER_NOT_FOUND", "The order was not found.");
  response.setHeader("Cache-Control", "private, no-store");
  response.json({ data: await getGuestEmailOrder(id(request.params.id), token) });
});

commerceRouter.post("/guest/orders/:id/cancel", guestBearerLimiter, requireCsrf, async (request, response) => {
  const guestSessionId = getCookie(request, GUEST_CART_COOKIE);
  const guestAccessToken = request.get("x-order-access-token");
  if (!guestSessionId || !guestAccessToken) throw new AppError(404, "ORDER_NOT_FOUND", "The order was not found.");
  response.json({ data: await cancelOrder(id(request.params.id), { guestSessionId, guestAccessToken }) });
});

commerceRouter.get("/admin/orders", requireAdmin, requirePermission("orders.view"), async (request, response) => {
  response.json({ data: await listAdminOrders({ search: typeof request.query.search === "string" ? request.query.search : undefined, status: typeof request.query.status === "string" ? request.query.status : undefined, page: Number(request.query.page ?? 1), pageSize: Number(request.query.pageSize ?? 25) }) });
});

commerceRouter.get("/admin/orders/:id", requireAdmin, requirePermission("orders.view"), async (request, response) => {
  const orderId = id(request.params.id);
  const result = await getAdminOrder(orderId);
  await auditSecurityEvent({ actorUserId: request.auth!.userId, action: "admin.order_viewed", entityType: "order", entityId: orderId, request });
  response.json({ data: result });
});