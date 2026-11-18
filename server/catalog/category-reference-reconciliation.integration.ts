import assert from "node:assert/strict";
import { getDatabasePool } from "../db/client.js";
import { canonicalCategoryReferences } from "./category-reference-data.js";
import { reconcileCanonicalCategoryReferences } from "./category-reference-reconciliation.js";

const legacyRoots = [
  ["5ff935ad-beaf-477e-8d5c-0688123ac756", "DEMO-Electronics", "demo-electronics"],
  ["b2e3df42-d570-4603-be35-93d827ec7c6a", "DEMO-Home & Kitchen", "demo-home-kitchen"],
  ["ff6297c7-cf6f-42b2-92c8-811378122d91", "DEMO-Beauty & Personal Care", "demo-beauty-care"],
  ["54acfa4b-a0fe-444c-b697-e8d066d8ba42", "DEMO-Travel & Accessories", "demo-travel-accessories"],
  ["6a594015-0a27-4dda-babe-fe4c1ac6d439", "DEMO-Office Essentials", "demo-office-essentials"],
] as const;

const client = await getDatabasePool().connect();
try {
  await client.query("BEGIN");
  await client.query(`CREATE TEMP TABLE categories (
    id uuid PRIMARY KEY,
    parent_id uuid REFERENCES categories(id) ON DELETE RESTRICT,
    name varchar(200) NOT NULL,
    slug varchar(180) NOT NULL,
    canonical_key varchar(220),
    active boolean NOT NULL DEFAULT true,
    sort_order integer NOT NULL DEFAULT 0,
    updated_at timestamptz NOT NULL DEFAULT now()
  ) ON COMMIT DROP`);
  await client.query("CREATE UNIQUE INDEX ON categories(lower(slug))");
  await client.query("CREATE UNIQUE INDEX ON categories(lower(canonical_key))");
  await client.query(`CREATE TEMP TABLE slug_redirects (
    entity_type varchar(40) NOT NULL,
    entity_id uuid NOT NULL,
    old_slug varchar(180) NOT NULL,
    UNIQUE(entity_type,entity_id,old_slug)
  ) ON COMMIT DROP`);
  await client.query(`CREATE TEMP TABLE products (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    category_id uuid NOT NULL REFERENCES categories(id)
  ) ON COMMIT DROP`);
  await client.query(`CREATE TEMP TABLE historical_orders (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    category_id uuid NOT NULL
  ) ON COMMIT DROP`);
  await client.query(`CREATE TEMP TABLE supplier_category_mappings (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    root_category_id uuid,
    child_category_id uuid
  ) ON COMMIT DROP`);
  await client.query(`CREATE TEMP TABLE supplier_product_links (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    product_id uuid
  ) ON COMMIT DROP`);

  for (const [index, [id, name, slug]] of legacyRoots.entries()) {
    await client.query(
      "INSERT INTO categories(id,name,slug,canonical_key,active,sort_order) VALUES($1,$2,$3,NULL,true,$4)",
      [id, name, slug, index + 1],
    );
  }
  await client.query(
    `INSERT INTO products(category_id)
     SELECT id FROM categories CROSS JOIN generate_series(1,4)`,
  );
  await client.query(
    `INSERT INTO historical_orders(category_id)
     SELECT $1 FROM generate_series(1,17)`,
    [legacyRoots[0][0]],
  );

  const before = {
    products: (await client.query("SELECT id,category_id FROM products ORDER BY id")).rows,
    orders: (await client.query("SELECT id,category_id FROM historical_orders ORDER BY id")).rows,
    mappings: (await client.query("SELECT * FROM supplier_category_mappings ORDER BY id")).rows,
    links: (await client.query("SELECT * FROM supplier_product_links ORDER BY id")).rows,
  };

  await client.query("SAVEPOINT unexpected_baseline");
  await client.query(
    "INSERT INTO categories(id,name,slug,canonical_key,active,sort_order) VALUES(gen_random_uuid(),'Unexpected','unexpected',NULL,true,99)",
  );
  await assert.rejects(
    reconcileCanonicalCategoryReferences(client),
    /CATEGORY_REFERENCE_BASELINE_CONFLICT/,
  );
  assert.equal(Number((await client.query("SELECT count(*) AS count FROM categories WHERE canonical_key IS NOT NULL")).rows[0].count), 0);
  await client.query("ROLLBACK TO SAVEPOINT unexpected_baseline");

  await client.query("SAVEPOINT wrong_legacy_order");
  await client.query("UPDATE categories SET sort_order=99 WHERE id=$1", [legacyRoots[0][0]]);
  await assert.rejects(
    reconcileCanonicalCategoryReferences(client),
    /CATEGORY_REFERENCE_BASELINE_CONFLICT/,
  );
  await client.query("ROLLBACK TO SAVEPOINT wrong_legacy_order");

  const first = await reconcileCanonicalCategoryReferences(client, { strictAllRows: true });
  assert.deepEqual(first, { inserted: 88, legacyRootsUpdated: 5, unchanged: 0 });

  const counts = (await client.query(
    `SELECT count(*) FILTER (WHERE parent_id IS NULL)::int AS roots,
            count(*) FILTER (WHERE parent_id IS NOT NULL)::int AS children,
            count(*)::int AS total,
            count(DISTINCT lower(canonical_key))::int AS keys,
            count(DISTINCT lower(slug))::int AS slugs
       FROM categories WHERE canonical_key IS NOT NULL`,
  )).rows[0];
  assert.deepEqual(counts, { roots: 15, children: 78, total: 93, keys: 93, slugs: 93 });
  assert.equal(
    Number((await client.query(
      `SELECT count(*) AS count FROM categories child
        LEFT JOIN categories parent ON parent.id=child.parent_id
       WHERE child.parent_id IS NOT NULL AND parent.id IS NULL`,
    )).rows[0].count),
    0,
  );
  const actualHierarchy = new Map(
    (await client.query(
      `SELECT id,parent_id AS "parentId",name,slug,canonical_key AS "canonicalKey",
              active,sort_order AS "sortOrder"
         FROM categories WHERE canonical_key IS NOT NULL`,
    )).rows.map((row) => [row.id, row]),
  );
  for (const expected of canonicalCategoryReferences) {
    assert.deepEqual(actualHierarchy.get(expected.id), expected);
  }
  assert.deepEqual(
    (await client.query("SELECT id FROM categories WHERE id=ANY($1::uuid[]) ORDER BY id", [legacyRoots.map(([id]) => id)])).rows.map(({ id }) => id),
    legacyRoots.map(([id]) => id).sort(),
  );
  assert.deepEqual((await client.query("SELECT id,category_id FROM products ORDER BY id")).rows, before.products);
  assert.deepEqual((await client.query("SELECT id,category_id FROM historical_orders ORDER BY id")).rows, before.orders);
  assert.deepEqual((await client.query("SELECT * FROM supplier_category_mappings ORDER BY id")).rows, before.mappings);
  assert.deepEqual((await client.query("SELECT * FROM supplier_product_links ORDER BY id")).rows, before.links);
  assert.equal(canonicalCategoryReferences.length, 93);
  assert.equal(
    Number((await client.query("SELECT count(*) AS count FROM categories WHERE canonical_key LIKE 'taxonomy-test-%'")).rows[0].count),
    0,
  );

  const second = await reconcileCanonicalCategoryReferences(client, { strictAllRows: true });
  assert.deepEqual(second, { inserted: 0, legacyRootsUpdated: 0, unchanged: 93 });

  await client.query("SAVEPOINT unexpected_canonical_root");
  await client.query(
    "INSERT INTO categories(id,name,slug,canonical_key,active,sort_order) VALUES(gen_random_uuid(),'Unexpected Root','unexpected-root','unexpected-root',true,99)",
  );
  await assert.rejects(
    reconcileCanonicalCategoryReferences(client, { strictAllRows: true }),
    /CATEGORY_REFERENCE_UNEXPECTED_ROW/,
  );
  await client.query("ROLLBACK TO SAVEPOINT unexpected_canonical_root");

  await client.query("SAVEPOINT unexpected_canonical_child");
  await client.query(
    `INSERT INTO categories(id,parent_id,name,slug,canonical_key,active,sort_order)
     SELECT gen_random_uuid(),id,'Unexpected Child','women-unexpected','women.unexpected',true,99
       FROM categories WHERE canonical_key='women'`,
  );
  await assert.rejects(
    reconcileCanonicalCategoryReferences(client, { strictAllRows: true }),
    /CATEGORY_REFERENCE_UNEXPECTED_ROW/,
  );
  await client.query("ROLLBACK TO SAVEPOINT unexpected_canonical_child");

  await client.query("SAVEPOINT conflict_check");
  await client.query("UPDATE categories SET name='Unexpected' WHERE canonical_key='women'");
  await assert.rejects(
    reconcileCanonicalCategoryReferences(client, { strictAllRows: true }),
    /CATEGORY_REFERENCE_BASELINE_CONFLICT/,
  );
  await client.query("ROLLBACK TO SAVEPOINT conflict_check");

  await client.query("ROLLBACK");
  console.log("Canonical category reference reconciliation passed.");
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  client.release();
}