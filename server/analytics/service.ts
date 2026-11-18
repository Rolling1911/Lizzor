import type { Pool, PoolClient } from "pg";
import { getDatabasePool } from "../db/client.js";
import { AppError } from "../middleware/error-handler.js";

type QueryClient = Pool | PoolClient;
export type AnalyticsReport = "overview" | "sales" | "orders" | "products" | "customers" | "promotions" | "inventory" | "margin" | "fulfillment" | "returns";
export type AnalyticsFilters = {
  range?: string;
  start?: string;
  end?: string;
  status?: string;
  productId?: string;
  categoryId?: string;
  brandId?: string;
  promotionId?: string;
  companyId?: string;
  page?: number;
  pageSize?: number;
  sort?: string;
  direction?: string;
};

const finalizedPaymentStates = ["paid", "refunded", "partially_refunded"];

function numberValue(value: unknown): number {
  return Number(value ?? 0);
}

function money(value: unknown): number {
  return Number(numberValue(value).toFixed(2));
}

function pageValue(value: unknown, fallback: number, max = 100) {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new AppError(400, "INVALID_PAGINATION", "Pagination values must be positive integers.");
  return Math.min(max, parsed);
}

export function resolveAnalyticsRange(input: AnalyticsFilters): { start: Date; end: Date; key: string; previousStart: Date; previousEnd: Date } {
  const key = input.range ?? "30d";
  const now = new Date();
  const end = new Date(now);
  const start = new Date(now);
  if (key === "custom") {
    if (!input.start || !input.end) throw new AppError(400, "DATE_RANGE_REQUIRED", "A custom range needs both a start and end date.");
    start.setTime(new Date(input.start).getTime());
    end.setTime(new Date(input.end).getTime());
  } else if (key === "today") {
    start.setUTCHours(0, 0, 0, 0);
  } else if (key === "yesterday") {
    end.setUTCHours(0, 0, 0, 0);
    start.setTime(end.getTime() - 86400000);
  } else if (key === "7d") {
    start.setUTCDate(start.getUTCDate() - 7);
  } else if (key === "30d") {
    start.setUTCDate(start.getUTCDate() - 30);
  } else if (key === "month") {
    start.setUTCDate(1);
    start.setUTCHours(0, 0, 0, 0);
  } else if (key === "previousMonth") {
    end.setUTCDate(1);
    end.setUTCHours(0, 0, 0, 0);
    start.setUTCMonth(end.getUTCMonth() - 1, 1);
    start.setUTCHours(0, 0, 0, 0);
  } else if (key === "year") {
    start.setUTCMonth(0, 1);
    start.setUTCHours(0, 0, 0, 0);
  } else {
    throw new AppError(400, "INVALID_DATE_RANGE", "The analytics date range is invalid.");
  }
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || start >= end) {
    throw new AppError(400, "INVALID_DATE_RANGE", "The start date must be before the end date.");
  }
  const duration = end.getTime() - start.getTime();
  if (duration > 366 * 86400000) throw new AppError(400, "DATE_RANGE_TOO_LARGE", "Analytics ranges are limited to 366 days.");
  return { start, end, key, previousStart: new Date(start.getTime() - duration), previousEnd: new Date(start) };
}

function orderClauses(filters: AnalyticsFilters, values: unknown[], alias = "o") {
  const settledAt = `COALESCE((SELECT min(p.paid_at) FROM payments p WHERE p.order_id=${alias}.id AND p.paid_at IS NOT NULL AND p.status = ANY(ARRAY['paid','refunded','partially_refunded']::payment_status[])),${alias}.created_at)`;
  const clauses = [`${settledAt} >= $${values.push(filters.start)} AND ${settledAt} < $${values.push(filters.end)}`, `${alias}.currency = 'EUR'`, `${alias}.status <> 'cancelled'`, `${alias}.payment_status = ANY($${values.push(finalizedPaymentStates)}::payment_status[])`];
  if (filters.status) clauses.push(`${alias}.status = $${values.push(filters.status)}::order_status`);
  if (filters.companyId) clauses.push(`${alias}.company_id = $${values.push(filters.companyId)}`);
  return clauses;
}

function refundOrderScope(filters: AnalyticsFilters, alias = "ro") {
  const clauses = [`${alias}.currency='EUR'`, `${alias}.status <> 'cancelled'`, `${alias}.payment_status = ANY($3::payment_status[])`];
  let position = 4;
  if (filters.status) clauses.push(`${alias}.status = $${position++}::order_status`);
  if (filters.companyId) clauses.push(`${alias}.company_id = $${position}`);
  return clauses.join(" AND ");
}

function withRange(filters: AnalyticsFilters, values: unknown[]) {
  const range = resolveAnalyticsRange(filters);
  filters.start = range.start.toISOString();
  filters.end = range.end.toISOString();
  return range;
}

async function overview(client: QueryClient, filters: AnalyticsFilters) {
  const range = withRange(filters, []);
  const values: unknown[] = [];
  const clauses = orderClauses(filters, values);
  const previousFilters = { ...filters, start: range.previousStart.toISOString(), end: range.previousEnd.toISOString() };
  const previousValues: unknown[] = [];
  const previousClauses = orderClauses(previousFilters, previousValues);
  const previousRefundScope = refundOrderScope(previousFilters);
  const refundScope = refundOrderScope(filters);
  const periodRefunds = `COALESCE((SELECT sum(r.amount) FROM refunds r JOIN orders ro ON ro.id=r.order_id WHERE r.status='completed' AND r.currency='EUR' AND r.updated_at >= $1 AND r.updated_at < $2 AND ${refundScope}),0)`;
  const [totals, previous, trend, statuses, customers, inventory, returns] = await Promise.all([
    client.query(`SELECT count(*)::int AS orders, COALESCE(sum(o.subtotal),0) AS net_sales, COALESCE(sum(o.subtotal + o.discount_total),0) AS gross_sales, COALESCE(sum(o.discount_total),0) AS discounts, COALESCE(sum(o.shipping_total),0) AS shipping, COALESCE(sum(o.tax_total),0) AS vat, COALESCE(sum(o.grand_total),0) - ${periodRefunds} AS collected, ${periodRefunds} AS refunds, COALESCE(sum(oi.units),0)::int AS units FROM orders o LEFT JOIN (SELECT order_id, sum(quantity) AS units FROM order_items GROUP BY order_id) oi ON oi.order_id=o.id WHERE ${clauses.join(" AND ")}`, values),
    client.query(`SELECT count(*)::int AS orders, COALESCE(sum(o.subtotal + o.discount_total),0) AS gross_sales, COALESCE(sum(o.subtotal),0) AS net_sales, COALESCE(sum(o.grand_total),0) - COALESCE((SELECT sum(r.amount) FROM refunds r JOIN orders ro ON ro.id=r.order_id WHERE r.status='completed' AND r.currency='EUR' AND r.updated_at >= $1 AND r.updated_at < $2 AND ${previousRefundScope}),0) AS collected FROM orders o WHERE ${previousClauses.join(" AND ")}`, previousValues),
    client.query(`WITH sale_days AS (SELECT date_trunc('day',COALESCE((SELECT min(p.paid_at) FROM payments p WHERE p.order_id=o.id AND p.paid_at IS NOT NULL AND p.status = ANY(ARRAY['paid','refunded','partially_refunded']::payment_status[])),o.created_at))::date AS day, count(*)::int AS orders, COALESCE(sum(o.subtotal),0) AS net_sales, COALESCE(sum(o.grand_total),0) AS sales_collected FROM orders o WHERE ${clauses.join(" AND ")} GROUP BY 1), refund_days AS (SELECT date_trunc('day',r.updated_at)::date AS day, COALESCE(sum(r.amount),0) AS refunds FROM refunds r JOIN orders ro ON ro.id=r.order_id WHERE r.status='completed' AND r.currency='EUR' AND r.updated_at >= $1 AND r.updated_at < $2 AND ${refundScope} GROUP BY 1) SELECT COALESCE(s.day,r.day)::text AS day, COALESCE(s.orders,0)::int AS orders, COALESCE(s.net_sales,0) AS net_sales, COALESCE(s.sales_collected,0)-COALESCE(r.refunds,0) AS collected FROM sale_days s FULL JOIN refund_days r USING(day) ORDER BY 1`, values),
    client.query(`SELECT o.status, count(*)::int AS count FROM orders o WHERE ${clauses.join(" AND ")} GROUP BY o.status ORDER BY count DESC`, values),
    client.query(`WITH qualified AS (SELECT o.user_id FROM orders o WHERE ${clauses.join(" AND ")}) SELECT
      (SELECT count(DISTINCT u.id) FROM users u WHERE u.created_at >= $1 AND u.created_at < $2 AND NOT EXISTS (SELECT 1 FROM admin_user_roles aur WHERE aur.user_id=u.id))::int AS new_customers,
      count(DISTINCT user_id) FILTER (WHERE user_id IS NOT NULL)::int AS account_customers,
      count(*) FILTER (WHERE user_id IS NULL)::int AS guest_orders,
      (SELECT count(*) FROM (SELECT user_id FROM qualified WHERE user_id IS NOT NULL GROUP BY user_id HAVING count(*) > 1) repeat)::int AS repeat_customers
      FROM qualified`, values),
    client.query(`SELECT count(*) FILTER (WHERE active=true AND quantity_on_hand - quantity_reserved <= 0)::int AS out_of_stock, count(*) FILTER (WHERE active=true AND quantity_on_hand - quantity_reserved > 0 AND quantity_on_hand - quantity_reserved <= low_stock_threshold)::int AS low_stock, COALESCE(sum(quantity_on_hand - quantity_reserved) FILTER (WHERE active=true),0)::int AS available FROM inventory`, []),
    client.query(`SELECT count(DISTINCT r.id)::int AS requests, COALESCE(sum(ri.quantity),0)::int AS items FROM return_requests r LEFT JOIN return_items ri ON ri.return_request_id=r.id WHERE r.created_at >= $1 AND r.created_at < $2`, [filters.start, filters.end]),
  ]);
  const row = totals.rows[0] ?? {};
  const previousRow = previous.rows[0] ?? {};
  const metric = (value: number, prior: number) => ({ value, previous: prior, change: prior ? Number(((value - prior) / prior * 100).toFixed(1)) : null });
  const orderCount = numberValue(row.orders);
  return {
    range: { key: range.key, start: range.start.toISOString(), end: range.end.toISOString(), previousStart: range.previousStart.toISOString(), previousEnd: range.previousEnd.toISOString(), timezone: "UTC", currency: "EUR" },
    definitions: {
      grossSales: "Historical EUR order subtotal plus the recorded discount, excluding cancelled and non-finalized payment orders.",
      netProductSales: "Historical EUR order subtotal after promotion pricing, before shipping and VAT.",
      collected: "Historical EUR grand total; refunds are shown separately where recorded.",
      profitability: "Unavailable unless every required historical cost source is authoritative.",
    },
    metrics: {
      grossSales: metric(money(row.gross_sales), money(previousRow.gross_sales)),
      netProductSales: metric(money(row.net_sales), money(previousRow.net_sales)),
      collected: metric(money(row.collected), money(previousRow.collected)),
      orders: metric(orderCount, numberValue(previousRow.orders)),
      aov: metric(orderCount ? money(numberValue(row.collected) / orderCount) : 0, numberValue(previousRow.orders) ? money(numberValue(previousRow.collected) / numberValue(previousRow.orders)) : 0),
      unitsSold: numberValue(row.units),
      discounts: money(row.discounts),
      shipping: money(row.shipping),
      vat: money(row.vat),
      refunds: money(row.refunds),
      newCustomers: numberValue(customers.rows[0]?.new_customers),
      accountCustomers: numberValue(customers.rows[0]?.account_customers),
      guestOrders: numberValue(customers.rows[0]?.guest_orders),
      repeatCustomers: numberValue(customers.rows[0]?.repeat_customers),
      returns: numberValue(returns.rows[0]?.requests),
      returnedItems: numberValue(returns.rows[0]?.items),
      lowStock: numberValue(inventory.rows[0]?.low_stock),
      outOfStock: numberValue(inventory.rows[0]?.out_of_stock),
      availableStock: numberValue(inventory.rows[0]?.available),
    },
    trend: trend.rows.map((item) => ({ day: item.day, orders: numberValue(item.orders), netSales: money(item.net_sales), collected: money(item.collected) })),
    statuses: statuses.rows.map((item) => ({ status: item.status, count: numberValue(item.count) })),
    profitability: { status: "unavailable", message: "Historical cost, shipping, payment, and operating cost sources are not complete enough for a trustworthy margin figure." },
  };
}

async function sales(client: QueryClient, filters: AnalyticsFilters) {
  withRange(filters, []);
  const values: unknown[] = [];
  const clauses = orderClauses(filters, values);
  const refundScope = refundOrderScope(filters);
  const periodRefunds = `COALESCE((SELECT sum(r.amount) FROM refunds r JOIN orders ro ON ro.id=r.order_id WHERE r.status='completed' AND r.currency='EUR' AND r.updated_at >= $1 AND r.updated_at < $2 AND ${refundScope}),0)`;
  const [summary, trend, countries] = await Promise.all([
    client.query(`SELECT count(*)::int AS orders, COALESCE(sum(subtotal + discount_total),0) AS gross_sales, COALESCE(sum(subtotal),0) AS net_sales, COALESCE(sum(discount_total),0) AS discounts, COALESCE(sum(shipping_total),0) AS shipping, COALESCE(sum(tax_total),0) AS vat, COALESCE(sum(grand_total),0)-${periodRefunds} AS collected, ${periodRefunds} AS refunds FROM orders o WHERE ${clauses.join(" AND ")}`, values),
    client.query(`SELECT date_trunc('day',COALESCE((SELECT min(p.paid_at) FROM payments p WHERE p.order_id=o.id AND p.paid_at IS NOT NULL AND p.status = ANY(ARRAY['paid','refunded','partially_refunded']::payment_status[])),o.created_at))::date::text AS day, count(*)::int AS orders, COALESCE(sum(o.subtotal + o.discount_total),0) AS gross_sales, COALESCE(sum(o.subtotal),0) AS net_sales, COALESCE(sum(o.discount_total),0) AS discounts FROM orders o WHERE ${clauses.join(" AND ")} GROUP BY 1 ORDER BY 1`, values),
    client.query(`WITH sale_country AS (SELECT COALESCE(NULLIF(o.shipping_address_snapshot->>'countryCode',''),'Unknown') AS country, count(*)::int AS orders, COALESCE(sum(o.grand_total),0) AS collected FROM orders o WHERE ${clauses.join(" AND ")} GROUP BY 1), refund_country AS (SELECT COALESCE(NULLIF(ro.shipping_address_snapshot->>'countryCode',''),'Unknown') AS country, COALESCE(sum(r.amount),0) AS refunds FROM refunds r JOIN orders ro ON ro.id=r.order_id WHERE r.status='completed' AND r.currency='EUR' AND r.updated_at >= $1 AND r.updated_at < $2 AND ${refundScope} GROUP BY 1) SELECT COALESCE(s.country,r.country) AS country, COALESCE(s.orders,0)::int AS orders, COALESCE(s.collected,0)-COALESCE(r.refunds,0) AS collected FROM sale_country s FULL JOIN refund_country r USING(country) ORDER BY collected DESC`, values),
  ]);
  const row = summary.rows[0] ?? {};
  return {
    summary: { orders: numberValue(row.orders), grossSales: money(row.gross_sales), netSales: money(row.net_sales), discounts: money(row.discounts), shipping: money(row.shipping), vat: money(row.vat), collected: money(row.collected), refunds: money(row.refunds), aov: row.orders ? money(numberValue(row.collected) / numberValue(row.orders)) : 0 },
    trend: trend.rows.map((item) => ({ day: item.day, orders: numberValue(item.orders), grossSales: money(item.gross_sales), netSales: money(item.net_sales), discounts: money(item.discounts) })),
    countries: countries.rows.map((item) => ({ country: item.country, orders: numberValue(item.orders), collected: money(item.collected) })),
    note: "Sales use historical order totals and snapshots; cancelled and non-finalized payment orders are excluded.",
  };
}

async function orders(client: QueryClient, filters: AnalyticsFilters) {
  withRange(filters, []);
  const values: unknown[] = [];
  const clauses = orderClauses(filters, values);
  const baseValues = [...values];
  const page = pageValue(filters.page, 1);
  const pageSize = pageValue(filters.pageSize, 25);
  const rowValues = [...baseValues, pageSize, (page - 1) * pageSize];
  const [status, payment, fulfillment, rows] = await Promise.all([
    client.query(`SELECT o.status, count(*)::int AS count FROM orders o WHERE ${clauses.join(" AND ")} GROUP BY o.status ORDER BY count DESC`, baseValues),
    client.query(`SELECT o.payment_status AS status, count(*)::int AS count FROM orders o WHERE ${clauses.join(" AND ")} GROUP BY o.payment_status ORDER BY count DESC`, baseValues),
    client.query(`SELECT o.fulfillment_stage AS status, count(*)::int AS count FROM orders o WHERE ${clauses.join(" AND ")} GROUP BY o.fulfillment_stage ORDER BY count DESC`, baseValues),
    client.query(`SELECT o.id, o.order_number AS "orderNumber", o.created_at AS "createdAt", o.status, o.payment_status AS "paymentStatus", o.fulfillment_stage AS "fulfillmentStage", o.grand_total AS total, COALESCE(o.guest_email,u.email) AS customer FROM orders o LEFT JOIN users u ON u.id=o.user_id WHERE ${clauses.join(" AND ")} ORDER BY o.created_at DESC LIMIT $${baseValues.length + 1} OFFSET $${baseValues.length + 2}`, rowValues),
  ]);
  return { statuses: status.rows, paymentStatuses: payment.rows, fulfillmentStages: fulfillment.rows, items: rows.rows.map((item) => ({ ...item, total: money(item.total) })), meta: { page, pageSize, hasNext: rows.rows.length === pageSize } };
}

async function products(client: QueryClient, filters: AnalyticsFilters) {
  withRange(filters, []);
  const values: unknown[] = [];
  const clauses = orderClauses(filters, values);
  const catalogClauses: string[] = [];
  if (filters.productId) catalogClauses.push(`p.id = $${values.push(filters.productId)}`);
  if (filters.categoryId) catalogClauses.push(`p.category_id = $${values.push(filters.categoryId)}`);
  if (filters.brandId) catalogClauses.push(`p.brand_id = $${values.push(filters.brandId)}`);
  const baseValues = [...values];
  const itemClauses = [`${clauses.join(" AND ")}`, "oi.order_id = o.id", ...catalogClauses];
  const [rows, lowStock, noSales, categories, brands] = await Promise.all([
    client.query(`SELECT oi.product_id AS "productId", max(oi.product_name_snapshot) AS "productName", max(oi.sku_snapshot) AS sku, sum(oi.quantity)::int AS units, count(DISTINCT oi.order_id)::int AS orders, COALESCE(sum(oi.line_total),0) AS revenue, COALESCE(sum(oi.unit_price * oi.quantity),0) AS gross_revenue, COALESCE(sum(oi.unit_price * oi.quantity - oi.line_total),0) AS discounts FROM order_items oi JOIN orders o ON o.id=oi.order_id JOIN products p ON p.id=oi.product_id WHERE ${itemClauses.join(" AND ")} GROUP BY oi.product_id ORDER BY revenue DESC LIMIT 100`, values),
    client.query(`SELECT i.product_id AS "productId", max(p.name) AS "productName", sum(i.quantity_on_hand-i.quantity_reserved)::int AS available, max(i.low_stock_threshold)::int AS threshold FROM inventory i JOIN products p ON p.id=i.product_id WHERE i.active=true AND i.quantity_on_hand-i.quantity_reserved <= i.low_stock_threshold GROUP BY i.product_id,p.name ORDER BY available`, []),
     client.query(`SELECT p.id AS "productId", p.name AS "productName", p.parent_sku AS sku FROM products p WHERE p.status='active' AND p.published_at IS NOT NULL ${catalogClauses.length ? `AND ${catalogClauses.join(" AND ")}` : ""} AND NOT EXISTS (SELECT 1 FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE oi.product_id=p.id AND ${clauses.join(" AND ")}) ORDER BY p.name LIMIT 100`, baseValues),
     client.query(`SELECT c.id, c.name, sum(oi.quantity)::int AS units, count(DISTINCT oi.order_id)::int AS orders, COALESCE(sum(oi.line_total),0) AS revenue FROM order_items oi JOIN orders o ON o.id=oi.order_id JOIN products p ON p.id=oi.product_id JOIN categories c ON c.id=p.category_id WHERE ${clauses.join(" AND ")} ${catalogClauses.length ? `AND ${catalogClauses.join(" AND ")}` : ""} GROUP BY c.id ORDER BY revenue DESC LIMIT 100`, baseValues),
     client.query(`SELECT b.id, b.name, sum(oi.quantity)::int AS units, count(DISTINCT oi.order_id)::int AS orders, COALESCE(sum(oi.line_total),0) AS revenue FROM order_items oi JOIN orders o ON o.id=oi.order_id JOIN products p ON p.id=oi.product_id JOIN brands b ON b.id=p.brand_id WHERE ${clauses.join(" AND ")} ${catalogClauses.length ? `AND ${catalogClauses.join(" AND ")}` : ""} GROUP BY b.id ORDER BY revenue DESC LIMIT 100`, baseValues),
  ]);
  const aggregate = (items: any[]) => items.map((item) => ({ ...item, units: numberValue(item.units), orders: numberValue(item.orders), revenue: money(item.revenue) }));
  return { items: rows.rows.map((item) => ({ ...item, units: numberValue(item.units), orders: numberValue(item.orders), revenue: money(item.revenue), grossRevenue: money(item.gross_revenue), discounts: money(item.discounts), averageSellingPrice: numberValue(item.units) ? money(numberValue(item.revenue) / numberValue(item.units)) : 0 })), categories: aggregate(categories.rows), brands: aggregate(brands.rows), lowStock: lowStock.rows.map((item) => ({ ...item, available: numberValue(item.available), threshold: numberValue(item.threshold) })), noSales: noSales.rows, note: "Category and brand totals use current catalog relationships when historical category/brand snapshots are unavailable; order values still come from immutable item snapshots." };
}

async function customers(client: QueryClient, filters: AnalyticsFilters) {
  withRange(filters, []);
  const values: unknown[] = [];
  const clauses = orderClauses(filters, values);
  const [rows, companies] = await Promise.all([
    client.query(`SELECT COALESCE(o.user_id::text, 'guest') AS "customerKey", CASE WHEN o.user_id IS NULL THEN 'guest' ELSE 'account' END AS type, CASE WHEN o.user_id IS NULL THEN 'Guest checkout' ELSE max(u.email) END AS customer, count(*)::int AS orders, COALESCE(sum(o.grand_total),0) AS revenue, min(o.created_at) AS "firstOrderAt", max(o.created_at) AS "lastOrderAt" FROM orders o LEFT JOIN users u ON u.id=o.user_id WHERE ${clauses.join(" AND ")} GROUP BY o.user_id ORDER BY revenue DESC LIMIT 100`, values),
    client.query(`SELECT c.id, c.company_name AS "companyName", count(o.id)::int AS orders, COALESCE(sum(o.grand_total),0) AS revenue, max(o.created_at) AS "lastOrderAt" FROM companies c JOIN orders o ON o.company_id=c.id WHERE ${clauses.join(" AND ")} GROUP BY c.id ORDER BY revenue DESC LIMIT 100`, values),
  ]);
  return {
    items: rows.rows.map((item) => ({ ...item, orders: numberValue(item.orders), revenue: money(item.revenue), averageOrderValue: item.orders ? money(numberValue(item.revenue) / numberValue(item.orders)) : 0 })),
    companies: companies.rows.map((item) => ({ ...item, orders: numberValue(item.orders), revenue: money(item.revenue), averageOrderValue: item.orders ? money(numberValue(item.revenue) / numberValue(item.orders)) : 0 })),
    privacy: "Customer analytics are restricted to authorized administrators; guest checkouts are aggregated without identity enrichment.",
  };
}

async function promotions(client: QueryClient, filters: AnalyticsFilters) {
  withRange(filters, []);
  const values: unknown[] = [filters.start, filters.end, finalizedPaymentStates];
  const settledAt = "COALESCE((SELECT min(p.paid_at) FROM payments p WHERE p.order_id=o.id AND p.paid_at IS NOT NULL AND p.status = ANY(ARRAY['paid','refunded','partially_refunded']::payment_status[])),o.created_at)";
  const clauses = [`${settledAt} >= $1`, `${settledAt} < $2`, "o.currency='EUR'", "o.status <> 'cancelled'", "o.payment_status = ANY($3::payment_status[])"];
  if (filters.promotionId) clauses.push(`pu.campaign_id = $${values.push(filters.promotionId)}`);
  const rows = await client.query(`SELECT c.id, c.name, c.coupon_code AS "couponCode", c.usage_limit AS "usageLimit", c.usage_limit_per_customer AS "usageLimitPerCustomer", c.start_at AS "startAt", c.end_at AS "endAt", count(DISTINCT o.id)::int AS uses, count(DISTINCT COALESCE(o.user_id::text, 'guest:' || o.guest_session_id))::int AS customers, COALESCE(sum(o.subtotal + o.discount_total),0) AS gross_value, COALESCE(sum(CASE WHEN o.id IS NOT NULL THEN pu.discount_amount ELSE 0 END),0) AS discount, COALESCE(sum(o.subtotal),0) AS net_sales FROM promotion_campaigns c LEFT JOIN promotion_usages pu ON pu.campaign_id=c.id LEFT JOIN orders o ON o.id=pu.order_id AND ${clauses.join(" AND ")} GROUP BY c.id ORDER BY discount DESC LIMIT 100`, values);
  return { items: rows.rows.map((item) => ({ ...item, uses: numberValue(item.uses), customers: numberValue(item.customers), grossValue: money(item.gross_value), discount: money(item.discount), netSales: money(item.net_sales), averageDiscount: item.uses ? money(numberValue(item.discount) / numberValue(item.uses)) : 0, remainingUses: item.usageLimit === null ? null : Math.max(0, numberValue(item.usageLimit) - numberValue(item.uses)) })) };
}

async function inventory(client: QueryClient, filters: AnalyticsFilters) {
  withRange(filters, []);
  const [stock, movements] = await Promise.all([
    client.query(`SELECT i.id, i.product_id AS "productId", i.variant_id AS "variantId", p.name AS "productName", i.quantity_on_hand AS "onHand", i.quantity_reserved AS reserved, i.quantity_on_hand-i.quantity_reserved AS available, i.low_stock_threshold AS threshold, w.name AS warehouse FROM inventory i LEFT JOIN products p ON p.id=i.product_id JOIN warehouses w ON w.id=i.warehouse_id ORDER BY available, p.name NULLS LAST LIMIT 200`, []),
    client.query(`SELECT movement_type AS type, COALESCE(sum(quantity),0)::int AS quantity, count(*)::int AS movements FROM inventory_movements WHERE created_at >= $1 AND created_at < $2 GROUP BY movement_type ORDER BY movement_type`, [filters.start, filters.end]),
  ]);
  return { items: stock.rows.map((item) => ({ ...item, onHand: numberValue(item.onHand), reserved: numberValue(item.reserved), available: numberValue(item.available), threshold: numberValue(item.threshold) })), movements: movements.rows.map((item) => ({ type: item.type, quantity: numberValue(item.quantity), movements: numberValue(item.movements) })), note: "Stock value and margin are not shown unless an authorized report has a complete historical cost basis." };
}

async function margin(client: QueryClient, filters: AnalyticsFilters) {
  withRange(filters, []);
  const values: unknown[] = [];
  const clauses = orderClauses(filters, values);
  const [summary, products, stock] = await Promise.all([
    client.query(`SELECT COALESCE(sum(oi.line_total),0) AS revenue, COALESCE(sum(oi.cost_price_snapshot * oi.quantity),0) AS product_cost FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE ${clauses.join(" AND ")}`, values),
    client.query(`SELECT oi.product_id AS "productId", max(oi.product_name_snapshot) AS "productName", COALESCE(sum(oi.line_total),0) AS revenue, COALESCE(sum(oi.cost_price_snapshot * oi.quantity),0) AS product_cost FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE ${clauses.join(" AND ")} GROUP BY oi.product_id ORDER BY (COALESCE(sum(oi.line_total),0) - COALESCE(sum(oi.cost_price_snapshot * oi.quantity),0)) DESC LIMIT 100`, values),
    client.query(`SELECT COALESCE(sum((i.quantity_on_hand-i.quantity_reserved) * COALESCE(pv.cost_price,p.cost_price)),0) AS current_stock_value FROM inventory i LEFT JOIN product_variants pv ON pv.id=i.variant_id LEFT JOIN products p ON p.id=COALESCE(i.product_id,pv.product_id)`, []),
  ]);
  const row = summary.rows[0] ?? {};
  const revenue = money(row.revenue);
  const productCost = money(row.product_cost);
  const contribution = money(revenue - productCost);
  return {
    summary: { revenue, productCost, productContribution: contribution, contributionPercent: revenue ? Number((contribution / revenue * 100).toFixed(1)) : 0, currentStockValue: money(stock.rows[0]?.current_stock_value) },
    items: products.rows.map((item) => {
      const itemRevenue = money(item.revenue);
      const itemCost = money(item.product_cost);
      const itemContribution = money(itemRevenue - itemCost);
      return { ...item, revenue: itemRevenue, productCost: itemCost, productContribution: itemContribution, contributionPercent: itemRevenue ? Number((itemContribution / itemRevenue * 100).toFixed(1)) : 0 };
    }),
    definition: "Product contribution uses the immutable order-item cost snapshot and net line total. It is not net profit and excludes shipping, payment processing, returns, and operating costs.",
  };
}

async function fulfillment(client: QueryClient, filters: AnalyticsFilters) {
  withRange(filters, []);
  const values: unknown[] = [];
  const clauses = orderClauses(filters, values);
  const [stages, couriers, timing] = await Promise.all([
    client.query(`SELECT fulfillment_stage AS stage, count(*)::int AS orders FROM orders o WHERE ${clauses.join(" AND ")} GROUP BY fulfillment_stage ORDER BY orders DESC`, values),
    client.query(`SELECT s.courier, count(DISTINCT s.order_id)::int AS orders FROM shipments s JOIN orders o ON o.id=s.order_id WHERE ${clauses.join(" AND ")} GROUP BY s.courier ORDER BY orders DESC`, values),
    client.query(`SELECT avg(EXTRACT(EPOCH FROM (s.shipped_at-o.created_at))/3600)::numeric AS hours_to_ship, avg(EXTRACT(EPOCH FROM (s.delivered_at-s.shipped_at))/3600)::numeric AS hours_in_transit FROM shipments s JOIN orders o ON o.id=s.order_id WHERE ${clauses.join(" AND ")} AND s.shipped_at IS NOT NULL`, values),
  ]);
  return { stages: stages.rows, couriers: couriers.rows, timing: { averageHoursToShip: money(timing.rows[0]?.hours_to_ship), averageHoursInTransit: money(timing.rows[0]?.hours_in_transit) }, note: "Timing is shown only where lifecycle timestamps exist; no delivery SLA is inferred." };
}

async function returns(client: QueryClient, filters: AnalyticsFilters) {
  withRange(filters, []);
  const values: unknown[] = [filters.start, filters.end];
  const clauses = ["r.created_at >= $1", "r.created_at < $2"];
  if (filters.status) clauses.push(`r.status = $${values.push(filters.status)}::return_status`);
  const [summary, statuses, reasons, products] = await Promise.all([
    client.query(`SELECT count(DISTINCT r.id)::int AS requests, COALESCE(sum(ri.quantity),0)::int AS items FROM return_requests r LEFT JOIN return_items ri ON ri.return_request_id=r.id WHERE ${clauses.join(" AND ")}`, values),
    client.query(`SELECT r.status, count(*)::int AS count FROM return_requests r WHERE ${clauses.join(" AND ")} GROUP BY r.status ORDER BY count DESC`, values),
    client.query(`SELECT r.reason, count(*)::int AS count FROM return_requests r WHERE ${clauses.join(" AND ")} GROUP BY r.reason ORDER BY count DESC`, values),
    client.query(`SELECT oi.product_name_snapshot AS "productName", sum(ri.quantity)::int AS items FROM return_items ri JOIN return_requests r ON r.id=ri.return_request_id JOIN order_items oi ON oi.id=ri.order_item_id WHERE ${clauses.join(" AND ")} GROUP BY oi.product_name_snapshot ORDER BY items DESC LIMIT 100`, values),
  ]);
  return { summary: { requests: numberValue(summary.rows[0]?.requests), items: numberValue(summary.rows[0]?.items) }, statuses: statuses.rows, reasons: reasons.rows, products: products.rows, note: "Return analytics use real return requests and items; private evidence and descriptions are excluded." };
}

export async function getAnalytics(report: AnalyticsReport, filters: AnalyticsFilters = {}, client: QueryClient = getDatabasePool()) {
  if (report === "overview") return overview(client, { ...filters });
  if (report === "sales") return sales(client, { ...filters });
  if (report === "orders") return orders(client, { ...filters });
  if (report === "products") return products(client, { ...filters });
  if (report === "customers") return customers(client, { ...filters });
  if (report === "promotions") return promotions(client, { ...filters });
  if (report === "inventory") return inventory(client, { ...filters });
  if (report === "margin") return margin(client, { ...filters });
  if (report === "fulfillment") return fulfillment(client, { ...filters });
  if (report === "returns") return returns(client, { ...filters });
  throw new AppError(400, "INVALID_ANALYTICS_REPORT", "The analytics report is not supported.");
}

export async function getAnalyticsCsv(report: AnalyticsReport, filters: AnalyticsFilters, client: QueryClient = getDatabasePool()) {
  let data: any = await getAnalytics(report, report === "orders" ? { ...filters, page: 1, pageSize: 100 } : filters, client);
  if (report === "orders") {
    const items = [...data.items];
    let page = 1;
    while (data.meta.hasNext) {
      page += 1;
      data = await getAnalytics("orders", { ...filters, page, pageSize: 100 }, client);
      items.push(...data.items);
    }
    data = { ...data, items };
  }
  // Keep exports useful and stable: do not silently pick whichever array happens
  // to be first in a response (in particular, overview has several arrays).
  const rows: Array<Record<string, unknown>> = (() => {
    switch (report) {
      case "overview":
        return [
          ...Object.entries(data.metrics ?? {}).map(([metric, value]: [string, any]) => ({
            metric,
            value: value?.value ?? value,
            previous: value?.previous ?? "",
            changePercent: value?.change ?? "",
          })),
          ...(data.trend ?? []).map((item: any) => ({ section: "trend", ...item })),
          ...(data.statuses ?? []).map((item: any) => ({ section: "status", ...item })),
        ];
      case "sales":
        return [
          ...Object.entries(data.summary ?? {}).map(([metric, value]) => ({ section: "summary", metric, value })),
          ...(data.trend ?? []).map((item: any) => ({ section: "trend", ...item })),
          ...(data.countries ?? []).map((item: any) => ({ section: "country", ...item })),
        ];
      case "orders":
        return (data.items ?? []).map((item: any) => ({ section: "orders", ...item }));
      case "products":
        return [
          ...(data.items ?? []).map((item: any) => ({ section: "product", ...item })),
          ...(data.categories ?? []).map((item: any) => ({ section: "category", ...item })),
          ...(data.brands ?? []).map((item: any) => ({ section: "brand", ...item })),
          ...(data.lowStock ?? []).map((item: any) => ({ section: "lowStock", ...item })),
          ...(data.noSales ?? []).map((item: any) => ({ section: "noSales", ...item })),
        ];
      case "customers":
        return [
          ...(data.items ?? []).map((item: any) => ({ section: "customer", ...item })),
          ...(data.companies ?? []).map((item: any) => ({ section: "company", ...item })),
        ];
      case "promotions":
        return (data.items ?? []).map((item: any) => ({ section: "promotion", ...item }));
      case "inventory":
        return [
          ...(data.items ?? []).map((item: any) => ({ section: "stock", ...item })),
          ...(data.movements ?? []).map((item: any) => ({ section: "movement", ...item })),
        ];
      case "margin":
        return [
          { section: "summary", ...data.summary },
          ...(data.items ?? []).map((item: any) => ({ section: "product", ...item })),
        ];
      case "fulfillment":
        return [
          ...(data.stages ?? []).map((item: any) => ({ section: "stage", ...item })),
          ...(data.couriers ?? []).map((item: any) => ({ section: "courier", ...item })),
          { section: "timing", ...data.timing },
        ];
      case "returns":
        return [
          { section: "summary", ...data.summary },
          ...(data.statuses ?? []).map((item: any) => ({ section: "status", ...item })),
          ...(data.reasons ?? []).map((item: any) => ({ section: "reason", ...item })),
          ...(data.products ?? []).map((item: any) => ({ section: "product", ...item })),
        ];
    }
  })();
  if (!rows.length) return "No data\r\n";
  const headers = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  const escape = (value: unknown) => {
    const text = String(value ?? "");
    const safe = /^[\s\u0000-\u001f]*[=+\-@]/.test(text) ? `'${text}` : text;
    return `"${safe.replaceAll('"', '""')}"`;
  };
  return [headers.join(","), ...rows.map((row) => headers.map((header) => escape(row[header])).join(","))].join("\r\n") + "\r\n";
}