import type { PoolClient } from "pg";
import { getDatabasePool } from "../db/client.js";

export interface TooniesReferenceReconciliationResult {
  suppliersAdded: number;
  warehousesAdded: number;
  unchanged: number;
}

export interface StaleTooniesSyncReconciliationResult {
  runsAbandoned: number;
}

type SupplierRow = {
  id: string;
  name: string;
  slug: string;
  active: boolean;
  publicationEnabled: boolean;
  complianceExcluded: boolean;
};

type WarehouseRow = {
  id: string;
  name: string;
  code: string;
  countryCode: string | null;
  active: boolean;
};

const supplierReference = {
  id: "da9a5858-8f54-42aa-a9c1-c98efa4d2bcd",
  name: "Toonies",
  slug: "toonies",
  active: true,
  publicationEnabled: false,
  complianceExcluded: true,
} as const;

const warehouseReference = {
  id: "87b93bcc-0ec6-4a75-86ee-9db644ddb2a2",
  name: "Toonies Supplier",
  code: "TOONIES",
  countryCode: "CN",
  active: true,
} as const;

function supplierMatches(row: SupplierRow): boolean {
  return row.id === supplierReference.id
    && row.name === supplierReference.name
    && row.slug === supplierReference.slug
    && row.active === supplierReference.active
    && row.publicationEnabled === supplierReference.publicationEnabled
    && row.complianceExcluded === supplierReference.complianceExcluded;
}

function warehouseMatches(row: WarehouseRow): boolean {
  return row.id === warehouseReference.id
    && row.name === warehouseReference.name
    && row.code === warehouseReference.code
    && row.countryCode === warehouseReference.countryCode
    && row.active === warehouseReference.active;
}

async function reconcileWithClient(client: PoolClient): Promise<TooniesReferenceReconciliationResult> {
  await client.query("SET LOCAL lock_timeout = '10s'");
  await client.query("SET LOCAL statement_timeout = '20s'");
  await client.query("SELECT pg_advisory_xact_lock(hashtext('supplier:toonies'))");
  await client.query("SELECT pg_advisory_xact_lock(hashtext('warehouse:toonies'))");
  await client.query("LOCK TABLE suppliers IN SHARE ROW EXCLUSIVE MODE");
  await client.query("LOCK TABLE warehouses IN SHARE ROW EXCLUSIVE MODE");

  const supplierCandidates = await client.query<SupplierRow>(
    `SELECT id,name,slug,active,publication_enabled AS "publicationEnabled",
            compliance_excluded AS "complianceExcluded"
       FROM suppliers
      WHERE id=$1 OR lower(slug)=lower($2) OR lower(name)=lower($3)
      FOR UPDATE`,
    [supplierReference.id, supplierReference.slug, supplierReference.name],
  );
  if (supplierCandidates.rows.length > 1) {
    throw new Error("TOONIES_SUPPLIER_OWNERSHIP_CONFLICT");
  }
  const supplier = supplierCandidates.rows[0];
  if (supplier && !supplierMatches(supplier)) {
    throw new Error(`TOONIES_SUPPLIER_OWNERSHIP_CONFLICT: ${supplier.id}`);
  }

  const warehouseCandidates = await client.query<WarehouseRow>(
    `SELECT id,name,code,country_code AS "countryCode",active
       FROM warehouses
      WHERE id=$1 OR lower(code)=lower($2) OR lower(name)=lower($3)
      FOR UPDATE`,
    [warehouseReference.id, warehouseReference.code, warehouseReference.name],
  );
  if (warehouseCandidates.rows.length > 1) {
    throw new Error("TOONIES_WAREHOUSE_OWNERSHIP_CONFLICT");
  }
  const warehouse = warehouseCandidates.rows[0];
  if (warehouse && !warehouseMatches(warehouse)) {
    throw new Error(`TOONIES_WAREHOUSE_OWNERSHIP_CONFLICT: ${warehouse.id}`);
  }

  let suppliersAdded = 0;
  let warehousesAdded = 0;
  let unchanged = 0;
  if (!supplier) {
    const inserted = await client.query<SupplierRow>(
      `INSERT INTO suppliers
         (id,name,slug,active,publication_enabled,compliance_excluded)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING id,name,slug,active,publication_enabled AS "publicationEnabled",
                 compliance_excluded AS "complianceExcluded"`,
      [
        supplierReference.id,
        supplierReference.name,
        supplierReference.slug,
        supplierReference.active,
        supplierReference.publicationEnabled,
        supplierReference.complianceExcluded,
      ],
    );
    if (!inserted.rows[0] || !supplierMatches(inserted.rows[0])) {
      throw new Error("TOONIES_SUPPLIER_POSTCONDITION_CONFLICT");
    }
    suppliersAdded = 1;
  } else {
    unchanged += 1;
  }

  if (!warehouse) {
    const inserted = await client.query<WarehouseRow>(
      `INSERT INTO warehouses (id,name,code,country_code,active)
       VALUES ($1,$2,$3,$4,$5)
       RETURNING id,name,code,country_code AS "countryCode",active`,
      [
        warehouseReference.id,
        warehouseReference.name,
        warehouseReference.code,
        warehouseReference.countryCode,
        warehouseReference.active,
      ],
    );
    if (!inserted.rows[0] || !warehouseMatches(inserted.rows[0])) {
      throw new Error("TOONIES_WAREHOUSE_POSTCONDITION_CONFLICT");
    }
    warehousesAdded = 1;
  } else {
    unchanged += 1;
  }

  return { suppliersAdded, warehousesAdded, unchanged };
}

export async function reconcileTooniesReferenceData(): Promise<TooniesReferenceReconciliationResult> {
  const ownedClient = await getDatabasePool().connect();
  try {
    await ownedClient.query("BEGIN");
    const result = await reconcileWithClient(ownedClient);
    await ownedClient.query("COMMIT");
    return result;
  } catch (error) {
    await ownedClient.query("ROLLBACK");
    throw error;
  } finally {
    ownedClient.release();
  }
}

/**
 * Transaction-scoped test and composition entry point. The caller must already
 * own the surrounding transaction; production startup uses the safe wrapper.
 */
export async function reconcileTooniesReferenceDataInTransaction(
  client: PoolClient,
): Promise<TooniesReferenceReconciliationResult> {
  return reconcileWithClient(client);
}

export async function reconcileStaleTooniesSyncRuns(): Promise<StaleTooniesSyncReconciliationResult> {
  const client = await getDatabasePool().connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('toonies:stale-sync-reconciliation'))");
    const liveLease = await client.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_xact_lock(hashtext('toonies:sync-supplier'),hashtext($1)) AS acquired",
      [supplierReference.id],
    );
    if (liveLease.rows[0]?.acquired !== true) {
      await client.query("COMMIT");
      return { runsAbandoned: 0 };
    }
    const stale = await client.query<{ id: string }>(
      `SELECT id
         FROM supplier_sync_runs
        WHERE supplier_id=$1
          AND operation='catalogue'
          AND status='running'
          AND updated_at < now() - interval '15 minutes'
        FOR UPDATE`,
      [supplierReference.id],
    );
    const ids = stale.rows.map((row) => row.id);
    if (ids.length) {
      await client.query(
        `UPDATE supplier_fx_normalization_runs
            SET status='failed',error_code='STALE_SYNC_ABANDONED',
                error_message='Historical synchronization was abandoned after its worker ended.',
                completed_at=COALESCE(completed_at,now()),updated_at=now()
          WHERE supplier_sync_run_id=ANY($1::uuid[]) AND status='running'`,
        [ids],
      );
      await client.query(
        `UPDATE supplier_sync_runs
            SET status='failed',error_count=error_count+1,error_code='STALE_SYNC_ABANDONED',
                error_message='Historical synchronization was abandoned after its worker ended.',
                completed_at=COALESCE(completed_at,now()),updated_at=now()
          WHERE id=ANY($1::uuid[]) AND status='running'`,
        [ids],
      );
    }
    await client.query("COMMIT");
    return { runsAbandoned: ids.length };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}