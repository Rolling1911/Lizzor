import { hashOpaqueToken } from "../auth/tokens.js";
import { getDatabasePool } from "../db/client.js";
import { AppError } from "../middleware/error-handler.js";
import { emitNotification } from "../notifications/service.js";

async function notifyOrderFulfillment(orderId: string, type: "shipment.created" | "fulfillment.shipped" | "fulfillment.delivered", tracking?: string | null, database: any = getDatabasePool()) {
  const row = (await database.query(`SELECT order_number AS "orderNumber",user_id AS "userId",guest_email AS email FROM orders WHERE id=$1`, [orderId])).rows[0];
  if (!row) return;
  await emitNotification({ type, idempotencyKey: `${type}:${orderId}:${tracking ?? ""}`, userId: row.userId ?? undefined, email: row.email ?? undefined,
    message: type === "shipment.created" ? `A shipment is being prepared for order ${row.orderNumber}.` : type === "fulfillment.shipped" ? `Order ${row.orderNumber} has shipped.` : `Order ${row.orderNumber} was delivered.`,
    metadata: { orderId, orderNumber: row.orderNumber, trackingNumber: tracking ?? undefined, path: `/account/orders/${orderId}/tracking` },
  }, database);
}
async function notifyReturnEvent(returnId: string, orderId: string, type: "return.requested" | "return.updated", status?: string, database: any = getDatabasePool()) {
  const row = (await database.query(`SELECT o.order_number AS "orderNumber",o.user_id AS "userId",o.guest_email AS email FROM orders o WHERE o.id=$1`, [orderId])).rows[0];
  if (!row) return;
  await emitNotification({ type, idempotencyKey: `${type}:${returnId}:${status ?? ""}`, userId: row.userId ?? undefined, email: row.email ?? undefined,
    message: type === "return.requested" ? `Your return request for order ${row.orderNumber} was received.` : `Your return request for order ${row.orderNumber} is now ${status}.`,
    metadata: { returnId, orderId, orderNumber: row.orderNumber, path: `/account/orders/${orderId}/returns` },
  }, database);
}

export type FulfillmentStage = "unfulfilled" | "processing" | "packed" | "shipped" | "delivered" | "cancelled";
export type ShipmentStatus = "pending" | "shipped" | "in_transit" | "delivered" | "returned" | "cancelled";
export type ReturnWorkflowStatus = "open" | "in_review" | "approved" | "rejected" | "received" | "completed" | "cancelled";
export type OrderAccess = { userId?: string; guestSessionId?: string; guestAccessToken?: string };

const fulfillmentStages: FulfillmentStage[] = ["unfulfilled", "processing", "packed", "shipped", "delivered", "cancelled"];
const shipmentTransitions: Record<ShipmentStatus, ShipmentStatus[]> = {
  pending: ["shipped", "cancelled"],
  shipped: ["in_transit", "delivered", "returned", "cancelled"],
  in_transit: ["delivered", "returned", "cancelled"],
  delivered: ["returned"],
  returned: [],
  cancelled: [],
};
const returnTransitions: Record<ReturnWorkflowStatus, ReturnWorkflowStatus[]> = {
  open: ["in_review", "approved", "rejected", "cancelled"],
  in_review: ["approved", "rejected", "cancelled"],
  approved: ["cancelled"],
  rejected: [],
  received: ["completed"],
  completed: [],
  cancelled: [],
};

function normalizeReturnStatus(status: string): ReturnWorkflowStatus {
  return status === "requested" ? "open" : status as ReturnWorkflowStatus;
}

function assertTransition<T extends string>(transitions: Record<string, string[]>, current: T, next: T, code: string, message: string) {
  if (current === next) return;
  if (!transitions[current]?.includes(next)) throw new AppError(409, code, message);
}

function pageValue(value: unknown, fallback: number, max = 100) {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new AppError(400, "INVALID_PAGINATION", "Pagination values must be positive integers.");
  return Math.min(max, parsed);
}

export async function quoteShipping(input: { countryCode: string; orderValue: number; weight: number }, client = getDatabasePool()) {
  if (!Number.isFinite(input.orderValue) || input.orderValue < 0 || !Number.isFinite(input.weight) || input.weight < 0) {
    throw new AppError(400, "INVALID_SHIPPING_INPUT", "Order value and weight must be nonnegative numbers.");
  }
  const result = await client.query(
    `SELECT r.id, r.shipping_price AS "shippingPrice", r.free_shipping AS "freeShipping", r.priority, z.name AS "zoneName"
       FROM shipping_rules r
       JOIN shipping_zones z ON z.id = r.zone_id AND z.active = true
       JOIN shipping_zone_countries zc ON zc.zone_id = z.id AND zc.country_code = $1
      WHERE r.active = true
        AND (r.minimum_order_value IS NULL OR r.minimum_order_value <= $2)
        AND (r.maximum_order_value IS NULL OR r.maximum_order_value >= $2)
        AND (r.minimum_weight IS NULL OR r.minimum_weight <= $3)
        AND (r.maximum_weight IS NULL OR r.maximum_weight >= $3)
      ORDER BY r.priority ASC, r.id ASC
      LIMIT 1`,
    [input.countryCode.trim().toUpperCase(), input.orderValue.toFixed(2), input.weight.toFixed(3)],
  );
  const rule = result.rows[0];
  if (!rule) return { matched: false, shippingPrice: 0, currency: "EUR", ruleId: null, zoneName: null };
  return {
    matched: true,
    shippingPrice: rule.freeShipping ? 0 : Number(rule.shippingPrice),
    currency: "EUR",
    ruleId: rule.id,
    zoneName: rule.zoneName,
    freeShipping: Boolean(rule.freeShipping),
  };
}

async function assertOrderAccess(client: any, orderId: string, access: OrderAccess, mode: "read" | "mutate" = "read") {
  const order = (await client.query(
    `SELECT id, user_id AS "userId", company_id AS "companyId", guest_session_id AS "guestSessionId",
            guest_access_token_hash AS "guestTokenHash", status, payment_status AS "paymentStatus",
            fulfillment_stage AS "fulfillmentStage", shipping_address_snapshot AS "shippingAddress"
       FROM orders WHERE id = $1`,
    [orderId],
  )).rows[0];
  if (!order) throw new AppError(404, "ORDER_NOT_FOUND", "The order was not found.");
  let allowed = Boolean(access.userId && !order.companyId && order.userId === access.userId);
  if (access.userId && order.companyId) {
    const member = (await client.query(
      `SELECT cu.role
         FROM company_users cu
         JOIN companies c ON c.id=cu.company_id
        WHERE cu.user_id=$1 AND cu.company_id=$2
          AND cu.status='active' AND c.status='active'`,
      [access.userId, order.companyId],
    )).rows[0];
    const placedByUser = order.userId === access.userId;
    allowed = Boolean(member && (
      (placedByUser && (mode === "read" || member.role !== "viewer"))
      || ["owner", "admin"].includes(member.role)
    ));
  }
  if (!allowed && access.guestSessionId && access.guestAccessToken && order.guestSessionId === access.guestSessionId) {
    allowed = hashOpaqueToken(access.guestAccessToken) === order.guestTokenHash;
  }
  if (!allowed) throw new AppError(404, "ORDER_NOT_FOUND", "The order was not found.");
  return order;
}

export async function orderWeight(client: any, orderId: string) {
  const result = await client.query(
    `SELECT COALESCE(SUM(oi.quantity * CASE WHEN oi.variant_id IS NULL THEN p.weight ELSE COALESCE(pv.weight, 0) END), 0)::numeric AS weight
       FROM order_items oi JOIN products p ON p.id=oi.product_id
       LEFT JOIN product_variants pv ON pv.id=oi.variant_id WHERE oi.order_id=$1`,
    [orderId],
  );
  return Number(result.rows[0]?.weight ?? 0);
}

export async function listFulfillment(filters: { stage?: string; search?: string; page?: unknown; pageSize?: unknown } = {}) {
  const page = pageValue(filters.page, 1);
  const pageSize = pageValue(filters.pageSize, 25);
  const values: unknown[] = [];
  const clauses = ["o.fulfillment_stage <> 'cancelled'", "o.payment_status = 'paid'", "o.status <> 'cancelled'"];
  if (filters.stage) {
    if (!fulfillmentStages.includes(filters.stage as FulfillmentStage)) throw new AppError(400, "INVALID_FULFILLMENT_STAGE", "The fulfillment stage is invalid.");
    values.push(filters.stage);
    clauses.push(`o.fulfillment_stage = $${values.length}`);
  }
  if (filters.search?.trim()) {
    values.push(`%${filters.search.trim()}%`);
    clauses.push(`(o.order_number ILIKE $${values.length} OR o.guest_email ILIKE $${values.length} OR u.email ILIKE $${values.length})`);
  }
  const pool = getDatabasePool();
  const count = await pool.query(`SELECT count(*)::text AS count FROM orders o LEFT JOIN users u ON u.id=o.user_id WHERE ${clauses.join(" AND ")}`, values);
  const offset = (page - 1) * pageSize;
  const rows = await pool.query(
    `SELECT o.id, o.order_number AS "orderNumber", o.created_at AS "createdAt", o.status,
            o.payment_status AS "paymentStatus", o.fulfillment_status AS "fulfillmentStatus",
            o.fulfillment_stage AS "fulfillmentStage", o.currency, o.grand_total AS "grandTotal",
             COALESCE(o.guest_email,u.email) AS email, COALESCE(s.shipments,'[]'::json) AS shipments
       FROM orders o LEFT JOIN users u ON u.id=o.user_id
       LEFT JOIN LATERAL (
         SELECT json_agg(json_build_object('id',sh.id,'courier',sh.courier,'trackingNumber',sh.tracking_number,'trackingUrl',sh.tracking_url,'status',sh.status,'createdAt',sh.created_at) ORDER BY sh.created_at) AS shipments
         FROM shipments sh WHERE sh.order_id=o.id
       ) s ON true
      WHERE ${clauses.join(" AND ")} ORDER BY o.created_at DESC, o.id
      LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
    [...values, pageSize, offset],
  );
  const total = Number(count.rows[0]?.count ?? 0);
  return { items: rows.rows.map((row: any) => ({ ...row, grandTotal: Number(row.grandTotal) })), meta: { page, pageSize, total, hasNext: offset + rows.rows.length < total } };
}

export async function transitionFulfillment(orderId: string, nextStage: FulfillmentStage, actorUserId?: string) {
  if (!fulfillmentStages.includes(nextStage)) throw new AppError(400, "INVALID_FULFILLMENT_STAGE", "The fulfillment stage is invalid.");
  const client = await getDatabasePool().connect();
  try {
    await client.query("BEGIN");
    const order = (await client.query(`SELECT id, status, payment_status AS "paymentStatus", fulfillment_stage AS "fulfillmentStage", fulfillment_status AS "fulfillmentStatus" FROM orders WHERE id=$1 FOR UPDATE`, [orderId])).rows[0];
    if (!order) throw new AppError(404, "ORDER_NOT_FOUND", "The order was not found.");
    assertTransition({ unfulfilled: ["processing", "cancelled"], processing: ["packed", "cancelled"], packed: ["shipped", "cancelled"], shipped: ["delivered"], delivered: [], cancelled: [] }, order.fulfillmentStage, nextStage, "INVALID_FULFILLMENT_TRANSITION", "That fulfillment transition is not allowed.");
    if (nextStage !== "cancelled" && (order.paymentStatus !== "paid" || order.status === "cancelled")) throw new AppError(409, "ORDER_NOT_PAID", "Only paid, non-cancelled orders can enter fulfillment.");
    if (nextStage === "shipped" && !(await client.query("SELECT 1 FROM shipments WHERE order_id=$1 AND status IN ('shipped','in_transit','delivered')", [orderId])).rows[0]) {
      throw new AppError(409, "SHIPMENT_REQUIRED", "Create and ship a shipment before marking the order shipped.");
    }
    if (nextStage === "delivered") {
      const outstanding = (await client.query("SELECT count(*)::int AS count FROM shipments WHERE order_id=$1 AND status NOT IN ('delivered','cancelled')", [orderId])).rows[0];
      if (Number(outstanding.count) > 0 || !(await client.query("SELECT 1 FROM shipments WHERE order_id=$1 AND status='delivered'", [orderId])).rows[0]) {
        throw new AppError(409, "SHIPMENTS_NOT_DELIVERED", "Every active shipment must be delivered before completing the order.");
      }
    }
    const fulfillmentStatus = nextStage === "cancelled" ? "cancelled" : nextStage === "delivered" ? "fulfilled" : nextStage === "unfulfilled" ? "unfulfilled" : "partially_fulfilled";
    await client.query("UPDATE orders SET fulfillment_stage=$1::varchar, fulfillment_status=$2::fulfillment_status, status=CASE WHEN $1::varchar='delivered' THEN 'completed'::order_status ELSE status END, updated_at=now() WHERE id=$3", [nextStage, fulfillmentStatus, orderId]);
    await client.query("INSERT INTO audit_logs (actor_user_id, action, entity_type, entity_id, new_values_json) VALUES ($1,'fulfillment.stage_changed','order',$2,$3)", [actorUserId ?? null, orderId, JSON.stringify({ from: order.fulfillmentStage, to: nextStage })]);
    await client.query("INSERT INTO fulfillment_events (order_id,stage,created_by) VALUES ($1,$2,$3)", [orderId, nextStage, actorUserId ?? null]);
    if (nextStage === "shipped" || nextStage === "delivered") await notifyOrderFulfillment(orderId, nextStage === "shipped" ? "fulfillment.shipped" : "fulfillment.delivered", null, client);
    await client.query("COMMIT");
    return { orderId, fulfillmentStage: nextStage, fulfillmentStatus };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function bulkTransitionFulfillment(orderIds: string[], nextStage: FulfillmentStage, actorUserId: string) {
  if (!orderIds.length || orderIds.length > 100) throw new AppError(400, "ORDER_IDS_REQUIRED", "Select between one and 100 orders.");
  const results: Array<{ orderId: string; ok: boolean; error?: string }> = [];
  for (const orderId of orderIds) {
    try { await transitionFulfillment(orderId, nextStage, actorUserId); results.push({ orderId, ok: true }); }
    catch (error) { results.push({ orderId, ok: false, error: error instanceof Error ? error.message : "Transition failed." }); }
  }
  return { results, updated: results.filter((item) => item.ok).length };
}

export async function createShipment(orderId: string, input: { courier: string; trackingNumber?: string; trackingUrl?: string }, actorUserId: string) {
  const client = await getDatabasePool().connect();
  try {
    await client.query("BEGIN");
    const order = (await client.query("SELECT id, status, payment_status AS \"paymentStatus\", fulfillment_stage AS \"fulfillmentStage\" FROM orders WHERE id=$1 FOR UPDATE", [orderId])).rows[0];
    if (!order) throw new AppError(404, "ORDER_NOT_FOUND", "The order was not found.");
    if (order.paymentStatus !== "paid" || order.status === "cancelled") throw new AppError(409, "ORDER_NOT_FULFILLABLE", "Only paid, non-cancelled orders can be shipped.");
    if (order.fulfillmentStage !== "packed" && order.fulfillmentStage !== "shipped") throw new AppError(409, "ORDER_NOT_PACKED", "The order must be packed before a shipment can be created.");
    const shipment = (await client.query(
      `INSERT INTO shipments (order_id,courier,tracking_number,tracking_url,status) VALUES ($1,$2,$3,$4,'pending') RETURNING id,order_id AS "orderId",courier,tracking_number AS "trackingNumber",tracking_url AS "trackingUrl",status,shipped_at AS "shippedAt",delivered_at AS "deliveredAt",created_at AS "createdAt"`,
      [orderId, input.courier.trim(), input.trackingNumber?.trim() || null, input.trackingUrl?.trim() || null],
    )).rows[0];
    await client.query("INSERT INTO audit_logs (actor_user_id, action, entity_type, entity_id, new_values_json) VALUES ($1,'shipment.created','shipment',$2,$3)", [actorUserId, shipment.id, JSON.stringify({ orderId })]);
    await notifyOrderFulfillment(orderId, "shipment.created", shipment.trackingNumber, client);
    await client.query("COMMIT");
    return shipment;
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
}

export async function updateShipment(shipmentId: string, input: { status: ShipmentStatus; courier?: string; trackingNumber?: string | null; trackingUrl?: string | null }, actorUserId: string) {
  if (!Object.keys(shipmentTransitions).includes(input.status)) throw new AppError(400, "INVALID_SHIPMENT_STATUS", "The shipment status is invalid.");
  const client = await getDatabasePool().connect();
  try {
    await client.query("BEGIN");
    const shipment = (await client.query("SELECT id,order_id AS \"orderId\",status,courier,tracking_number AS \"trackingNumber\",tracking_url AS \"trackingUrl\" FROM shipments WHERE id=$1 FOR UPDATE", [shipmentId])).rows[0];
    if (!shipment) throw new AppError(404, "SHIPMENT_NOT_FOUND", "The shipment was not found.");
    const order = (await client.query("SELECT id,status,payment_status AS \"paymentStatus\",fulfillment_stage AS \"fulfillmentStage\" FROM orders WHERE id=$1 FOR UPDATE", [shipment.orderId])).rows[0];
    if (!order || order.status === "cancelled" || order.paymentStatus !== "paid") throw new AppError(409, "ORDER_NOT_FULFILLABLE", "The order can no longer be fulfilled.");
    assertTransition(shipmentTransitions, shipment.status, input.status, "INVALID_SHIPMENT_TRANSITION", "That shipment transition is not allowed.");
    if (input.status === "shipped" && !["packed", "shipped"].includes(order.fulfillmentStage)) throw new AppError(409, "ORDER_NOT_PACKED", "The order must be packed before shipping.");
    const nowFields = input.status === "shipped" && shipment.status !== "shipped" ? ", shipped_at=COALESCE(shipped_at,now())" : input.status === "delivered" ? ", shipped_at=COALESCE(shipped_at,now()), delivered_at=COALESCE(delivered_at,now())" : "";
    const updated = (await client.query(
      `UPDATE shipments SET status=$1::shipment_status,courier=COALESCE($2,courier),tracking_number=$3,tracking_url=$4,updated_at=now()${nowFields}
       WHERE id=$5 RETURNING id,order_id AS "orderId",courier,tracking_number AS "trackingNumber",tracking_url AS "trackingUrl",status,shipped_at AS "shippedAt",delivered_at AS "deliveredAt"`,
      [input.status, input.courier?.trim() || null, input.trackingNumber === undefined ? shipment.trackingNumber : input.trackingNumber?.trim() || null, input.trackingUrl === undefined ? shipment.trackingUrl : input.trackingUrl?.trim() || null, shipmentId],
    )).rows[0];
    await client.query("INSERT INTO shipment_events (shipment_id,status,note,created_by) VALUES ($1,$2::shipment_status,$3,$4)", [shipmentId, input.status, null, actorUserId]);
    const aggregate = (await client.query(
      `SELECT
         count(*) FILTER (WHERE status NOT IN ('returned','cancelled'))::int AS active,
         count(*) FILTER (WHERE status='delivered')::int AS delivered,
         count(*) FILTER (WHERE status IN ('shipped','in_transit','delivered'))::int AS dispatched
       FROM shipments WHERE order_id=$1`,
      [shipment.orderId],
    )).rows[0];
    const active = Number(aggregate.active);
    const delivered = Number(aggregate.delivered);
    const dispatched = Number(aggregate.dispatched);
    const aggregateStage: FulfillmentStage = active > 0 && delivered === active ? "delivered" : dispatched > 0 ? "shipped" : "packed";
    const aggregateStatus = aggregateStage === "delivered" ? "fulfilled" : "partially_fulfilled";
    await client.query(
      `UPDATE orders SET fulfillment_stage=$1::varchar,fulfillment_status=$2::fulfillment_status,
       status=CASE WHEN $1::varchar='delivered' THEN 'completed'::order_status WHEN status='completed' THEN 'processing'::order_status ELSE status END,updated_at=now()
       WHERE id=$3`,
      [aggregateStage, aggregateStatus, shipment.orderId],
    );
    if (aggregateStage !== order.fulfillmentStage) await client.query("INSERT INTO fulfillment_events (order_id,stage,created_by) VALUES ($1,$2,$3)", [shipment.orderId, aggregateStage, actorUserId]);
    await client.query("INSERT INTO audit_logs (actor_user_id,action,entity_type,entity_id,new_values_json) VALUES ($1,'shipment.status_changed','shipment',$2,$3)", [actorUserId, shipmentId, JSON.stringify({ from: shipment.status, to: input.status })]);
    if (input.status === "shipped" || input.status === "delivered") await notifyOrderFulfillment(shipment.orderId, input.status === "shipped" ? "fulfillment.shipped" : "fulfillment.delivered", updated.trackingNumber, client);
    await client.query("COMMIT");
    return updated;
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
}

export async function getOrderTracking(orderId: string, access: OrderAccess) {
  const client = getDatabasePool();
  await assertOrderAccess(client, orderId, access);
  return readOrderTracking(client, orderId);
}

async function readOrderTracking(client: any, orderId: string) {
  const [shipments, shipmentEvents, fulfillmentEvents] = await Promise.all([
    client.query(`SELECT id,courier,tracking_number AS "trackingNumber",tracking_url AS "trackingUrl",status,shipped_at AS "shippedAt",delivered_at AS "deliveredAt",created_at AS "createdAt" FROM shipments WHERE order_id=$1 ORDER BY created_at DESC`, [orderId]),
    client.query(`SELECT se.id,se.shipment_id AS "shipmentId",se.status,se.note,se.created_at AS "createdAt" FROM shipment_events se JOIN shipments s ON s.id=se.shipment_id WHERE s.order_id=$1 ORDER BY se.created_at`, [orderId]),
    client.query(`SELECT id,NULL::uuid AS "shipmentId",stage AS status,note,created_at AS "createdAt" FROM fulfillment_events WHERE order_id=$1 ORDER BY created_at`, [orderId]),
  ]);
  return { shipments: shipments.rows, timeline: [...fulfillmentEvents.rows, ...shipmentEvents.rows].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()) };
}

export async function getAdminOrderTracking(orderId: string) {
  const pool = getDatabasePool();
  if (!(await pool.query("SELECT 1 FROM orders WHERE id=$1", [orderId])).rows[0]) throw new AppError(404, "ORDER_NOT_FOUND", "The order was not found.");
  return readOrderTracking(pool, orderId);
}

export async function listShippingZones() {
  const pool = getDatabasePool();
  const zones = (await pool.query("SELECT id,name,active,created_at AS \"createdAt\",updated_at AS \"updatedAt\" FROM shipping_zones ORDER BY name")).rows;
  const countries = (await pool.query("SELECT zone_id AS \"zoneId\",country_code AS \"countryCode\" FROM shipping_zone_countries ORDER BY country_code")).rows;
  return zones.map((zone) => ({ ...zone, countries: countries.filter((country) => country.zoneId === zone.id) }));
}

export async function saveShippingZone(input: { name: string; active: boolean; countries: string[] }, id?: string) {
  const client = await getDatabasePool().connect();
  try {
    await client.query("BEGIN");
    const zone = id
      ? (await client.query("UPDATE shipping_zones SET name=$1,active=$2,updated_at=now() WHERE id=$3 RETURNING id", [input.name.trim(), input.active, id])).rows[0]
      : (await client.query("INSERT INTO shipping_zones (name,active) VALUES ($1,$2) RETURNING id", [input.name.trim(), input.active])).rows[0];
    if (!zone) throw new AppError(404, "SHIPPING_ZONE_NOT_FOUND", "The shipping zone was not found.");
    await client.query("DELETE FROM shipping_zone_countries WHERE zone_id=$1", [zone.id]);
    for (const country of [...new Set(input.countries.map((value) => value.trim().toUpperCase()))]) {
      if (!/^[A-Z]{2}$/.test(country)) throw new AppError(400, "INVALID_COUNTRY_CODE", "Countries must use two-letter ISO codes.");
      await client.query("INSERT INTO shipping_zone_countries (zone_id,country_code) VALUES ($1,$2)", [zone.id, country]);
    }
    await client.query("COMMIT");
    return zone.id;
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
}

export async function listShippingRules() {
  return (await getDatabasePool().query(`SELECT r.id,r.zone_id AS "zoneId",z.name AS "zoneName",r.minimum_order_value AS "minimumOrderValue",r.maximum_order_value AS "maximumOrderValue",r.minimum_weight AS "minimumWeight",r.maximum_weight AS "maximumWeight",r.shipping_price AS "shippingPrice",r.free_shipping AS "freeShipping",r.active,r.priority FROM shipping_rules r JOIN shipping_zones z ON z.id=r.zone_id ORDER BY r.priority,r.id`)).rows.map((row) => ({ ...row, minimumOrderValue: row.minimumOrderValue === null ? null : Number(row.minimumOrderValue), maximumOrderValue: row.maximumOrderValue === null ? null : Number(row.maximumOrderValue), minimumWeight: row.minimumWeight === null ? null : Number(row.minimumWeight), maximumWeight: row.maximumWeight === null ? null : Number(row.maximumWeight), shippingPrice: Number(row.shippingPrice) }));
}

export async function saveShippingRule(input: { zoneId: string; minimumOrderValue?: number | null; maximumOrderValue?: number | null; minimumWeight?: number | null; maximumWeight?: number | null; shippingPrice: number; freeShipping: boolean; active: boolean; priority: number }, id?: string) {
  if (input.shippingPrice < 0 || input.priority < 0 || [input.minimumOrderValue, input.maximumOrderValue, input.minimumWeight, input.maximumWeight].some((value) => value !== null && value !== undefined && value < 0)) throw new AppError(400, "INVALID_SHIPPING_RULE", "Shipping values must be nonnegative.");
  if (input.minimumOrderValue !== null && input.maximumOrderValue !== null && input.minimumOrderValue !== undefined && input.maximumOrderValue !== undefined && input.maximumOrderValue < input.minimumOrderValue) throw new AppError(400, "INVALID_SHIPPING_RANGE", "The maximum order value must be at least the minimum.");
  if (input.minimumWeight !== null && input.maximumWeight !== null && input.minimumWeight !== undefined && input.maximumWeight !== undefined && input.maximumWeight < input.minimumWeight) throw new AppError(400, "INVALID_SHIPPING_RANGE", "The maximum weight must be at least the minimum.");
  const values = [input.zoneId, input.minimumOrderValue ?? null, input.maximumOrderValue ?? null, input.minimumWeight ?? null, input.maximumWeight ?? null, input.shippingPrice, input.freeShipping, input.active, input.priority];
  const result = id
    ? await getDatabasePool().query("UPDATE shipping_rules SET zone_id=$1,minimum_order_value=$2,maximum_order_value=$3,minimum_weight=$4,maximum_weight=$5,shipping_price=$6,free_shipping=$7,active=$8,priority=$9,updated_at=now() WHERE id=$10 RETURNING id", [...values, id])
    : await getDatabasePool().query("INSERT INTO shipping_rules (zone_id,minimum_order_value,maximum_order_value,minimum_weight,maximum_weight,shipping_price,free_shipping,active,priority) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id", values);
  if (!result.rows[0]) throw new AppError(404, "SHIPPING_RULE_NOT_FOUND", "The shipping rule was not found.");
  return result.rows[0].id;
}

export async function listReturns(filters: { status?: string; search?: string; page?: unknown; pageSize?: unknown } = {}) {
  const page = pageValue(filters.page, 1);
  const pageSize = pageValue(filters.pageSize, 25);
  const values: unknown[] = [];
  const clauses = ["1=1"];
  if (filters.status) {
    const status = filters.status === "open" ? "requested" : filters.status;
    if (!["requested", "in_review", "approved", "rejected", "received", "completed", "cancelled"].includes(status)) throw new AppError(400, "INVALID_RETURN_STATUS", "The return status is invalid.");
    values.push(status);
    clauses.push(`r.status=$${values.length}::return_status`);
  }
  if (filters.search?.trim()) { values.push(`%${filters.search.trim()}%`); clauses.push(`(o.order_number ILIKE $${values.length} OR o.guest_email ILIKE $${values.length} OR u.email ILIKE $${values.length})`); }
  const pool = getDatabasePool();
  const count = await pool.query(`SELECT count(*)::text AS count FROM return_requests r JOIN orders o ON o.id=r.order_id LEFT JOIN users u ON u.id=o.user_id WHERE ${clauses.join(" AND ")}`, values);
  const offset = (page - 1) * pageSize;
  const rows = await pool.query(`SELECT r.id,r.order_id AS "orderId",o.order_number AS "orderNumber",COALESCE(o.guest_email,u.email) AS email,r.reason,r.description,r.status,r.admin_notes AS "adminNotes",r.created_at AS "createdAt",r.reviewed_at AS "reviewedAt",r.received_at AS "receivedAt",COALESCE(json_agg(json_build_object('id',ri.id,'orderItemId',ri.order_item_id,'productName',oi.product_name_snapshot,'sku',oi.sku_snapshot,'quantity',ri.quantity,'approvedQuantity',ri.approved_quantity,'receivedQuantity',ri.received_quantity) ORDER BY ri.created_at) FILTER (WHERE ri.id IS NOT NULL),'[]') AS items FROM return_requests r JOIN orders o ON o.id=r.order_id LEFT JOIN users u ON u.id=o.user_id LEFT JOIN return_items ri ON ri.return_request_id=r.id LEFT JOIN order_items oi ON oi.id=ri.order_item_id WHERE ${clauses.join(" AND ")} GROUP BY r.id,o.order_number,o.guest_email,u.email ORDER BY r.created_at DESC,r.id LIMIT $${values.length+1} OFFSET $${values.length+2}`, [...values, pageSize, offset]);
  const total = Number(count.rows[0]?.count ?? 0);
  const returnIds = rows.rows.map((row: any) => row.id);
  const attachments = returnIds.length ? (await pool.query(`SELECT id,return_request_id AS "returnRequestId",filename,mime_type AS "mimeType",size_bytes AS "sizeBytes",created_at AS "createdAt" FROM return_attachments WHERE return_request_id=ANY($1::uuid[]) ORDER BY created_at`, [returnIds])).rows : [];
  return { items: rows.rows.map((row: any) => ({ ...row, status: normalizeReturnStatus(row.status), items: row.items ?? [], attachments: attachments.filter((attachment: any) => attachment.returnRequestId === row.id) })), meta: { page, pageSize, total, hasNext: offset + rows.rows.length < total } };
}

export async function getReturnAttachment(returnId: string, attachmentId: string) {
  const attachment = (await getDatabasePool().query(`SELECT id,filename,mime_type AS "mimeType",size_bytes AS "sizeBytes",data FROM return_attachments WHERE id=$1 AND return_request_id=$2`, [attachmentId, returnId])).rows[0];
  if (!attachment) throw new AppError(404, "RETURN_ATTACHMENT_NOT_FOUND", "The return attachment was not found.");
  return attachment as { id: string; filename: string; mimeType: string; sizeBytes: number; data: Buffer };
}

export async function createReturn(orderId: string, access: OrderAccess, input: { reason: string; description?: string; items: Array<{ orderItemId: string; quantity: number }>; attachments?: Array<{ filename: string; mimeType: string; sizeBytes: number; data: Buffer }> }) {
  const client = await getDatabasePool().connect();
  try {
    await client.query("BEGIN");
    const order = await assertOrderAccess(client, orderId, access, "mutate");
    if (order.paymentStatus !== "paid" || order.status === "cancelled" || !["delivered", "completed"].includes(order.fulfillmentStage)) throw new AppError(409, "RETURN_NOT_ELIGIBLE", "Only paid and delivered orders are eligible for return.");
    if (!input.items.length) throw new AppError(400, "RETURN_ITEMS_REQUIRED", "Choose at least one order item.");
    const activeStatuses = ["requested", "in_review", "approved", "received", "completed"];
    for (const item of input.items) {
      if (!Number.isInteger(item.quantity) || item.quantity < 1) throw new AppError(400, "INVALID_RETURN_QUANTITY", "Return quantities must be positive whole numbers.");
      const orderItem = (await client.query("SELECT id,quantity FROM order_items WHERE id=$1 AND order_id=$2 FOR UPDATE", [item.orderItemId, orderId])).rows[0];
      if (!orderItem) throw new AppError(400, "ORDER_ITEM_NOT_FOUND", "Every return item must belong to the order.");
      const used = (await client.query(`SELECT COALESCE(sum(ri.quantity),0)::int AS quantity FROM return_items ri JOIN return_requests rr ON rr.id=ri.return_request_id WHERE ri.order_item_id=$1 AND rr.order_id=$2 AND rr.status = ANY($3::return_status[])`, [item.orderItemId, orderId, activeStatuses])).rows[0];
      if (item.quantity + Number(used.quantity) > Number(orderItem.quantity)) throw new AppError(409, "RETURN_QUANTITY_EXCEEDS_PURCHASE", "The requested return quantity exceeds the quantity purchased.");
    }
    const request = (await client.query("INSERT INTO return_requests (order_id,user_id,reason,description,status) VALUES ($1,$2,$3,$4,'requested') RETURNING id", [orderId, access.userId ?? null, input.reason.trim(), input.description?.trim() || null])).rows[0];
    for (const item of input.items) await client.query("INSERT INTO return_items (return_request_id,order_id,order_item_id,quantity,approved_quantity) VALUES ($1,$2,$3,$4,0)", [request.id, orderId, item.orderItemId, item.quantity]);
    const attachments = input.attachments ?? [];
    if (attachments.length > 3 || attachments.reduce((sum, attachment) => sum + attachment.sizeBytes, 0) > 10 * 1024 * 1024) throw new AppError(400, "RETURN_ATTACHMENTS_TOO_LARGE", "Return attachments may include at most three files and 10 MB total.");
    for (const attachment of attachments) {
      if (attachment.sizeBytes < 1 || attachment.sizeBytes > 5 * 1024 * 1024) throw new AppError(400, "INVALID_ATTACHMENT", "Each return attachment must be between 1 byte and 5 MB.");
      if (!new Set(["application/pdf", "image/jpeg", "image/png", "image/webp"]).has(attachment.mimeType) || !/^[0-9a-f-]{36}\.(pdf|jpg|png|webp)$/.test(attachment.filename)) throw new AppError(400, "INVALID_ATTACHMENT_TYPE", "Return evidence must be an approved attachment type.");
      if (attachment.data.length !== attachment.sizeBytes) throw new AppError(400, "INVALID_ATTACHMENT", "The attachment size did not match its content.");
      await client.query("INSERT INTO return_attachments (return_request_id,filename,mime_type,size_bytes,data) VALUES ($1,$2,$3,$4,$5)", [request.id, attachment.filename.slice(0, 255), attachment.mimeType, attachment.sizeBytes, attachment.data]);
    }
    await client.query("INSERT INTO audit_logs (actor_user_id,action,entity_type,entity_id,new_values_json) VALUES ($1,'return.requested','return_request',$2,$3)", [access.userId ?? null, request.id, JSON.stringify({ orderId, itemCount: input.items.length })]);
    await notifyReturnEvent(request.id, orderId, "return.requested", undefined, client);
    await client.query("COMMIT");
    return { id: request.id, status: "open" };
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
}

export async function listCustomerReturns(orderId: string, access: OrderAccess) {
  const client = getDatabasePool();
  await assertOrderAccess(client, orderId, access);
  const rows = await client.query(`SELECT r.id,r.reason,r.description,r.status,r.admin_notes AS "adminNotes",r.created_at AS "createdAt",json_agg(json_build_object('orderItemId',ri.order_item_id,'productName',oi.product_name_snapshot,'quantity',ri.quantity,'approvedQuantity',ri.approved_quantity,'receivedQuantity',ri.received_quantity) ORDER BY ri.created_at) AS items FROM return_requests r JOIN return_items ri ON ri.return_request_id=r.id JOIN order_items oi ON oi.id=ri.order_item_id WHERE r.order_id=$1 GROUP BY r.id ORDER BY r.created_at DESC`, [orderId]);
  return rows.rows.map((row: any) => ({ ...row, status: normalizeReturnStatus(row.status) }));
}

export async function updateReturn(returnId: string, nextStatus: ReturnWorkflowStatus, adminNotes: string | undefined, actorUserId: string) {
  const client = await getDatabasePool().connect();
  try {
    await client.query("BEGIN");
    const request = (await client.query("SELECT id,order_id AS \"orderId\",status,admin_notes AS \"adminNotes\" FROM return_requests WHERE id=$1 FOR UPDATE", [returnId])).rows[0];
    if (!request) throw new AppError(404, "RETURN_NOT_FOUND", "The return request was not found.");
    const current = normalizeReturnStatus(request.status);
    if (!returnTransitions[current]?.includes(nextStatus) && current !== nextStatus) throw new AppError(409, "INVALID_RETURN_TRANSITION", "That return transition is not allowed.");
    if (nextStatus === "approved") await client.query("UPDATE return_items SET approved_quantity=quantity WHERE return_request_id=$1", [returnId]);
    const dbStatus = nextStatus === "open" ? "requested" : nextStatus;
    await client.query("UPDATE return_requests SET status=$1::return_status,admin_notes=COALESCE($2,admin_notes),reviewed_at=CASE WHEN $1 IN ('in_review','approved','rejected') THEN now() ELSE reviewed_at END,reviewed_by=CASE WHEN $1 IN ('in_review','approved','rejected') THEN $3 ELSE reviewed_by END,updated_at=now() WHERE id=$4", [dbStatus, adminNotes?.trim() || null, actorUserId, returnId]);
    await client.query("INSERT INTO audit_logs (actor_user_id,action,entity_type,entity_id,new_values_json) VALUES ($1,'return.status_changed','return_request',$2,$3)", [actorUserId, returnId, JSON.stringify({ from: current, to: nextStatus })]);
    await notifyReturnEvent(returnId, request.orderId, "return.updated", nextStatus, client);
    await client.query("COMMIT");
    return { id: returnId, status: nextStatus };
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
}

export async function receiveReturn(returnId: string, warehouseId: string, actorUserId: string) {
  const client = await getDatabasePool().connect();
  try {
    await client.query("BEGIN");
    const request = (await client.query("SELECT id,order_id AS \"orderId\",status FROM return_requests WHERE id=$1 FOR UPDATE", [returnId])).rows[0];
    if (!request) throw new AppError(404, "RETURN_NOT_FOUND", "The return request was not found.");
    if (["received", "completed"].includes(normalizeReturnStatus(request.status))) {
      const prior = (await client.query("SELECT COALESCE(sum(quantity),0)::int AS quantity FROM inventory_movements WHERE reference_type='return_request' AND reference_id=$1", [returnId])).rows[0];
      await client.query("COMMIT");
      return { id: returnId, status: normalizeReturnStatus(request.status), quantity: Number(prior.quantity), replayed: true };
    }
    if (normalizeReturnStatus(request.status) !== "approved") throw new AppError(409, "RETURN_NOT_APPROVED", "Only approved returns can be received.");
    const warehouse = (await client.query("SELECT id,active FROM warehouses WHERE id=$1 FOR UPDATE", [warehouseId])).rows[0];
    if (!warehouse || !warehouse.active) throw new AppError(400, "WAREHOUSE_UNAVAILABLE", "Choose an active warehouse.");
    const items = (await client.query(`SELECT ri.id,ri.order_item_id AS "orderItemId",ri.approved_quantity AS "approvedQuantity",ri.received_quantity AS "receivedQuantity",oi.product_id AS "productId",oi.variant_id AS "variantId" FROM return_items ri JOIN order_items oi ON oi.id=ri.order_item_id WHERE ri.return_request_id=$1 FOR UPDATE`, [returnId])).rows;
    let received = 0;
    for (const item of items) {
      const quantity = Number(item.approvedQuantity) - Number(item.receivedQuantity);
      if (quantity <= 0) continue;
      const current = (await client.query(`SELECT id FROM inventory WHERE warehouse_id=$1 AND product_id IS NOT DISTINCT FROM $2::uuid AND variant_id IS NOT DISTINCT FROM $3::uuid FOR UPDATE`, [warehouseId, item.variantId ? null : item.productId, item.variantId ?? null])).rows[0];
      let inventoryId = current?.id;
      if (!inventoryId) inventoryId = (await client.query("INSERT INTO inventory (warehouse_id,product_id,variant_id,quantity_on_hand,quantity_reserved,low_stock_threshold) VALUES ($1,$2,$3,0,0,0) RETURNING id", [warehouseId, item.variantId ? null : item.productId, item.variantId ?? null])).rows[0].id;
      await client.query("UPDATE inventory SET quantity_on_hand=quantity_on_hand+$1,updated_at=now() WHERE id=$2", [quantity, inventoryId]);
      await client.query("INSERT INTO inventory_movements (warehouse_id,product_id,variant_id,movement_type,quantity,reference_type,reference_id,note,created_by) VALUES ($1,$2,$3,'return',$4,'return_request',$5,'Approved customer return received',$6)", [warehouseId, item.variantId ? null : item.productId, item.variantId ?? null, quantity, returnId, actorUserId]);
      await client.query("UPDATE return_items SET received_quantity=approved_quantity,updated_at=now() WHERE id=$1", [item.id]);
      received += quantity;
    }
    await client.query("UPDATE return_requests SET status='received',received_at=now(),received_by=$1,updated_at=now() WHERE id=$2", [actorUserId, returnId]);
    await client.query("INSERT INTO audit_logs (actor_user_id,action,entity_type,entity_id,new_values_json) VALUES ($1,'return.stock_received','return_request',$2,$3)", [actorUserId, returnId, JSON.stringify({ warehouseId, quantity: received })]);
    await client.query("COMMIT");
    return { id: returnId, status: "received", quantity: received };
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
}