import { Router } from "express";
import { z } from "zod";
import { getAdminAuditLog, listAdminAuditLogs } from "../audit/service.js";
import { requireAdmin, requirePermission } from "../middleware/auth.js";
import { AppError } from "../middleware/error-handler.js";

const uuid = z.string().uuid();
const dateValue = z.string().refine((value) => !Number.isNaN(Date.parse(value)), "A valid date is required.");
const querySchema = z.object({
  search: z.string().trim().max(120).optional(),
  action: z.string().trim().max(120).optional(),
  entityType: z.string().trim().max(100).optional(),
  from: dateValue.optional(),
  to: dateValue.optional(),
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new AppError(400, "VALIDATION_ERROR", "The activity filters could not be validated.", result.error.flatten());
  return result.data;
}

export const auditRouter = Router();

auditRouter.get("/admin/activity", requireAdmin, requirePermission("activity.view"), async (request, response) => {
  response.json({ data: await listAdminAuditLogs(parse(querySchema, request.query)) });
});

auditRouter.get("/admin/activity/:id", requireAdmin, requirePermission("activity.view"), async (request, response) => {
  const idResult = uuid.safeParse(request.params.id);
  if (!idResult.success) throw new AppError(400, "INVALID_ID", "A valid activity identifier is required.");
  const data = await getAdminAuditLog(idResult.data);
  if (!data) throw new AppError(404, "ACTIVITY_NOT_FOUND", "The activity record was not found.");
  response.json({ data });
});