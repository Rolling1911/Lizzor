import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import { auditSecurityEvent, canUser } from "../auth/service.js";
import { requireAdmin, requireCsrf, requirePermission } from "../middleware/auth.js";
import { AppError } from "../middleware/error-handler.js";
import { adjustStock, bulkSetInventoryThreshold, deleteInventoryRecord, getInventoryItem, inventoryDeletionEligibility, inventoryLookups, inventorySummary, listInventory, listInventoryScopes, listMovements, listWarehouses, saveWarehouse, setInventoryActive, setInventoryThreshold, setStockToZero, transferStock } from "../inventory/service.js";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1 } });
const movementTypes = ["purchase", "sale", "return", "damage", "adjustment"] as const;
const warehouseSchema = z.object({ name: z.string().trim().min(1).max(150), code: z.string().trim().min(1).max(50), countryCode: z.string().trim().length(2), active: z.boolean().default(true) });
const adjustmentSchema = z.object({
  warehouseId: z.string().uuid(),
  productId: z.string().uuid().nullable().optional(),
  variantId: z.string().uuid().nullable().optional(),
  delta: z.number().int().refine((value) => value !== 0),
  movementType: z.enum(movementTypes).default("adjustment"),
  note: z.string().trim().max(500).optional(),
});
const transferSchema = z.object({
  fromWarehouseId: z.string().uuid(),
  toWarehouseId: z.string().uuid(),
  productId: z.string().uuid().nullable().optional(),
  variantId: z.string().uuid().nullable().optional(),
  quantity: z.number().int().positive(),
  note: z.string().trim().max(500).optional(),
});

function middleware(permission: string) { return [requireAdmin, requirePermission(permission)]; }
function mutation(permission: string) { return [requireCsrf, requireAdmin, requirePermission(permission)]; }
function parsed<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new AppError(400, "VALIDATION_ERROR", "The request could not be validated.", result.error.flatten());
  return result.data;
}
function q(value: unknown): string | undefined { return typeof value === "string" && value.trim() ? value : undefined; }
function lifecycle(value: unknown): "active" | "inactive" | "all" {
  const parsed = value === undefined ? "active" : q(value);
  if (parsed === "active" || parsed === "inactive" || parsed === "all") return parsed;
  throw new AppError(400, "INVALID_INVENTORY_LIFECYCLE", "Inventory lifecycle must be active, inactive, or all.");
}
function idParam(value: string | string[]): string {
  if (Array.isArray(value) || !value) throw new AppError(400, "INVALID_ID", "A valid identifier is required.");
  return value;
}
function page(value: unknown, fallback: number) { const number = value === undefined ? fallback : Number(value); if (!Number.isInteger(number) || number < 1) throw new AppError(400, "INVALID_PAGINATION", "Pagination values must be positive integers."); return number; }
async function audit(request: Parameters<typeof requireAdmin>[0], action: string, entityType: string, entityId?: string) {
  if (request.auth) await auditSecurityEvent({ actorUserId: request.auth.userId, action, entityType, entityId, request });
}

function parseCsv(buffer: Buffer): Array<Record<string, string>> {
  const text = buffer.toString("utf8").replace(/^\uFEFF/, "");
  const rows: string[][] = [];
  let row: string[] = [], cell = "", quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    if (character === "\"") {
      if (quoted && text[index + 1] === "\"") { cell += "\""; index += 1; } else quoted = !quoted;
    } else if (character === "," && !quoted) { row.push(cell.trim()); cell = ""; }
    else if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && text[index + 1] === "\n") index += 1;
      row.push(cell.trim()); if (row.some(Boolean)) rows.push(row); row = []; cell = "";
    } else cell += character;
  }
  if (cell || row.length) { row.push(cell.trim()); if (row.some(Boolean)) rows.push(row); }
  const headers = rows.shift()?.map((header) => header.toLowerCase()) ?? [];
  return rows.map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""])));
}

export const inventoryRouter = Router();

inventoryRouter.get("/admin/inventory", ...middleware("inventory.view"), async (request, response) => {
  const filters = {
    page: page(request.query.page, 1), pageSize: request.query.pageSize === undefined ? 25 : page(request.query.pageSize, 25),
    search: q(request.query.search), warehouseId: q(request.query.warehouseId), productId: q(request.query.productId), variantId: q(request.query.variantId),
    categoryId: q(request.query.categoryId), brandId: q(request.query.brandId),
    lifecycle: lifecycle(request.query.lifecycle),
    status: q(request.query.status) as "out" | "low" | "in_stock" | undefined, sort: q(request.query.sort) as "updated" | "sku" | "available" | "on_hand" | undefined,
    direction: q(request.query.direction) === "asc" ? "asc" as const : "desc" as const,
  };
  response.json({ data: { ...(await listInventory(filters)), summary: await inventorySummary(filters) } });
});

inventoryRouter.get("/admin/inventory/export", ...middleware("inventory.export"), async (request, response) => {
  const rows = [];
  for (let exportPage = 1; exportPage <= 10000; exportPage += 1) {
    const result = await listInventory({ search: q(request.query.search), warehouseId: q(request.query.warehouseId), categoryId: q(request.query.categoryId), brandId: q(request.query.brandId), lifecycle: lifecycle(request.query.lifecycle), status: q(request.query.status) as "out" | "low" | "in_stock" | undefined, page: exportPage, pageSize: 100 });
    rows.push(...result.items);
    if (!result.meta.hasNext) break;
  }
  const headers = ["warehouse_code", "warehouse_name", "sku", "item_name", "quantity_on_hand", "quantity_reserved", "available", "low_stock_threshold", "status", "updated_at"];
  const cell = (value: unknown) => { const text = value === null || value === undefined ? "" : String(value); return /[",\n]/.test(text) ? `"${text.replaceAll("\"", "\"\"")}"` : text; };
  const lines = [headers.join(","), ...rows.map((item) => [item.warehouseCode, item.warehouseName, item.sku, item.itemName, item.quantityOnHand, item.quantityReserved, item.available, item.lowStockThreshold, item.status, item.updatedAt].map(cell).join(","))];
  response.setHeader("content-type", "text/csv; charset=utf-8");
  response.setHeader("content-disposition", "attachment; filename=\"lizzor-inventory.csv\"");
  response.send(`${lines.join("\n")}\n`);
});

inventoryRouter.get("/admin/inventory/movements", ...middleware("inventory.view"), async (request, response) => {
  response.json({ data: await listMovements({ page: page(request.query.page, 1), pageSize: page(request.query.pageSize, 25), warehouseId: q(request.query.warehouseId), search: q(request.query.search), movementType: q(request.query.movementType) }) });
});

inventoryRouter.get("/admin/inventory/lookups", ...middleware("inventory.view"), async (_request, response) => {
  response.json({ data: await inventoryLookups() });
});

inventoryRouter.get("/admin/inventory/scopes", ...middleware("inventory.view"), async (request, response) => {
  response.json({ data: await listInventoryScopes(q(request.query.search) ?? "") });
});

inventoryRouter.get("/admin/inventory/:id", ...middleware("inventory.view"), async (request, response) => {
  response.json({ data: await getInventoryItem(idParam(request.params.id)) });
});

inventoryRouter.patch("/admin/inventory/:id", ...mutation("inventory.edit"), async (request, response) => {
  const input = parsed(z.object({ lowStockThreshold: z.number().int().min(0) }), request.body);
  const id = idParam(request.params.id);
  const item = await setInventoryThreshold(id, input.lowStockThreshold);
  await audit(request, "inventory.threshold_updated", "inventory", id);
  response.json({ data: item });
});

inventoryRouter.post("/admin/inventory/:id/zero", ...mutation("inventory.adjust"), async (request, response) => {
  const id = idParam(request.params.id);
  const item = await setStockToZero(id, request.auth!.userId);
  await audit(request, "inventory.stock_zeroed", "inventory", id);
  response.json({ data: item });
});

inventoryRouter.patch("/admin/inventory/:id/status", ...mutation("inventory.edit"), async (request, response) => {
  const id = idParam(request.params.id);
  const input = parsed(z.object({ active: z.boolean() }), request.body);
  const item = await setInventoryActive(id, input.active);
  await audit(request, input.active ? "inventory.reactivated" : "inventory.deactivated", "inventory", id);
  response.json({ data: item });
});

inventoryRouter.get("/admin/inventory/:id/deletion-eligibility", ...middleware("inventory.delete"), async (request, response) => {
  response.json({ data: await inventoryDeletionEligibility(idParam(request.params.id)) });
});

inventoryRouter.delete("/admin/inventory/:id", ...mutation("inventory.delete"), async (request, response) => {
  const id = idParam(request.params.id);
  const input = parsed(z.object({ confirmation: z.literal("DELETE") }), request.body);
  void input;
  await deleteInventoryRecord(id);
  await audit(request, "inventory.deleted", "inventory", id);
  response.status(204).end();
});

inventoryRouter.post("/admin/inventory/adjust", ...mutation("inventory.adjust"), async (request, response) => {
  const input = parsed(adjustmentSchema, request.body);
  const item = await adjustStock({ ...input, createdBy: request.auth!.userId });
  await audit(request, "inventory.stock_adjusted", "inventory", item.id);
  response.status(201).json({ data: item });
});

inventoryRouter.post("/admin/inventory/transfer", ...mutation("inventory.transfer"), async (request, response) => {
  const input = parsed(transferSchema, request.body);
  const result = await transferStock({ ...input, createdBy: request.auth!.userId });
  await audit(request, "inventory.stock_transferred", "inventory");
  response.status(201).json({ data: result });
});

inventoryRouter.post("/admin/inventory/bulk-threshold", ...mutation("inventory.edit"), async (request, response) => {
  const input = parsed(z.object({ ids: z.array(z.string().uuid()).min(1).max(1000), lowStockThreshold: z.number().int().min(0) }), request.body);
  const updated = await bulkSetInventoryThreshold(input.ids, input.lowStockThreshold);
  await audit(request, "inventory.thresholds_bulk_updated", "inventory");
  response.json({ data: { updated } });
});

inventoryRouter.get("/admin/warehouses", ...middleware("warehouse.view"), async (_request, response) => {
  response.json({ data: await listWarehouses() });
});

inventoryRouter.post("/admin/warehouses", ...mutation("warehouse.manage"), async (request, response) => {
  const id = await saveWarehouse(parsed(warehouseSchema, request.body));
  await audit(request, "inventory.warehouse_created", "warehouse", id);
  response.status(201).json({ data: { id } });
});

inventoryRouter.patch("/admin/warehouses/:id", ...mutation("warehouse.manage"), async (request, response) => {
  const id = await saveWarehouse(parsed(warehouseSchema, request.body), idParam(request.params.id));
  await audit(request, "inventory.warehouse_updated", "warehouse", id);
  response.json({ data: { id } });
});

inventoryRouter.post("/admin/inventory/import", ...mutation("inventory.import"), upload.single("file"), async (request, response) => {
  if (!request.file) throw new AppError(400, "IMPORT_FILE_REQUIRED", "Choose a CSV file to import.");
  const rows = parseCsv(request.file.buffer);
  if (!rows.length) throw new AppError(400, "IMPORT_EMPTY", "The inventory CSV has no rows.");
  const warehouses = await listWarehouses();
  const warehouseByCode = new Map(warehouses.map((warehouse: any) => [String(warehouse.code).toUpperCase(), warehouse.id]));
  const pool = (await import("../db/client.js")).getDatabasePool();
  const errors: Array<{ row: number; message: string }> = [];
  let imported = 0;
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]!;
    try {
      const warehouseId = warehouseByCode.get(row.warehouse_code?.toUpperCase());
      if (!warehouseId) throw new Error("Warehouse code was not found.");
      const delta = Number(row.quantity_delta);
      if (!Number.isInteger(delta) || delta === 0) throw new Error("quantity_delta must be a non-zero whole number.");
      const skuResult = await pool.query("SELECT p.id AS \"productId\", NULL::uuid AS \"variantId\" FROM products p WHERE p.parent_sku = $1 UNION ALL SELECT pv.product_id AS \"productId\", pv.id AS \"variantId\" FROM product_variants pv WHERE pv.sku = $1", [row.sku]);
      if (skuResult.rows.length !== 1) throw new Error(skuResult.rows.length ? "SKU is ambiguous." : "SKU was not found.");
      const movementType = row.movement_type || "adjustment";
      if (!movementTypes.includes(movementType as any)) throw new Error("Unsupported movement_type.");
      await adjustStock({ warehouseId, productId: skuResult.rows[0].productId, variantId: skuResult.rows[0].variantId, delta, movementType, note: row.note, createdBy: request.auth!.userId });
      imported += 1;
    } catch (error) { errors.push({ row: index + 2, message: error instanceof Error ? error.message : "Row could not be imported." }); }
  }
  await audit(request, "inventory.import_completed", "inventory_import");
  response.json({ data: { imported, failed: errors, total: rows.length } });
});