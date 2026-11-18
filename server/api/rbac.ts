import { Router } from "express";
import { z } from "zod";
import {
  createAdminRole,
  createAdminStaff,
  getAdminRole,
  getAdminStaff,
  listAdminPermissions,
  listAdminRoles,
  listStaffAssignableRoles,
  listAdminStaff,
  setAdminRolePermissions,
  setAdminStaffRoles,
  updateAdminRole,
  updateAdminStaffStatus,
} from "../auth/admin-service.js";
import { requireAdmin, requireCsrf, requirePermission, requireSuperAdmin } from "../middleware/auth.js";
import { AppError } from "../middleware/error-handler.js";
import { validateBody } from "../middleware/validate.js";

const uuid = z.string().uuid();
const email = z.string().trim().email().max(320).transform((value) => value.toLowerCase());
const id = (value: string | string[]) => {
  const result = uuid.safeParse(value);
  if (!result.success) throw new AppError(400, "INVALID_ID", "A valid identifier is required.");
  return result.data;
};
const pageQuery = z.object({
  search: z.string().trim().max(120).optional(),
  status: z.enum(["pending", "active", "suspended", "deactivated"]).optional(),
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
const uniqueRoleIds = (minimum: number) => z.array(uuid).min(minimum).max(20).refine((values) => new Set(values).size === values.length, "Duplicate role identifiers are not allowed.");
const initialRoleIds = uniqueRoleIds(1);
const replacementRoleIds = uniqueRoleIds(0);

export const rbacRouter = Router();

rbacRouter.get("/admin/staff", requireAdmin, requirePermission("staff.view"), async (request, response) => {
  const parsed = pageQuery.safeParse(request.query);
  if (!parsed.success) throw new AppError(400, "VALIDATION_ERROR", "The staff filters could not be validated.", parsed.error.flatten());
  response.json({ data: await listAdminStaff(parsed.data) });
});

rbacRouter.get("/admin/staff-role-options", requireAdmin, requirePermission("staff.manage"), requireSuperAdmin, async (_request, response) => {
  response.json({ data: await listStaffAssignableRoles() });
});

rbacRouter.get("/admin/staff/:id", requireAdmin, requirePermission("staff.view"), async (request, response) => {
  response.json({ data: await getAdminStaff(id(request.params.id)) });
});

rbacRouter.post("/admin/staff", requireCsrf, requireAdmin, requirePermission("staff.manage"), requireSuperAdmin, validateBody(z.object({
  email,
  firstName: z.string().trim().min(1).max(100),
  lastName: z.string().trim().min(1).max(100),
  phone: z.string().trim().min(3).max(50).nullable().optional(),
  roleIds: initialRoleIds,
})), async (request, response) => {
  response.status(201).json({ data: await createAdminStaff(request.body, request.auth!.userId) });
});

rbacRouter.patch("/admin/staff/:id/status", requireCsrf, requireAdmin, requirePermission("staff.manage"), requireSuperAdmin, validateBody(z.object({
  status: z.enum(["active", "suspended", "deactivated"]),
})), async (request, response) => {
  response.json({ data: await updateAdminStaffStatus(id(request.params.id), request.body.status, request.auth!.userId) });
});

rbacRouter.put("/admin/staff/:id/roles", requireCsrf, requireAdmin, requirePermission("staff.manage"), requireSuperAdmin, validateBody(z.object({ roleIds: replacementRoleIds })), async (request, response) => {
  response.json({ data: await setAdminStaffRoles(id(request.params.id), request.body.roleIds, request.auth!.userId) });
});

rbacRouter.get("/admin/roles", requireAdmin, requirePermission("roles.view"), async (_request, response) => {
  response.json({ data: await listAdminRoles() });
});

rbacRouter.get("/admin/roles/:id", requireAdmin, requirePermission("roles.view"), async (request, response) => {
  response.json({ data: await getAdminRole(id(request.params.id)) });
});

rbacRouter.get("/admin/permissions", requireAdmin, requirePermission("roles.view"), async (_request, response) => {
  response.json({ data: await listAdminPermissions() });
});

rbacRouter.post("/admin/roles", requireCsrf, requireAdmin, requirePermission("roles.manage"), requireSuperAdmin, validateBody(z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).nullable().optional(),
})), async (request, response) => {
  response.status(201).json({ data: await createAdminRole(request.body, request.auth!.userId) });
});

rbacRouter.patch("/admin/roles/:id", requireCsrf, requireAdmin, requirePermission("roles.manage"), requireSuperAdmin, validateBody(z.object({
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().max(500).nullable().optional(),
  active: z.boolean().optional(),
  staffAssignable: z.boolean().optional(),
})), async (request, response) => {
  response.json({ data: await updateAdminRole(id(request.params.id), request.body, request.auth!.userId) });
});

rbacRouter.put("/admin/roles/:id/permissions", requireCsrf, requireAdmin, requirePermission("roles.manage"), requireSuperAdmin, validateBody(z.object({ permissionIds: z.array(uuid).max(100).refine((values) => new Set(values).size === values.length, "Duplicate permission identifiers are not allowed.") })), async (request, response) => {
  response.json({ data: await setAdminRolePermissions(id(request.params.id), request.body.permissionIds, request.auth!.userId) });
});