import assert from "node:assert/strict";
import { getDatabasePool } from "../db/client.js";
import { reconcileTooniesReferenceDataInTransaction } from "./toonies-reference-reconciliation.js";

const client = await getDatabasePool().connect();
try {
  await client.query("BEGIN");
  await client.query(`CREATE TEMP TABLE suppliers (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name varchar(200) NOT NULL UNIQUE,
    slug varchar(180) NOT NULL UNIQUE,
    active boolean NOT NULL DEFAULT true,
    publication_enabled boolean NOT NULL DEFAULT false,
    compliance_excluded boolean NOT NULL DEFAULT true,
    updated_at timestamptz NOT NULL DEFAULT now()
  ) ON COMMIT DROP`);
  await client.query(`CREATE TEMP TABLE warehouses (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name varchar(200) NOT NULL,
    code varchar(80) NOT NULL UNIQUE,
    country_code varchar(2),
    active boolean NOT NULL DEFAULT true,
    updated_at timestamptz NOT NULL DEFAULT now()
  ) ON COMMIT DROP`);
  await client.query("CREATE UNIQUE INDEX ON warehouses(lower(name))");
  await client.query("CREATE TEMP TABLE supplier_catalogue_items (id uuid PRIMARY KEY DEFAULT gen_random_uuid()) ON COMMIT DROP");
  await client.query("CREATE TEMP TABLE supplier_category_mappings (id uuid PRIMARY KEY DEFAULT gen_random_uuid()) ON COMMIT DROP");
  await client.query("CREATE TEMP TABLE supplier_product_links (id uuid PRIMARY KEY DEFAULT gen_random_uuid()) ON COMMIT DROP");
  await client.query("CREATE TEMP TABLE supplier_sync_runs (id uuid PRIMARY KEY DEFAULT gen_random_uuid()) ON COMMIT DROP");
  await client.query("CREATE TEMP TABLE supplier_pricing_rules (id uuid PRIMARY KEY DEFAULT gen_random_uuid()) ON COMMIT DROP");

  const first = await reconcileTooniesReferenceDataInTransaction(client);
  assert.deepEqual(first, { suppliersAdded: 1, warehousesAdded: 1, unchanged: 0 });
  const supplier = (await client.query(
    `SELECT id,name,slug,active,publication_enabled AS "publicationEnabled",
            compliance_excluded AS "complianceExcluded",updated_at AS "updatedAt"
       FROM suppliers`,
  )).rows[0];
  assert.deepEqual(
    {
      name: supplier.name,
      slug: supplier.slug,
      active: supplier.active,
      publicationEnabled: supplier.publicationEnabled,
      complianceExcluded: supplier.complianceExcluded,
    },
    {
      name: "Toonies",
      slug: "toonies",
      active: true,
      publicationEnabled: false,
      complianceExcluded: true,
    },
  );
  assert.equal(supplier.id, "da9a5858-8f54-42aa-a9c1-c98efa4d2bcd");
  const warehouse = (await client.query(
    `SELECT id,name,code,country_code AS "countryCode",active,updated_at AS "updatedAt"
       FROM warehouses`,
  )).rows[0];
  assert.deepEqual(
    { name: warehouse.name, code: warehouse.code, countryCode: warehouse.countryCode, active: warehouse.active },
    { name: "Toonies Supplier", code: "TOONIES", countryCode: "CN", active: true },
  );
  assert.equal(warehouse.id, "87b93bcc-0ec6-4a75-86ee-9db644ddb2a2");

  const second = await reconcileTooniesReferenceDataInTransaction(client);
  assert.deepEqual(second, { suppliersAdded: 0, warehousesAdded: 0, unchanged: 2 });
  const unchanged = {
    supplier: (await client.query("SELECT id,updated_at FROM suppliers")).rows[0],
    warehouse: (await client.query("SELECT id,updated_at FROM warehouses")).rows[0],
  };
  assert.deepEqual(unchanged.supplier, { id: supplier.id, updated_at: supplier.updatedAt });
  assert.deepEqual(unchanged.warehouse, { id: warehouse.id, updated_at: warehouse.updatedAt });

  for (const table of [
    "supplier_catalogue_items",
    "supplier_category_mappings",
    "supplier_product_links",
    "supplier_sync_runs",
    "supplier_pricing_rules",
  ]) {
    assert.equal(Number((await client.query(`SELECT count(*) AS count FROM ${table}`)).rows[0].count), 0);
  }

  await client.query("SAVEPOINT supplier_conflict");
  await client.query("DELETE FROM suppliers");
  await client.query(
    `INSERT INTO suppliers(name,slug,active,publication_enabled,compliance_excluded)
     VALUES('Unexpected Owner','toonies',true,false,true)`,
  );
  await assert.rejects(reconcileTooniesReferenceDataInTransaction(client), /TOONIES_SUPPLIER_OWNERSHIP_CONFLICT/);
  await client.query("ROLLBACK TO SAVEPOINT supplier_conflict");

  await client.query("SAVEPOINT warehouse_conflict");
  await client.query("DELETE FROM warehouses");
  await client.query(
    `INSERT INTO warehouses(name,code,country_code,active)
     VALUES('Unexpected Warehouse','TOONIES','CN',true)`,
  );
  await assert.rejects(reconcileTooniesReferenceDataInTransaction(client), /TOONIES_WAREHOUSE_OWNERSHIP_CONFLICT/);
  await client.query("ROLLBACK TO SAVEPOINT warehouse_conflict");

  await client.query("SAVEPOINT supplier_uuid_conflict");
  await client.query("DELETE FROM suppliers");
  await client.query(
    `INSERT INTO suppliers(id,name,slug,active,publication_enabled,compliance_excluded)
     VALUES($1,'Unexpected UUID Owner','unexpected-supplier',true,false,true)`,
    ["da9a5858-8f54-42aa-a9c1-c98efa4d2bcd"],
  );
  await assert.rejects(reconcileTooniesReferenceDataInTransaction(client), /TOONIES_SUPPLIER_OWNERSHIP_CONFLICT/);
  await client.query("ROLLBACK TO SAVEPOINT supplier_uuid_conflict");

  await client.query("SAVEPOINT warehouse_uuid_conflict");
  await client.query("DELETE FROM warehouses");
  await client.query(
    `INSERT INTO warehouses(id,name,code,country_code,active)
     VALUES($1,'Unexpected UUID Owner','UNEXPECTED','CN',true)`,
    ["87b93bcc-0ec6-4a75-86ee-9db644ddb2a2"],
  );
  await assert.rejects(reconcileTooniesReferenceDataInTransaction(client), /TOONIES_WAREHOUSE_OWNERSHIP_CONFLICT/);
  await client.query("ROLLBACK TO SAVEPOINT warehouse_uuid_conflict");

  await client.query("ROLLBACK");
  console.log("Toonies reference-data reconciliation passed.");
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  client.release();
}