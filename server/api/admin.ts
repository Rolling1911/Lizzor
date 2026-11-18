import { Router } from "express";
import { z } from "zod";
import { getDatabasePool } from "../db/client.js";
import { requireAdmin } from "../middleware/auth.js";
import { requirePermission } from "../middleware/auth.js";
import { AppError } from "../middleware/error-handler.js";
import { canUser } from "../auth/service.js";

const dateRangeSchema = z.object({
  range: z.enum(["today", "yesterday", "7d", "30d", "month", "previousMonth", "year", "custom"]).default("30d"),
  start: z.string().datetime().optional(),
  end: z.string().datetime().optional(),
});

type CountRow = { count: string };
type OrderRow = { orders: string; revenue: string };
type UnitsRow = { units: string };
type AverageRow = { average: string | null };
type TrendRow = { day: string; orders: string; revenue: string };
type ActivityRow = { action: string; entityType: string; createdAt: string };
type InventorySummaryRow = { lowStock: string; outOfStock: string; available: string };

function resolveDateRange(input: z.infer<typeof dateRangeSchema>): { start: Date; end: Date } {
  const now = new Date();
  const end = new Date(now);
  const start = new Date(now);

  if (input.range === "custom") {
    if (!input.start || !input.end) throw new AppError(400, "DATE_RANGE_REQUIRED", "A custom range needs both a start and end date.");
    const customStart = new Date(input.start);
    const customEnd = new Date(input.end);
    if (customStart >= customEnd) throw new AppError(400, "INVALID_DATE_RANGE", "The start date must be before the end date.");
    return { start: customStart, end: customEnd };
  }

  if (input.range === "today") start.setUTCHours(0, 0, 0, 0);
  if (input.range === "yesterday") {
    end.setUTCHours(0, 0, 0, 0);
    start.setTime(end.getTime() - 24 * 60 * 60 * 1000);
  }
  if (input.range === "7d") start.setUTCDate(start.getUTCDate() - 7);
  if (input.range === "30d") start.setUTCDate(start.getUTCDate() - 30);
  if (input.range === "month") {
    start.setUTCDate(1);
    start.setUTCHours(0, 0, 0, 0);
  }
  if (input.range === "previousMonth") {
    end.setUTCDate(1);
    end.setUTCHours(0, 0, 0, 0);
    start.setUTCMonth(end.getUTCMonth() - 1, 1);
    start.setUTCHours(0, 0, 0, 0);
  }
  if (input.range === "year") {
    start.setUTCMonth(0, 1);
    start.setUTCHours(0, 0, 0, 0);
  }
  return { start, end };
}

function numberValue(value: string | null | undefined): number {
  return Number(value ?? 0);
}

export const adminRouter = Router();

adminRouter.get("/admin/dashboard", requireAdmin, requirePermission("dashboard.view"), async (req, res) => {
  const parsed = dateRangeSchema.safeParse(req.query);
  if (!parsed.success) throw new AppError(400, "INVALID_DATE_RANGE", "The dashboard date range is invalid.");
  const { start, end } = resolveDateRange(parsed.data);
  const pool = getDatabasePool();
  const values = [start, end];

  const [ordersResult, unitsResult, customersResult, companiesResult, returnsResult, inventoryResult, trendResult, excludedCurrencyResult] = await Promise.all([
    pool.query<OrderRow>(
      `SELECT count(*)::text AS orders,
              COALESCE(sum(grand_total), 0)::text AS revenue
         FROM orders
        WHERE created_at >= $1 AND created_at < $2 AND status <> 'cancelled' AND currency = 'EUR'`,
      values,
    ),
    pool.query<UnitsRow>(
      `SELECT COALESCE(sum(oi.quantity), 0)::text AS units
         FROM order_items oi
         JOIN orders o ON o.id = oi.order_id
        WHERE o.created_at >= $1 AND o.created_at < $2 AND o.status <> 'cancelled' AND o.currency = 'EUR'`,
      values,
    ),
    pool.query<CountRow>(
      `SELECT count(*)::text AS count
         FROM users u
        WHERE u.created_at >= $1 AND u.created_at < $2
          AND NOT EXISTS (SELECT 1 FROM admin_user_roles aur WHERE aur.user_id = u.id)`,
      values,
    ),
    pool.query<CountRow>(
      `SELECT count(*)::text AS count FROM companies WHERE created_at >= $1 AND created_at < $2`,
      values,
    ),
    pool.query<CountRow>(
      `SELECT count(*)::text AS count FROM return_requests WHERE created_at >= $1 AND created_at < $2`,
      values,
    ),
    pool.query<InventorySummaryRow>(
      `SELECT count(*) FILTER (WHERE quantity_on_hand - quantity_reserved > 0 AND quantity_on_hand - quantity_reserved <= low_stock_threshold)::text AS "lowStock",
              count(*) FILTER (WHERE quantity_on_hand - quantity_reserved <= 0)::text AS "outOfStock",
              COALESCE(sum(quantity_on_hand - quantity_reserved) FILTER (WHERE active=true), 0)::text AS available
         FROM inventory`,
      [],
    ),
    pool.query<TrendRow>(
      `SELECT date_trunc('day', o.created_at)::date::text AS day,
              count(*)::text AS orders,
              COALESCE(sum(o.grand_total), 0)::text AS revenue
         FROM orders o
        WHERE o.created_at >= $1 AND o.created_at < $2 AND o.status <> 'cancelled' AND o.currency = 'EUR'
        GROUP BY 1 ORDER BY 1`,
      values,
    ),
    pool.query<CountRow>(
      `SELECT count(*)::text AS count
         FROM orders
        WHERE created_at >= $1 AND created_at < $2 AND status <> 'cancelled' AND currency <> 'EUR'`,
      values,
    ),
  ]);
  const activityResult = await canUser(req.auth!.userId, "activity.view")
    ? await pool.query<ActivityRow>(
        `SELECT action, entity_type AS "entityType", created_at::text AS "createdAt"
           FROM audit_logs
          ORDER BY created_at DESC LIMIT 8`,
        [],
      )
    : { rows: [] as ActivityRow[] };

  const orderRow = ordersResult.rows[0] ?? { orders: "0", revenue: "0" };
  const orders = numberValue(orderRow.orders);
  const revenue = numberValue(orderRow.revenue);
  const trend = trendResult.rows.map((point) => ({
    day: point.day,
    orders: numberValue(point.orders),
    revenue: numberValue(point.revenue),
  }));

  res.json({
    data: {
      range: { key: parsed.data.range, start: start.toISOString(), end: end.toISOString() },
      metrics: {
        revenue: { value: revenue, currency: "EUR" },
        orders,
        unitsSold: numberValue(unitsResult.rows[0]?.units),
        customers: numberValue(customersResult.rows[0]?.count),
        companies: numberValue(companiesResult.rows[0]?.count),
        averageOrderValue: orders ? revenue / orders : 0,
        excludedCurrencyOrders: numberValue(excludedCurrencyResult.rows[0]?.count),
        returns: numberValue(returnsResult.rows[0]?.count),
        lowStock: numberValue(inventoryResult.rows[0]?.lowStock),
        outOfStock: numberValue(inventoryResult.rows[0]?.outOfStock),
        availableStock: numberValue(inventoryResult.rows[0]?.available),
      },
      profitability: {
        status: "incomplete",
        message: "Profitability is incomplete until all configured cost sources are available.",
        estimatedProfit: null,
        unavailableSources: ["shipping costs", "payment processing costs", "other configured costs"],
      },
      sections: {
        revenueTrend: trend,
        salesByCountry: [],
        salesByCategory: [],
        topProducts: [],
        recentOrders: [],
        lowStockProducts: [],
        recentCustomers: [],
        returnsAndRefunds: [],
        recentAdminActivity: activityResult.rows,
      },
    },
  });
});