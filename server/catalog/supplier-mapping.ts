import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { getDatabasePool } from "../db/client.js";
import { AppError } from "../middleware/error-handler.js";
import type { SupplierCategoryMappingBulk, SupplierCategoryMappingUpdate } from "./validation.js";

type MappingPatch = SupplierCategoryMappingUpdate;

function conflict(error: unknown): never {
  if (typeof error === "object" && error !== null && "code" in error && error.code === "23505") {
    throw new AppError(409, "SUPPLIER_MAPPING_CONFLICT", "That supplier category is already mapped.");
  }
  throw error;
}

async function validateTargets(client: PoolClient, rootCategoryId: string | null | undefined, childCategoryId: string | null | undefined): Promise<void> {
  if (childCategoryId && !rootCategoryId) throw new AppError(400, "MAPPING_ROOT_REQUIRED", "A root category is required when selecting a child category.");
  if (!rootCategoryId) return;
  const root = await client.query<{ parentId: string | null; active: boolean }>(
    "SELECT parent_id AS \"parentId\", active FROM categories WHERE id=$1",
    [rootCategoryId],
  );
  if (!root.rows[0]) throw new AppError(400, "MAPPING_ROOT_NOT_FOUND", "The selected root category does not exist.");
  if (root.rows[0].parentId) throw new AppError(400, "MAPPING_ROOT_INVALID", "The selected root category must be a root category.");
  if (!root.rows[0].active) throw new AppError(400, "MAPPING_ROOT_INACTIVE", "The selected root category must be active.");
  if (childCategoryId) {
    const child = await client.query<{ parentId: string | null; active: boolean }>(
      "SELECT parent_id AS \"parentId\", active FROM categories WHERE id=$1",
      [childCategoryId],
    );
    if (!child.rows[0]) throw new AppError(400, "MAPPING_CHILD_NOT_FOUND", "The selected child category does not exist.");
    if (child.rows[0].parentId !== rootCategoryId) throw new AppError(400, "MAPPING_CATEGORY_MISMATCH", "The child category does not belong to the selected root.");
    if (!child.rows[0].active) throw new AppError(400, "MAPPING_CHILD_INACTIVE", "The selected child category must be active.");
  }
}

async function validatePublication(
  client: PoolClient,
  supplierId: string,
  rootCategoryId: string | null,
  childCategoryId: string | null,
  status: string,
  publicationEnabled: boolean,
  complianceExcluded: boolean,
): Promise<void> {
  if (!publicationEnabled) return;
  if (complianceExcluded) {
    throw new AppError(400, "MAPPING_COMPLIANCE_REQUIRED", "Supplier categories remain excluded from publication until compliance exclusion is explicitly cleared.");
  }
  if (status !== "mapped" || !rootCategoryId) {
    throw new AppError(400, "MAPPING_PUBLICATION_TARGET_INVALID", "Published mappings require a mapped active category target.");
  }
  const supplier = await client.query<{ active: boolean; publicationEnabled: boolean }>(
    `SELECT active, publication_enabled AS "publicationEnabled" FROM suppliers WHERE id=$1`,
    [supplierId],
  );
  if (!supplier.rows[0]?.active || !supplier.rows[0]?.publicationEnabled) {
    throw new AppError(400, "MAPPING_SUPPLIER_NOT_PUBLISHABLE", "Published mappings require an active publication-enabled supplier.");
  }
}

function safety(patch: MappingPatch): void {
  if (patch.status === "mapped" && patch.rootCategoryId === null) {
    throw new AppError(400, "MAPPING_ROOT_REQUIRED", "A mapped supplier category requires a root category.");
  }
}

async function snapshot(client: PoolClient, id: string): Promise<Record<string, unknown> | null> {
  const result = await client.query<Record<string, unknown>>(
    `SELECT id, supplier_id AS "supplierId", external_category_id AS "externalCategoryId",
            external_category_name AS "externalCategoryName", external_category_path AS "externalCategoryPath",
            root_category_id AS "rootCategoryId", child_category_id AS "childCategoryId",
            status, publication_enabled AS "publicationEnabled", compliance_excluded AS "complianceExcluded",
            metadata, last_mapped_by AS "lastMappedBy", last_mapped_at AS "lastMappedAt"
       FROM supplier_category_mappings WHERE id=$1 FOR UPDATE`,
    [id],
  );
  return result.rows[0] ?? null;
}

async function updateOne(client: PoolClient, id: string, patch: MappingPatch, actorUserId: string, action: "manual" | "bulk", bulkOperationId?: string): Promise<void> {
  const before = await snapshot(client, id);
  if (!before) throw new AppError(404, "SUPPLIER_MAPPING_NOT_FOUND", "The supplier category mapping was not found.");
  const root = patch.rootCategoryId === undefined ? before.rootCategoryId as string | null : patch.rootCategoryId;
  const child = patch.childCategoryId === undefined ? before.childCategoryId as string | null : patch.childCategoryId;
  await validateTargets(client, root, child);
  safety({ ...patch, rootCategoryId: root });
  const status = patch.status ?? String(before.status);
  const publicationEnabled = patch.publicationEnabled ?? Boolean(before.publicationEnabled);
  const complianceExcluded = patch.complianceExcluded ?? Boolean(before.complianceExcluded);
  await validatePublication(client, String(before.supplierId), root, child, status, publicationEnabled, complianceExcluded);
  if (status === "mapped" && !root) throw new AppError(400, "MAPPING_ROOT_REQUIRED", "A mapped supplier category requires a root category.");
  await client.query(
    `UPDATE supplier_category_mappings
        SET root_category_id=$1, child_category_id=$2, status=$3, publication_enabled=$4,
            compliance_excluded=$5, last_mapped_by=$6, last_mapped_at=now(), updated_at=now()
      WHERE id=$7`,
    [root, child, status, publicationEnabled, complianceExcluded, actorUserId, id],
  );
  const after = await snapshot(client, id);
  await client.query(
    `INSERT INTO supplier_category_mapping_history
      (mapping_id, action, previous_snapshot, next_snapshot, actor_user_id, bulk_operation_id, reason)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [id, action, before, after, actorUserId, bulkOperationId ?? null, patch.reason ?? null],
  );
}

export async function listSupplierCategoryMappings(filters: {
  page?: number;
  pageSize?: number;
  id?: string;
  supplierId?: string;
  status?: string;
  search?: string;
}) {
  const page = Math.max(1, Math.floor(filters.page ?? 1));
  const pageSize = Math.min(100, Math.max(1, Math.floor(filters.pageSize ?? 25)));
  const values: unknown[] = [];
  const clauses = ["1=1"];
  if (filters.id) { values.push(filters.id); clauses.push(`m.id=$${values.length}`); }
  if (filters.supplierId) { values.push(filters.supplierId); clauses.push(`m.supplier_id=$${values.length}`); }
  if (filters.status) { values.push(filters.status); clauses.push(`m.status=$${values.length}`); }
  if (filters.search?.trim()) {
    values.push(`%${filters.search.trim()}%`);
    clauses.push(`(m.external_category_id ILIKE $${values.length} OR m.external_category_name ILIKE $${values.length} OR m.external_category_path ILIKE $${values.length})`);
  }
  const pool = getDatabasePool();
  const count = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM supplier_category_mappings m WHERE ${clauses.join(" AND ")}`, values,
  );
  values.push(pageSize, (page - 1) * pageSize);
  const rows = await pool.query(
    `SELECT m.id, m.supplier_id AS "supplierId", s.name AS "supplierName", s.slug AS "supplierSlug",
            m.external_category_id AS "externalCategoryId", m.external_category_name AS "externalCategoryName",
            m.external_category_path AS "externalCategoryPath", m.root_category_id AS "rootCategoryId",
            root.name AS "rootCategoryName", m.child_category_id AS "childCategoryId",
            child.name AS "childCategoryName", m.status, m.publication_enabled AS "publicationEnabled",
            m.compliance_excluded AS "complianceExcluded", m.metadata,
            m.last_mapped_by AS "lastMappedBy", m.last_mapped_at AS "lastMappedAt",
            m.created_at AS "createdAt", m.updated_at AS "updatedAt"
       FROM supplier_category_mappings m
       JOIN suppliers s ON s.id=m.supplier_id
       LEFT JOIN categories root ON root.id=m.root_category_id
       LEFT JOIN categories child ON child.id=m.child_category_id
      WHERE ${clauses.join(" AND ")}
      ORDER BY m.updated_at DESC, m.id
      LIMIT $${values.length - 1} OFFSET $${values.length}`,
    values,
  );
  const total = Number(count.rows[0]?.count ?? 0);
  return { items: rows.rows, meta: { page, pageSize, total, hasNext: page * pageSize < total } };
}

export async function listSupplierMappingCategoryOptions(): Promise<Array<Record<string, unknown>>> {
  const result = await getDatabasePool().query(
    `SELECT c.id, c.parent_id AS "parentId", c.name, c.slug,
            c.canonical_key AS "canonicalKey", c.active,
            root.name AS "rootName"
       FROM categories c
       LEFT JOIN categories root ON root.id=c.parent_id
      WHERE c.active=true
        AND (c.parent_id IS NULL OR root.active=true)
      ORDER BY c.parent_id NULLS FIRST, c.sort_order, c.name`,
  );
  return result.rows;
}

export async function updateSupplierCategoryMapping(id: string, patch: MappingPatch, actorUserId: string): Promise<Record<string, unknown>> {
  const pool = getDatabasePool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await updateOne(client, id, patch, actorUserId, "manual");
    await client.query("COMMIT");
    const result = await listSupplierCategoryMappings({ page: 1, pageSize: 1, id });
    const item = result.items.find((row) => row.id === id);
    if (!item) throw new AppError(404, "SUPPLIER_MAPPING_NOT_FOUND", "The supplier category mapping was not found.");
    return item as Record<string, unknown>;
  } catch (error) {
    await client.query("ROLLBACK");
    conflict(error);
  } finally {
    client.release();
  }
}

export async function bulkUpdateSupplierCategoryMappings(input: SupplierCategoryMappingBulk, actorUserId: string): Promise<{ updated: number; bulkOperationId: string }> {
  const pool = getDatabasePool();
  const client = await pool.connect();
  const bulkOperationId = randomUUID();
  try {
    await client.query("BEGIN");
    const patch = { ...input };
    delete (patch as Partial<SupplierCategoryMappingBulk>).ids;
    const ids = [...new Set(input.ids)];
    for (const id of ids) await updateOne(client, id, patch as MappingPatch, actorUserId, "bulk", bulkOperationId);
    await client.query("COMMIT");
    return { updated: ids.length, bulkOperationId };
  } catch (error) {
    await client.query("ROLLBACK");
    conflict(error);
  } finally {
    client.release();
  }
}