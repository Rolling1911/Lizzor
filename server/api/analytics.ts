import { Router } from "express";
import { z } from "zod";
import { getAnalytics, getAnalyticsCsv, type AnalyticsFilters, type AnalyticsReport, resolveAnalyticsRange } from "../analytics/service.js";
import { requireAdmin, requirePermission } from "../middleware/auth.js";
import { AppError } from "../middleware/error-handler.js";
import { auditSecurityEvent, canUser } from "../auth/service.js";

const reportSchema = z.enum(["overview", "sales", "orders", "products", "customers", "promotions", "inventory", "margin", "fulfillment", "returns"]);
const querySchema = z.object({
  range: z.string().optional(),
  start: z.string().optional(),
  end: z.string().optional(),
  status: z.string().max(40).optional(),
  productId: z.string().uuid().optional(),
  categoryId: z.string().uuid().optional(),
  brandId: z.string().uuid().optional(),
  promotionId: z.string().uuid().optional(),
  companyId: z.string().uuid().optional(),
  page: z.coerce.number().int().min(1).max(10000).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).optional(),
  sort: z.string().max(40).optional(),
  direction: z.enum(["asc", "desc"]).optional(),
}).strict();

const permissionByReport: Record<AnalyticsReport, string> = {
  overview: "analytics.view",
  sales: "analytics.sales",
  orders: "analytics.sales",
  products: "analytics.sales",
  customers: "analytics.customers",
  promotions: "analytics.promotions",
  inventory: "analytics.inventory",
  margin: "analytics.margin",
  fulfillment: "analytics.view",
  returns: "analytics.view",
};

function requestedReport(value: unknown): AnalyticsReport {
  const parsed = reportSchema.safeParse(value ?? "overview");
  if (!parsed.success) throw new AppError(400, "INVALID_ANALYTICS_REPORT", "The analytics report is not supported.");
  return parsed.data;
}

function filtersFromQuery(query: Record<string, unknown>): AnalyticsFilters {
  const parsed = querySchema.safeParse(query);
  if (!parsed.success) throw new AppError(400, "INVALID_ANALYTICS_FILTER", "One or more analytics filters are invalid.");
  return parsed.data;
}

function assertSupportedFilters(report: AnalyticsReport, filters: AnalyticsFilters) {
  const common = new Set(["range", "start", "end"]);
  const supported: Record<AnalyticsReport, string[]> = {
    overview: ["status", "companyId"], sales: ["status", "companyId"], orders: ["status", "companyId", "page", "pageSize"],
    products: ["status", "companyId", "productId", "categoryId", "brandId"], customers: ["status", "companyId"],
    promotions: ["promotionId"], inventory: [], margin: ["status", "companyId"], fulfillment: ["status", "companyId"], returns: ["status"],
  };
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined && !common.has(key) && !supported[report].includes(key)) throw new AppError(400, "UNSUPPORTED_ANALYTICS_FILTER", `${key} is not supported for the ${report} report.`);
  }
  if (filters.sort || filters.direction) throw new AppError(400, "UNSUPPORTED_ANALYTICS_FILTER", "Custom sorting is not supported for this report.");
}

export const analyticsRouter = Router();
analyticsRouter.use("/admin/analytics", requireAdmin);
analyticsRouter.use("/admin/reports", requireAdmin);

async function assertReportPermission(report: AnalyticsReport, userId: string) {
  if (!(await canUser(userId, permissionByReport[report]))) throw new AppError(403, "PERMISSION_REQUIRED", "You do not have permission to view this report.");
}

async function readReport(req: any, res: any) {
  const report = requestedReport(req.params.report);
  const filters = filtersFromQuery(req.query);
  assertSupportedFilters(report, filters);
  resolveAnalyticsRange(filters);
  await assertReportPermission(report, req.auth.userId);
  res.json({ data: await getAnalytics(report, filters) });
}

analyticsRouter.get("/admin/analytics", requirePermission("analytics.view"), async (req, res) => {
  const filters = filtersFromQuery(req.query);
  assertSupportedFilters("overview", filters);
  resolveAnalyticsRange(filters);
  res.json({ data: await getAnalytics("overview", filters) });
});
analyticsRouter.get("/admin/analytics/:report", readReport);
analyticsRouter.get("/admin/reports/export", requirePermission("reports.export"), async (req, res) => {
  const report = requestedReport(req.query.report);
  const { report: _report, ...filterQuery } = req.query;
  const filters = filtersFromQuery(filterQuery);
  assertSupportedFilters(report, filters);
  resolveAnalyticsRange(filters);
  await assertReportPermission(report, req.auth!.userId);
  await auditSecurityEvent({ actorUserId: req.auth!.userId, action: `analytics.${report}.exported`, entityType: "analytics_report", request: req });
  const csv = await getAnalyticsCsv(report, filters);
  res.setHeader("content-type", "text/csv; charset=utf-8");
  res.setHeader("content-disposition", `attachment; filename="lizzor-${report}-report.csv"`);
  res.send(csv);
});
analyticsRouter.get("/admin/reports", requirePermission("reports.view"), async (req, res) => {
  const report = requestedReport(req.query.report);
  const { report: _report, ...filterQuery } = req.query;
  const filters = filtersFromQuery(filterQuery);
  assertSupportedFilters(report, filters);
  resolveAnalyticsRange(filters);
  await assertReportPermission(report, req.auth!.userId);
  res.json({ data: await getAnalytics(report, filters) });
});
analyticsRouter.get("/admin/reports/:report", requirePermission("reports.view"), readReport);