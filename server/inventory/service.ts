import { getDatabasePool } from "../db/client.js";
import { AppError } from "../middleware/error-handler.js";

type Scope = { productId?: string | null; variantId?: string | null };
type InventoryRow = {
  id: string;
  warehouseId: string;
  warehouseName: string;
  warehouseCode: string;
  warehouseActive: boolean;
  productId: string | null;
  variantId: string | null;
  sku: string;
  barcode: string | null;
  itemName: string;
  brandId: string | null;
  brandName: string | null;
  categoryId: string;
  categoryName: string;
  quantityOnHand: number;
  quantityReserved: number;
  lowStockThreshold: number;
  active: boolean;
  productStatus: "draft" | "active" | "inactive" | "archived";
  lifecycleActive: boolean;
  updatedAt: string;
};

function scopeValues(scope: Scope): [string | null, string | null] {
  const productId = scope.productId ?? null;
  const variantId = scope.variantId ?? null;
  if ((productId ? 1 : 0) + (variantId ? 1 : 0) !== 1) {
    throw new AppError(400, "INVENTORY_SCOPE_REQUIRED", "Provide exactly one product or variant.");
  }
  return [productId, variantId];
}

function mapInventory(row: Record<string, unknown>): InventoryRow & { available: number; status: "inactive" | "out" | "low" | "in_stock" } {
  const quantityOnHand = Number(row.quantityOnHand);
  const quantityReserved = Number(row.quantityReserved);
  const lowStockThreshold = Number(row.lowStockThreshold);
  const available = quantityOnHand - quantityReserved;
  return {
    ...(row as unknown as InventoryRow),
    quantityOnHand,
    quantityReserved,
    lowStockThreshold,
    available,
    status: row.lifecycleActive === false ? "inactive" : available <= 0 ? "out" : available <= lowStockThreshold ? "low" : "in_stock",
  };
}

function inventoryFromClause(filters: InventoryFilters): { where: string; values: unknown[] } {
  const clauses = ["1 = 1"];
  const values: unknown[] = [];
  if (filters.search?.trim()) {
    values.push(`%${filters.search.trim()}%`);
    clauses.push(`(p.name ILIKE $${values.length} OR p.parent_sku ILIKE $${values.length} OR p.barcode ILIKE $${values.length} OR pv.sku ILIKE $${values.length} OR pv.barcode ILIKE $${values.length} OR pv.title ILIKE $${values.length} OR w.name ILIKE $${values.length} OR w.code ILIKE $${values.length})`);
  }
  if (filters.warehouseId) {
    values.push(filters.warehouseId);
    clauses.push(`i.warehouse_id = $${values.length}`);
  }
  if ((filters.lifecycle ?? "active") === "active") clauses.push("i.active = true AND p.status = 'active'");
  if (filters.lifecycle === "inactive") clauses.push("(i.active = false OR p.status <> 'active')");
  if (filters.status === "out") clauses.push("i.quantity_on_hand - i.quantity_reserved <= 0");
  if (filters.status === "low") clauses.push("i.quantity_on_hand - i.quantity_reserved > 0 AND i.quantity_on_hand - i.quantity_reserved <= i.low_stock_threshold");
  if (filters.status === "in_stock") clauses.push("i.quantity_on_hand - i.quantity_reserved > i.low_stock_threshold");
  if (filters.productId) {
    values.push(filters.productId);
    clauses.push(`(i.product_id = $${values.length} OR i.variant_id IN (SELECT id FROM product_variants WHERE product_id = $${values.length}))`);
  }
  if (filters.variantId) {
    values.push(filters.variantId);
    clauses.push(`i.variant_id = $${values.length}`);
  }
  if (filters.categoryId) { values.push(filters.categoryId); clauses.push(`p.category_id = $${values.length}`); }
  if (filters.brandId) { values.push(filters.brandId); clauses.push(`p.brand_id = $${values.length}`); }
  return { where: clauses.join(" AND "), values };
}

export interface InventoryFilters {
  page?: number;
  pageSize?: number;
  search?: string;
  warehouseId?: string;
  lifecycle?: "active" | "inactive" | "all";
  status?: "out" | "low" | "in_stock";
  productId?: string;
  variantId?: string;
  categoryId?: string;
  brandId?: string;
  sort?: "updated" | "sku" | "available" | "on_hand";
  direction?: "asc" | "desc";
}

const sortColumns: Record<string, string> = {
  updated: "i.updated_at",
  sku: "COALESCE(pv.sku, p.parent_sku)",
  available: "i.quantity_on_hand - i.quantity_reserved",
  on_hand: "i.quantity_on_hand",
};

const inventorySelect = `
  SELECT i.id, i.warehouse_id AS "warehouseId", w.name AS "warehouseName", w.code AS "warehouseCode",
         w.active AS "warehouseActive", i.product_id AS "productId", i.variant_id AS "variantId",
         COALESCE(pv.sku, p.parent_sku) AS sku, COALESCE(pv.barcode, p.barcode) AS barcode, COALESCE(pv.title, p.name) AS "itemName",
         p.brand_id AS "brandId", b.name AS "brandName", p.category_id AS "categoryId", c.name AS "categoryName",
         i.quantity_on_hand AS "quantityOnHand", i.quantity_reserved AS "quantityReserved",
         i.low_stock_threshold AS "lowStockThreshold", i.active, p.status AS "productStatus",
         (i.active = true AND p.status = 'active') AS "lifecycleActive", i.updated_at::text AS "updatedAt"
    FROM inventory i
    JOIN warehouses w ON w.id = i.warehouse_id
    LEFT JOIN product_variants pv ON pv.id = i.variant_id
    JOIN products p ON p.id = COALESCE(i.product_id, pv.product_id)
    JOIN categories c ON c.id = p.category_id
    LEFT JOIN brands b ON b.id = p.brand_id`;

export async function listInventory(filters: InventoryFilters = {}) {
  const pool = getDatabasePool();
  const page = Math.max(1, Math.floor(filters.page ?? 1));
  const pageSize = Math.min(100, Math.max(1, Math.floor(filters.pageSize ?? 25)));
  const { where, values } = inventoryFromClause(filters);
  const count = await pool.query<{ count: string }>(`SELECT count(*)::text AS count FROM inventory i JOIN warehouses w ON w.id = i.warehouse_id LEFT JOIN product_variants pv ON pv.id = i.variant_id JOIN products p ON p.id = COALESCE(i.product_id, pv.product_id) JOIN categories c ON c.id = p.category_id LEFT JOIN brands b ON b.id = p.brand_id WHERE ${where}`, values);
  const sort = sortColumns[filters.sort ?? "updated"] ?? sortColumns.updated;
  const direction = filters.direction === "asc" ? "ASC" : "DESC";
  const offset = (page - 1) * pageSize;
  const rows = await pool.query<Record<string, unknown>>(`${inventorySelect} WHERE ${where} ORDER BY ${sort} ${direction}, i.id LIMIT $${values.length + 1} OFFSET $${values.length + 2}`, [...values, pageSize, offset]);
  const total = Number(count.rows[0]?.count ?? 0);
  return { items: rows.rows.map(mapInventory), meta: { page, pageSize, total, hasNext: offset + rows.rows.length < total } };
}

export async function getInventoryItem(id: string) {
  const result = await getDatabasePool().query<Record<string, unknown>>(`${inventorySelect} WHERE i.id = $1`, [id]);
  const row = result.rows[0];
  if (!row) throw new AppError(404, "INVENTORY_NOT_FOUND", "The inventory record was not found.");
  return mapInventory(row);
}

export async function inventorySummary(filters: InventoryFilters = {}) {
  const { where, values } = inventoryFromClause(filters);
  const result = await getDatabasePool().query<{ skus: string; onHand: string; reserved: string; available: string; lowStock: string; outOfStock: string }>(
    `SELECT count(*)::text AS skus, COALESCE(sum(quantity_on_hand), 0)::text AS "onHand",
            COALESCE(sum(quantity_reserved), 0)::text AS reserved,
             COALESCE(sum(quantity_on_hand - quantity_reserved), 0)::text AS available,
             count(*) FILTER (WHERE quantity_on_hand - quantity_reserved > 0 AND quantity_on_hand - quantity_reserved <= low_stock_threshold)::text AS "lowStock",
             count(*) FILTER (WHERE quantity_on_hand - quantity_reserved <= 0)::text AS "outOfStock"
        FROM inventory i
        JOIN warehouses w ON w.id = i.warehouse_id
        LEFT JOIN product_variants pv ON pv.id = i.variant_id
        JOIN products p ON p.id = COALESCE(i.product_id, pv.product_id)
        JOIN categories c ON c.id = p.category_id
        LEFT JOIN brands b ON b.id = p.brand_id
       WHERE ${where}`,
    values,
  );
  const row = result.rows[0]!;
  return { skus: Number(row.skus), onHand: Number(row.onHand), reserved: Number(row.reserved), available: Number(row.available), lowStock: Number(row.lowStock), outOfStock: Number(row.outOfStock) };
}

export async function listWarehouses(includeInactive = true) {
  const result = await getDatabasePool().query(`SELECT id, name, code, country_code AS "countryCode", active, created_at AS "createdAt", updated_at AS "updatedAt" FROM warehouses ${includeInactive ? "" : "WHERE active = true"} ORDER BY active DESC, name`);
  return result.rows;
}

export async function inventoryLookups() {
  const pool = getDatabasePool();
  const [warehouses, categories, brands] = await Promise.all([
    listWarehouses(),
    pool.query("SELECT id, name FROM categories WHERE active = true ORDER BY name"),
    pool.query("SELECT id, name FROM brands WHERE active = true ORDER BY name"),
  ]);
  return { warehouses, categories: categories.rows, brands: brands.rows };
}

export async function listInventoryScopes(search = "") {
  const term = `%${search.trim()}%`;
  const result = await getDatabasePool().query(
    `SELECT p.id AS "productId", NULL::uuid AS "variantId", p.parent_sku AS sku, p.name AS name
       FROM products p WHERE NOT EXISTS (SELECT 1 FROM product_variants pv WHERE pv.product_id = p.id)
         AND ($1 = '%%' OR p.name ILIKE $1 OR p.parent_sku ILIKE $1 OR p.barcode ILIKE $1)
     UNION ALL
     SELECT pv.product_id, pv.id, pv.sku, p.name || ' · ' || pv.title
       FROM product_variants pv JOIN products p ON p.id = pv.product_id
      WHERE $1 = '%%' OR p.name ILIKE $1 OR pv.title ILIKE $1 OR pv.sku ILIKE $1 OR pv.barcode ILIKE $1
     ORDER BY name, sku LIMIT 100`,
    [term],
  );
  return result.rows;
}

export async function saveWarehouse(input: { name: string; code: string; countryCode: string; active: boolean }, id?: string) {
  const pool = getDatabasePool();
  try {
    if (id) {
      const result = await pool.query(`UPDATE warehouses SET name = $1, code = $2, country_code = $3, active = $4, updated_at = now() WHERE id = $5 RETURNING id`, [input.name.trim(), input.code.trim().toUpperCase(), input.countryCode.toUpperCase(), input.active, id]);
      if (!result.rowCount) throw new AppError(404, "WAREHOUSE_NOT_FOUND", "The warehouse was not found.");
      return id;
    }
    const result = await pool.query<{ id: string }>(`INSERT INTO warehouses (name, code, country_code, active) VALUES ($1, $2, $3, $4) RETURNING id`, [input.name.trim(), input.code.trim().toUpperCase(), input.countryCode.toUpperCase(), input.active]);
    return result.rows[0]!.id;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "23505") throw new AppError(409, "WAREHOUSE_CODE_EXISTS", "A warehouse with this code already exists.");
    throw error;
  }
}

async function assertScope(client: { query: (text: string, values?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }> }, scope: Scope) {
  const [productId, variantId] = scopeValues(scope);
  if (variantId) {
    const result = await client.query("SELECT product_id AS \"productId\" FROM product_variants WHERE id = $1", [variantId]);
    if (!result.rows[0]) throw new AppError(404, "VARIANT_NOT_FOUND", "The variant was not found.");
    return { productId: null, variantId };
  }
  const result = await client.query("SELECT id FROM products WHERE id = $1", [productId]);
  if (!result.rows[0]) throw new AppError(404, "PRODUCT_NOT_FOUND", "The product was not found.");
  return { productId, variantId: null };
}

export async function adjustStock(input: Scope & { warehouseId: string; delta: number; movementType: string; note?: string; createdBy?: string }) {
  if (!Number.isInteger(input.delta) || input.delta === 0) throw new AppError(400, "INVALID_STOCK_DELTA", "Stock adjustment must be a non-zero whole number.");
  if (["purchase", "return"].includes(input.movementType) && input.delta < 0) throw new AppError(400, "MOVEMENT_DIRECTION_INVALID", "Purchases and returns must increase stock.");
  if (["sale", "damage"].includes(input.movementType) && input.delta > 0) throw new AppError(400, "MOVEMENT_DIRECTION_INVALID", "Sales and damage must decrease stock.");
  const pool = getDatabasePool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const scope = await assertScope(client, input);
    const warehouse = await client.query("SELECT id, active FROM warehouses WHERE id = $1 FOR UPDATE", [input.warehouseId]);
    if (!warehouse.rows[0]) throw new AppError(404, "WAREHOUSE_NOT_FOUND", "The warehouse was not found.");
    if (!warehouse.rows[0].active) throw new AppError(400, "WAREHOUSE_INACTIVE", "Stock cannot be changed in an inactive warehouse.");
    const current = await client.query<any>(`SELECT id, quantity_on_hand AS "quantityOnHand", quantity_reserved AS "quantityReserved", low_stock_threshold AS "lowStockThreshold"
      FROM inventory WHERE warehouse_id = $1 AND product_id IS NOT DISTINCT FROM $2::uuid AND variant_id IS NOT DISTINCT FROM $3::uuid FOR UPDATE`, [input.warehouseId, scope.productId, scope.variantId]);
    const row = current.rows[0];
    const nextOnHand = Number(row?.quantityOnHand ?? 0) + input.delta;
    const reserved = Number(row?.quantityReserved ?? 0);
    if (nextOnHand < 0) throw new AppError(409, "INSUFFICIENT_STOCK", "This adjustment would create negative stock.");
    if (reserved > nextOnHand) throw new AppError(409, "RESERVED_STOCK_CONFLICT", "This adjustment would put stock below the reserved quantity.");
    let inventoryId: string;
    if (row) {
      await client.query("UPDATE inventory SET quantity_on_hand = $1, updated_at = now() WHERE id = $2", [nextOnHand, row.id]);
      inventoryId = row.id;
    } else {
      const inserted = await client.query<{ id: string }>(`INSERT INTO inventory (warehouse_id, product_id, variant_id, quantity_on_hand, quantity_reserved, low_stock_threshold) VALUES ($1, $2, $3, $4, 0, 0) RETURNING id`, [input.warehouseId, scope.productId, scope.variantId, nextOnHand]);
      inventoryId = inserted.rows[0]!.id;
    }
    await client.query(`INSERT INTO inventory_movements (warehouse_id, product_id, variant_id, movement_type, quantity, note, created_by)
      VALUES ($1, $2, $3, $4::movement_type, $5, $6, $7)`, [input.warehouseId, scope.productId, scope.variantId, input.movementType, input.delta, input.note ?? null, input.createdBy ?? null]);
    await client.query("COMMIT");
    return getInventoryItem(inventoryId);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function setInventoryThreshold(id: string, lowStockThreshold: number) {
  if (!Number.isInteger(lowStockThreshold) || lowStockThreshold < 0) throw new AppError(400, "INVALID_THRESHOLD", "The low-stock threshold must be a nonnegative whole number.");
  const result = await getDatabasePool().query(`UPDATE inventory SET low_stock_threshold = $1, updated_at = now() WHERE id = $2 RETURNING id`, [lowStockThreshold, id]);
  if (!result.rowCount) throw new AppError(404, "INVENTORY_NOT_FOUND", "The inventory record was not found.");
  return getInventoryItem(id);
}

export async function setInventoryActive(id: string, active: boolean) {
  const result = await getDatabasePool().query("UPDATE inventory SET active=$1,updated_at=now() WHERE id=$2 RETURNING id", [active, id]);
  if (!result.rowCount) throw new AppError(404, "INVENTORY_NOT_FOUND", "The inventory record was not found.");
  return getInventoryItem(id);
}

export async function setStockToZero(id: string, createdBy?: string) {
  const current = await getInventoryItem(id);
  if (current.quantityReserved > 0) throw new AppError(409, "RESERVED_STOCK_CONFLICT", `Cannot set stock to zero: ${current.quantityReserved} unit${current.quantityReserved === 1 ? " is" : "s are"} currently reserved.`);
  if (current.quantityOnHand === 0) return current;
  return adjustStock({
    warehouseId: current.warehouseId,
    productId: current.productId,
    variantId: current.variantId,
    delta: -current.quantityOnHand,
    movementType: "adjustment",
    note: "Stock set to zero by inventory lifecycle action",
    createdBy,
  });
}

export async function inventoryDeletionEligibility(id: string) {
  const pool = getDatabasePool();
  const row = (await pool.query<any>(`SELECT i.id,i.product_id AS "productId",i.variant_id AS "variantId",i.warehouse_id AS "warehouseId",
    i.quantity_on_hand AS "quantityOnHand",i.quantity_reserved AS "quantityReserved"
    FROM inventory i WHERE i.id=$1`, [id])).rows[0];
  if (!row) throw new AppError(404, "INVENTORY_NOT_FOUND", "The inventory record was not found.");
  const counts = (await pool.query<any>(`SELECT
    (SELECT count(*) FROM inventory_reservations WHERE inventory_id=$1 AND status='active')::int AS "activeReservations",
    (SELECT count(*) FROM inventory_reservations WHERE inventory_id=$1)::int AS reservations,
    (SELECT count(*) FROM inventory_movements WHERE warehouse_id=$2 AND product_id IS NOT DISTINCT FROM $3::uuid AND variant_id IS NOT DISTINCT FROM $4::uuid)::int AS movements,
    (SELECT count(*) FROM order_items WHERE product_id=$3::uuid AND variant_id IS NOT DISTINCT FROM $4::uuid)::int AS "orderHistory"`,
    [id, row.warehouseId, row.productId, row.variantId])).rows[0];
  const blockers: string[] = [];
  if (Number(row.quantityOnHand) !== 0) blockers.push(`Cannot delete: ${row.quantityOnHand} unit${Number(row.quantityOnHand) === 1 ? "" : "s"} remain on hand.`);
  if (Number(row.quantityReserved) !== 0) blockers.push(`Cannot delete: ${row.quantityReserved} unit${Number(row.quantityReserved) === 1 ? " is" : "s are"} currently reserved.`);
  if (counts.activeReservations) blockers.push(`Cannot delete: ${counts.activeReservations} active reservation${counts.activeReservations === 1 ? "" : "s"} exist.`);
  if (counts.reservations > counts.activeReservations) blockers.push("Cannot delete: inventory reservation history exists.");
  if (counts.movements) blockers.push("Cannot delete: inventory movement or transfer history exists.");
  if (counts.orderHistory) blockers.push("Cannot delete: this inventory scope has been used by an order.");
  return { eligible: blockers.length === 0, blockers };
}

export async function deleteInventoryRecord(id: string) {
  const client = await getDatabasePool().connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT id FROM inventory WHERE id=$1 FOR UPDATE", [id]);
    const eligibility = await inventoryDeletionEligibility(id);
    if (!eligibility.eligible) throw new AppError(409, "INVENTORY_DELETE_BLOCKED", eligibility.blockers.join(" "));
    const deleted = await client.query("DELETE FROM inventory WHERE id=$1 RETURNING id", [id]);
    if (!deleted.rowCount) throw new AppError(404, "INVENTORY_NOT_FOUND", "The inventory record was not found.");
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function bulkSetInventoryThreshold(ids: string[], lowStockThreshold: number) {
  if (!ids.length) throw new AppError(400, "INVENTORY_IDS_REQUIRED", "Select at least one inventory record.");
  if (!Number.isInteger(lowStockThreshold) || lowStockThreshold < 0) throw new AppError(400, "INVALID_THRESHOLD", "The low-stock threshold must be a nonnegative whole number.");
  const result = await getDatabasePool().query("UPDATE inventory SET low_stock_threshold = $1, updated_at = now() WHERE id = ANY($2::uuid[])", [lowStockThreshold, ids]);
  return result.rowCount ?? 0;
}

export async function transferStock(input: Scope & { fromWarehouseId: string; toWarehouseId: string; quantity: number; note?: string; createdBy?: string }) {
  if (!Number.isInteger(input.quantity) || input.quantity <= 0) throw new AppError(400, "INVALID_TRANSFER_QUANTITY", "Transfer quantity must be a positive whole number.");
  if (input.fromWarehouseId === input.toWarehouseId) throw new AppError(400, "TRANSFER_SAME_WAREHOUSE", "Choose two different warehouses.");
  const pool = getDatabasePool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const scope = await assertScope(client, input);
    const warehouses = await client.query<any>("SELECT id, active FROM warehouses WHERE id IN ($1, $2) ORDER BY id FOR UPDATE", [input.fromWarehouseId, input.toWarehouseId]);
    if (warehouses.rows.length !== 2) throw new AppError(404, "WAREHOUSE_NOT_FOUND", "Both warehouses must exist.");
    if (warehouses.rows.some((warehouse) => !warehouse.active)) throw new AppError(400, "WAREHOUSE_INACTIVE", "Transfers require two active warehouses.");
    const rows = await client.query<any>(`SELECT id, warehouse_id AS "warehouseId", quantity_on_hand AS "quantityOnHand", quantity_reserved AS "quantityReserved", low_stock_threshold AS "lowStockThreshold", active
      FROM inventory WHERE warehouse_id IN ($1, $2) AND product_id IS NOT DISTINCT FROM $3::uuid AND variant_id IS NOT DISTINCT FROM $4::uuid ORDER BY warehouse_id FOR UPDATE`, [input.fromWarehouseId, input.toWarehouseId, scope.productId, scope.variantId]);
    const source = rows.rows.find((row) => row.warehouseId === input.fromWarehouseId);
    const target = rows.rows.find((row) => row.warehouseId === input.toWarehouseId);
    if (!source || source.active === false || Number(source.quantityOnHand) - Number(source.quantityReserved) < input.quantity) throw new AppError(409, "INSUFFICIENT_STOCK", "There is not enough active available stock to transfer.");
    await client.query("UPDATE inventory SET quantity_on_hand = quantity_on_hand - $1, updated_at = now() WHERE id = $2", [input.quantity, source.id]);
    if (target) {
      await client.query("UPDATE inventory SET quantity_on_hand = quantity_on_hand + $1, updated_at = now() WHERE id = $2", [input.quantity, target.id]);
    } else {
      await client.query(`INSERT INTO inventory (warehouse_id, product_id, variant_id, quantity_on_hand, quantity_reserved, low_stock_threshold) VALUES ($1, $2, $3, $4, 0, 0)`, [input.toWarehouseId, scope.productId, scope.variantId, input.quantity]);
    }
    for (const [warehouseId, type] of [[input.fromWarehouseId, "transfer_out"], [input.toWarehouseId, "transfer_in"]] as const) {
      await client.query(`INSERT INTO inventory_movements (warehouse_id, product_id, variant_id, movement_type, quantity, note, created_by) VALUES ($1, $2, $3, $4::movement_type, $5, $6, $7)`, [warehouseId, scope.productId, scope.variantId, type, input.quantity, input.note ?? null, input.createdBy ?? null]);
    }
    await client.query("COMMIT");
    return { from: await getInventoryForScope(input.fromWarehouseId, scope), to: await getInventoryForScope(input.toWarehouseId, scope) };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function getInventoryForScope(warehouseId: string, scope: Scope) {
  const [productId, variantId] = scopeValues(scope);
  const result = await getDatabasePool().query<Record<string, unknown>>(`${inventorySelect} WHERE i.warehouse_id = $1 AND i.product_id IS NOT DISTINCT FROM $2::uuid AND i.variant_id IS NOT DISTINCT FROM $3::uuid`, [warehouseId, productId, variantId]);
  return result.rows[0] ? mapInventory(result.rows[0]) : null;
}

export async function listMovements(filters: { page?: number; pageSize?: number; warehouseId?: string; search?: string; movementType?: string }) {
  const pool = getDatabasePool();
  const page = Math.max(1, Math.floor(filters.page ?? 1));
  const pageSize = Math.min(100, Math.max(1, Math.floor(filters.pageSize ?? 25)));
  const clauses = ["1 = 1"];
  const values: unknown[] = [];
  if (filters.warehouseId) { values.push(filters.warehouseId); clauses.push(`im.warehouse_id = $${values.length}`); }
  if (filters.movementType) { values.push(filters.movementType); clauses.push(`im.movement_type = $${values.length}::movement_type`); }
  if (filters.search?.trim()) { values.push(`%${filters.search.trim()}%`); clauses.push(`(w.name ILIKE $${values.length} OR w.code ILIKE $${values.length} OR p.name ILIKE $${values.length} OR p.parent_sku ILIKE $${values.length} OR pv.sku ILIKE $${values.length})`); }
  const where = clauses.join(" AND ");
  const count = await pool.query<{ count: string }>(`SELECT count(*)::text AS count FROM inventory_movements im JOIN warehouses w ON w.id = im.warehouse_id LEFT JOIN products p ON p.id = im.product_id LEFT JOIN product_variants pv ON pv.id = im.variant_id WHERE ${where}`, values);
  const offset = (page - 1) * pageSize;
  const rows = await pool.query(`SELECT im.id, im.warehouse_id AS "warehouseId", w.name AS "warehouseName", w.code AS "warehouseCode", im.product_id AS "productId", im.variant_id AS "variantId", COALESCE(pv.sku, p.parent_sku) AS sku, COALESCE(pv.title, p.name) AS "itemName", im.movement_type AS "movementType", im.quantity, im.reference_type AS "referenceType", im.reference_id AS "referenceId", im.note, im.created_at AS "createdAt" FROM inventory_movements im JOIN warehouses w ON w.id = im.warehouse_id LEFT JOIN products p ON p.id = im.product_id LEFT JOIN product_variants pv ON pv.id = im.variant_id WHERE ${where} ORDER BY im.created_at DESC, im.id LIMIT $${values.length + 1} OFFSET $${values.length + 2}`, [...values, pageSize, offset]);
  const total = Number(count.rows[0]?.count ?? 0);
  return { items: rows.rows, meta: { page, pageSize, total, hasNext: offset + rows.rows.length < total } };
}