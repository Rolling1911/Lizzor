import { Router } from "express";
import { z } from "zod";
import { requireAuth, requireCsrf } from "../middleware/auth.js";
import { AppError } from "../middleware/error-handler.js";
import { addWishlistItem, listWishlist, removeWishlistItem } from "../wishlist/service.js";

const uuid = z.string().uuid();
const itemSchema = z.object({ productId: uuid });
const listSchema = z.object({ page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(48).default(24) });
function parsed<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new AppError(400, "VALIDATION_ERROR", "The request could not be validated.", result.error.flatten());
  return result.data;
}

export const wishlistRouter = Router();

wishlistRouter.get("/wishlist", requireAuth, async (request, response) => {
  const query = parsed(listSchema, request.query);
  response.json({ data: await listWishlist(request.auth!.userId, query.page, query.pageSize) });
});

wishlistRouter.post("/wishlist/items", requireCsrf, requireAuth, async (request, response) => {
  const input = parsed(itemSchema, request.body);
  await addWishlistItem(request.auth!.userId, input.productId);
  response.status(201).json({ data: { productId: input.productId, saved: true } });
});

wishlistRouter.delete("/wishlist/items/:productId", requireCsrf, requireAuth, async (request, response) => {
  const productId = parsed(uuid, request.params.productId);
  await removeWishlistItem(request.auth!.userId, productId);
  response.json({ data: { productId, saved: false } });
});