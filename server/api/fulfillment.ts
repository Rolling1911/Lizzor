import { Router, type Request } from "express";
import { randomUUID } from "node:crypto";
import path from "node:path";
import multer from "multer";
import { z } from "zod";
import { auditSecurityEvent } from "../auth/service.js";
import { getCookie, GUEST_CART_COOKIE } from "../auth/cookies.js";
import { requireAdmin, requireAuth, requireCsrf, requirePermission } from "../middleware/auth.js";
import { AppError } from "../middleware/error-handler.js";
import { guestBearerLimiter } from "../middleware/security.js";
import { bulkTransitionFulfillment, createReturn, createShipment, getAdminOrderTracking, getOrderTracking, getReturnAttachment, listCustomerReturns, listFulfillment, listReturns, listShippingRules, listShippingZones, quoteShipping, receiveReturn, saveShippingRule, saveShippingZone, transitionFulfillment, updateReturn, updateShipment } from "../fulfillment/service.js";

const RETURN_ATTACHMENT_MAX_BYTES = 5 * 1024 * 1024;
const RETURN_ATTACHMENT_TOTAL_BYTES = 10 * 1024 * 1024;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: RETURN_ATTACHMENT_MAX_BYTES, files: 3, fields: 10, fieldSize: 16 * 1024 } });
const uuid = z.string().uuid();
const csrfAdmin = [requireCsrf, requireAdmin];
const adminView = (permission: string) => [requireAdmin, requirePermission(permission)];
const adminMutation = (permission: string) => [requireCsrf, requireAdmin, requirePermission(permission)];
function parsed<T>(schema: z.ZodType<T>, value: unknown): T { const result = schema.safeParse(value); if (!result.success) throw new AppError(400, "VALIDATION_ERROR", "The request could not be validated.", result.error.flatten()); return result.data; }
function id(value: string | string[]) { const result = uuid.safeParse(value); if (!result.success) throw new AppError(400, "INVALID_ID", "A valid identifier is required."); return result.data; }
function guestAccess(request: Request) { const guestSessionId = getCookie(request, GUEST_CART_COOKIE); const guestAccessToken = request.get("x-order-access-token"); if (!guestSessionId || !guestAccessToken) throw new AppError(404, "ORDER_NOT_FOUND", "The order was not found."); return { guestSessionId, guestAccessToken }; }
function access(request: Request) { return request.auth ? { userId: request.auth.userId } : guestAccess(request); }
const attachmentTypes = new Map([
  ["application/pdf", "pdf"], ["image/jpeg", "jpg"], ["image/png", "png"], ["image/webp", "webp"],
]);
const safeAttachmentMimeTypes = new Map([
  ["application/pdf", "application/pdf"],
  ["image/jpeg", "image/jpeg"],
  ["image/png", "image/png"],
  ["image/webp", "image/webp"],
]);
function hasExpectedMagic(file: Express.Multer.File): boolean {
  const bytes = file.buffer;
  if (file.mimetype === "application/pdf") return bytes.subarray(0, 5).toString("ascii") === "%PDF-";
  if (file.mimetype === "image/jpeg") return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (file.mimetype === "image/png") return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  return bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP";
}
function safeAttachments(files: Express.Multer.File[]) {
  const total = files.reduce((sum, file) => sum + file.size, 0);
  if (total > RETURN_ATTACHMENT_TOTAL_BYTES) throw new AppError(400, "RETURN_ATTACHMENTS_TOO_LARGE", "Return attachments may not exceed 10 MB in total.");
  return files.map((file) => {
    const extension = attachmentTypes.get(file.mimetype);
    if (!extension || path.extname(file.originalname).toLowerCase() !== `.${extension}` || !hasExpectedMagic(file)) throw new AppError(400, "INVALID_ATTACHMENT_TYPE", "Return attachments must be valid PDF, JPEG, PNG, or WebP files.");
    return { filename: `${randomUUID()}.${extension}`, mimeType: file.mimetype, sizeBytes: file.size, data: file.buffer };
  });
}

const fulfillmentSchema = z.object({ stage: z.enum(["unfulfilled", "processing", "packed", "shipped", "delivered", "cancelled"]) });
const shipmentSchema = z.object({ courier: z.string().trim().min(1).max(100), trackingNumber: z.string().trim().max(150).optional(), trackingUrl: z.string().trim().url().max(1000).optional() });
const shipmentUpdateSchema = shipmentSchema.partial().extend({ status: z.enum(["pending", "shipped", "in_transit", "delivered", "returned", "cancelled"]) });
const quoteSchema = z.object({ countryCode: z.string().trim().length(2), orderValue: z.number().finite().min(0), weight: z.number().finite().min(0) });
const zoneSchema = z.object({ name: z.string().trim().min(1).max(150), active: z.boolean(), countries: z.array(z.string().trim().length(2)).max(300) });
const ruleSchema = z.object({ zoneId: uuid, minimumOrderValue: z.number().finite().min(0).nullable().optional(), maximumOrderValue: z.number().finite().min(0).nullable().optional(), minimumWeight: z.number().finite().min(0).nullable().optional(), maximumWeight: z.number().finite().min(0).nullable().optional(), shippingPrice: z.number().finite().min(0), freeShipping: z.boolean(), active: z.boolean(), priority: z.number().int().min(0).max(1_000_000) });
const returnSchema = z.object({ reason: z.string().trim().min(1).max(150), description: z.string().trim().max(5000).optional(), items: z.array(z.object({ orderItemId: uuid, quantity: z.number().int().positive().max(1_000_000) })).min(1).max(100) });

export const fulfillmentRouter = Router();

fulfillmentRouter.post("/shipping/quote", async (request, response) => response.json({ data: await quoteShipping(parsed(quoteSchema, request.body)) }));
fulfillmentRouter.get("/account/orders/:id/tracking", requireAuth, async (request, response) => response.json({ data: await getOrderTracking(id(request.params.id), { userId: request.auth!.userId }) }));
fulfillmentRouter.get("/guest/orders/:id/tracking", guestBearerLimiter, async (request, response) => response.json({ data: await getOrderTracking(id(request.params.id), guestAccess(request)) }));
fulfillmentRouter.get("/account/orders/:id/returns", requireAuth, async (request, response) => response.json({ data: await listCustomerReturns(id(request.params.id), { userId: request.auth!.userId }) }));
fulfillmentRouter.post("/account/orders/:id/returns", requireCsrf, requireAuth, upload.array("attachments", 3), async (request, response) => {
  const input = parsed(returnSchema, { ...request.body, items: typeof request.body.items === "string" ? JSON.parse(request.body.items) : request.body.items });
  const files = (request.files as Express.Multer.File[] | undefined) ?? [];
  const result = await createReturn(id(request.params.id), { userId: request.auth!.userId }, { ...input, attachments: safeAttachments(files) });
  response.status(201).json({ data: result });
});
fulfillmentRouter.get("/guest/orders/:id/returns", guestBearerLimiter, async (request, response) => response.json({ data: await listCustomerReturns(id(request.params.id), guestAccess(request)) }));
fulfillmentRouter.post("/guest/orders/:id/returns", guestBearerLimiter, requireCsrf, upload.array("attachments", 3), async (request, response) => {
  const input = parsed(returnSchema, { ...request.body, items: typeof request.body.items === "string" ? JSON.parse(request.body.items) : request.body.items });
  const files = (request.files as Express.Multer.File[] | undefined) ?? [];
  const result = await createReturn(id(request.params.id), guestAccess(request), { ...input, attachments: safeAttachments(files) });
  response.status(201).json({ data: result });
});

fulfillmentRouter.get("/admin/fulfillment", ...adminView("fulfillment.view"), async (request, response) => response.json({ data: await listFulfillment({ stage: typeof request.query.stage === "string" ? request.query.stage : undefined, search: typeof request.query.search === "string" ? request.query.search : undefined, page: request.query.page, pageSize: request.query.pageSize }) }));
fulfillmentRouter.get("/admin/orders/:id/tracking", ...adminView("fulfillment.view"), async (request, response) => response.json({ data: await getAdminOrderTracking(id(request.params.id)) }));
fulfillmentRouter.post("/admin/fulfillment/bulk", ...adminMutation("fulfillment.manage"), async (request, response) => {
  const input = parsed(z.object({ orderIds: z.array(uuid).min(1).max(100), stage: fulfillmentSchema.shape.stage }), request.body);
  response.json({ data: await bulkTransitionFulfillment(input.orderIds, input.stage, request.auth!.userId) });
});
fulfillmentRouter.patch("/admin/orders/:id/fulfillment", ...adminMutation("fulfillment.manage"), async (request, response) => {
  const orderId = id(request.params.id); const input = parsed(fulfillmentSchema, request.body); const result = await transitionFulfillment(orderId, input.stage, request.auth!.userId);
  await auditSecurityEvent({ actorUserId: request.auth!.userId, action: "admin.fulfillment_changed", entityType: "order", entityId: orderId, request }); response.json({ data: result });
});
fulfillmentRouter.post("/admin/orders/:id/shipments", ...adminMutation("fulfillment.manage"), async (request, response) => {
  const orderId = id(request.params.id); const result = await createShipment(orderId, parsed(shipmentSchema, request.body), request.auth!.userId);
  response.status(201).json({ data: result });
});
fulfillmentRouter.patch("/admin/shipments/:id", ...adminMutation("fulfillment.manage"), async (request, response) => response.json({ data: await updateShipment(id(request.params.id), parsed(shipmentUpdateSchema, request.body), request.auth!.userId) }));

fulfillmentRouter.get("/admin/shipping/zones", ...adminView("shipping.view"), async (_request, response) => response.json({ data: await listShippingZones() }));
fulfillmentRouter.post("/admin/shipping/zones", ...adminMutation("shipping.manage"), async (request, response) => response.status(201).json({ data: { id: await saveShippingZone(parsed(zoneSchema, request.body)) } }));
fulfillmentRouter.patch("/admin/shipping/zones/:id", ...adminMutation("shipping.manage"), async (request, response) => response.json({ data: { id: await saveShippingZone(parsed(zoneSchema, request.body), id(request.params.id)) } }));
fulfillmentRouter.get("/admin/shipping/rules", ...adminView("shipping.view"), async (_request, response) => response.json({ data: await listShippingRules() }));
fulfillmentRouter.post("/admin/shipping/rules", ...adminMutation("shipping.manage"), async (request, response) => response.status(201).json({ data: { id: await saveShippingRule(parsed(ruleSchema, request.body)) } }));
fulfillmentRouter.patch("/admin/shipping/rules/:id", ...adminMutation("shipping.manage"), async (request, response) => response.json({ data: { id: await saveShippingRule(parsed(ruleSchema, request.body), id(request.params.id)) } }));

fulfillmentRouter.get("/admin/returns", ...adminView("returns.view"), async (request, response) => response.json({ data: await listReturns({ status: typeof request.query.status === "string" ? request.query.status : undefined, search: typeof request.query.search === "string" ? request.query.search : undefined, page: request.query.page, pageSize: request.query.pageSize }) }));
fulfillmentRouter.get("/admin/returns/:id/attachments/:attachmentId", ...adminView("returns.view"), async (request, response) => {
  const attachment = await getReturnAttachment(id(request.params.id), id(request.params.attachmentId));
  response.set("content-type", safeAttachmentMimeTypes.get(attachment.mimeType) ?? "application/octet-stream");
  response.set("content-length", String(attachment.sizeBytes));
  response.set("content-disposition", `attachment; filename="${attachment.filename.replace(/[^a-zA-Z0-9._-]/g, "_")}"`);
  response.set("cache-control", "private, no-store");
  response.send(attachment.data);
});
fulfillmentRouter.patch("/admin/returns/:id", ...adminMutation("returns.manage"), async (request, response) => {
  const input = parsed(z.object({ status: z.enum(["open", "in_review", "approved", "rejected", "completed", "cancelled"]), adminNotes: z.string().trim().max(5000).optional() }), request.body);
  response.json({ data: await updateReturn(id(request.params.id), input.status, input.adminNotes, request.auth!.userId) });
});
fulfillmentRouter.post("/admin/returns/:id/receive", ...adminMutation("returns.manage"), async (request, response) => {
  const input = parsed(z.object({ warehouseId: uuid }), request.body);
  response.json({ data: await receiveReturn(id(request.params.id), input.warehouseId, request.auth!.userId) });
});