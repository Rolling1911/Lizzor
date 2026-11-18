import { Router } from "express";
import { z } from "zod";
import { getSeoPage } from "../seo.js";
import { AppError } from "../middleware/error-handler.js";

export const seoRouter = Router();

seoRouter.get("/seo/metadata", async (request, response) => {
  const parsed = z.object({ path: z.string().min(1).max(2000) }).safeParse(request.query);
  if (!parsed.success || !parsed.data.path.startsWith("/")) throw new AppError(400, "INVALID_SEO_PATH", "A local path is required.");
  const page = await getSeoPage(request, parsed.data.path);
  response.json({ data: page });
});