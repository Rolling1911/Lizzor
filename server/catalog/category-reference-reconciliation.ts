import type { PoolClient } from "pg";
import { getDatabasePool } from "../db/client.js";
import {
  canonicalCategoryReferences,
  type CanonicalCategoryReference,
} from "./category-reference-data.js";

export interface CategoryReferenceReconciliationResult {
  inserted: number;
  legacyRootsUpdated: number;
  unchanged: number;
}

type CategoryRow = {
  id: string;
  parentId: string | null;
  name: string;
  slug: string;
  canonicalKey: string | null;
  active: boolean;
  sortOrder: number;
};

const retainedLegacyRoots: ReadonlyMap<string, { name: string; slug: string; sortOrder: number }> = new Map([
  ["5ff935ad-beaf-477e-8d5c-0688123ac756", { name: "DEMO-Electronics", slug: "demo-electronics", sortOrder: 1 }],
  ["b2e3df42-d570-4603-be35-93d827ec7c6a", { name: "DEMO-Home & Kitchen", slug: "demo-home-kitchen", sortOrder: 2 }],
  ["ff6297c7-cf6f-42b2-92c8-811378122d91", { name: "DEMO-Beauty & Personal Care", slug: "demo-beauty-care", sortOrder: 3 }],
  ["54acfa4b-a0fe-444c-b697-e8d066d8ba42", { name: "DEMO-Travel & Accessories", slug: "demo-travel-accessories", sortOrder: 4 }],
  ["6a594015-0a27-4dda-babe-fe4c1ac6d439", { name: "DEMO-Office Essentials", slug: "demo-office-essentials", sortOrder: 5 }],
] as const);

function isCanonicalMatch(row: CategoryRow, expected: CanonicalCategoryReference): boolean {
  return row.id === expected.id
    && row.parentId === expected.parentId
    && row.name === expected.name
    && row.slug === expected.slug
    && row.canonicalKey === expected.canonicalKey
    && row.active === expected.active
    && row.sortOrder === expected.sortOrder;
}

function isApprovedLegacyMatch(row: CategoryRow): boolean {
  const legacy = retainedLegacyRoots.get(row.id);
  return Boolean(
    legacy
    && row.parentId === null
    && row.name === legacy.name
    && row.slug === legacy.slug
    && row.canonicalKey === null
    && row.active
    && row.sortOrder === legacy.sortOrder,
  );
}

function assertReferenceSpecification(): void {
  const ids = new Set<string>();
  const slugs = new Set<string>();
  const keys = new Set<string>();
  const seenIds = new Set<string>();
  let roots = 0;
  let children = 0;
  for (const category of canonicalCategoryReferences) {
    const slug = category.slug.toLowerCase();
    const key = category.canonicalKey.toLowerCase();
    if (ids.has(category.id) || slugs.has(slug) || keys.has(key)) {
      throw new Error("CATEGORY_REFERENCE_SPEC_DUPLICATE");
    }
    if (category.parentId) {
      children += 1;
      if (!seenIds.has(category.parentId)) {
        throw new Error(`CATEGORY_REFERENCE_SPEC_PARENT_ORDER: ${category.canonicalKey}`);
      }
    } else {
      roots += 1;
    }
    ids.add(category.id);
    slugs.add(slug);
    keys.add(key);
    seenIds.add(category.id);
  }
  if (roots !== 15 || children !== 78 || canonicalCategoryReferences.length !== 93) {
    throw new Error("CATEGORY_REFERENCE_SPEC_COUNT");
  }
}

async function reconcileWithClient(
  client: PoolClient,
  strictAllRows: boolean,
): Promise<CategoryReferenceReconciliationResult> {
  assertReferenceSpecification();
  await client.query("SET LOCAL lock_timeout = '10s'");
  await client.query("SET LOCAL statement_timeout = '20s'");
  await client.query("SELECT pg_advisory_xact_lock(hashtext('lizzor:canonical-category-reference-data'))");
  await client.query("SELECT pg_advisory_xact_lock(hashtext('catalog-slug:category'))");
  await client.query("LOCK TABLE categories IN SHARE ROW EXCLUSIVE MODE");
  await client.query("LOCK TABLE slug_redirects IN SHARE ROW EXCLUSIVE MODE");

  const expectedById = new Map(canonicalCategoryReferences.map((category) => [category.id, category]));
  const rows = await client.query<CategoryRow>(
    `SELECT id,parent_id AS "parentId",name,slug,canonical_key AS "canonicalKey",
            active,sort_order AS "sortOrder"
       FROM categories
      FOR UPDATE`,
  );
  const byId = new Map(rows.rows.map((row) => [row.id, row]));
  const retainedRows = [...retainedLegacyRoots.keys()].map((id) => byId.get(id));
  const legacyCount = retainedRows.filter((row) => row && isApprovedLegacyMatch(row)).length;
  if (legacyCount > 0) {
    if (
      rows.rows.length !== retainedLegacyRoots.size
      || retainedRows.some((row) => !row || !isApprovedLegacyMatch(row))
    ) {
      throw new Error("CATEGORY_REFERENCE_BASELINE_CONFLICT: production legacy taxonomy is not the audited five-row baseline");
    }
  } else if (
    canonicalCategoryReferences.some((expected) => {
      const row = byId.get(expected.id);
      return !row || !isCanonicalMatch(row, expected);
    })
  ) {
    throw new Error("CATEGORY_REFERENCE_BASELINE_CONFLICT: canonical taxonomy is incomplete or inconsistent");
  }

  for (const row of rows.rows) {
    const expected = expectedById.get(row.id);
    if (strictAllRows && !expected) {
      throw new Error(`CATEGORY_REFERENCE_UNEXPECTED_ROW: ${row.id}`);
    }
    if (expected && !isCanonicalMatch(row, expected) && !isApprovedLegacyMatch(row)) {
      throw new Error(`CATEGORY_REFERENCE_STATE_CONFLICT: category ${row.id} differs from the approved baseline`);
    }
  }

  for (const expected of canonicalCategoryReferences) {
    const slugOwner = rows.rows.find((row) => row.slug.toLowerCase() === expected.slug.toLowerCase());
    if (slugOwner && slugOwner.id !== expected.id) {
      throw new Error(`CATEGORY_REFERENCE_SLUG_CONFLICT: ${expected.slug}`);
    }
    const keyOwner = rows.rows.find(
      (row) => row.canonicalKey?.toLowerCase() === expected.canonicalKey.toLowerCase(),
    );
    if (keyOwner && keyOwner.id !== expected.id) {
      throw new Error(`CATEGORY_REFERENCE_KEY_CONFLICT: ${expected.canonicalKey}`);
    }
    if (expected.parentId && !expectedById.has(expected.parentId)) {
      throw new Error(`CATEGORY_REFERENCE_PARENT_SPEC_CONFLICT: ${expected.canonicalKey}`);
    }
  }

  for (const [id, legacy] of retainedLegacyRoots) {
    const redirect = await client.query<{ entityType: string; entityId: string }>(
      `SELECT entity_type AS "entityType",entity_id AS "entityId"
         FROM slug_redirects WHERE lower(old_slug)=lower($1) FOR UPDATE`,
      [legacy.slug],
    );
    if (redirect.rows.some((row) => row.entityType !== "category" || row.entityId !== id)) {
      throw new Error(`CATEGORY_REFERENCE_REDIRECT_CONFLICT: ${legacy.slug}`);
    }
  }

  let inserted = 0;
  let legacyRootsUpdated = 0;
  let unchanged = 0;
  for (const expected of canonicalCategoryReferences) {
    const current = byId.get(expected.id);
    if (!current) {
      await client.query(
        `INSERT INTO categories
           (id,parent_id,name,slug,canonical_key,active,sort_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [
          expected.id,
          expected.parentId,
          expected.name,
          expected.slug,
          expected.canonicalKey,
          expected.active,
          expected.sortOrder,
        ],
      );
      inserted += 1;
    } else if (isApprovedLegacyMatch(current)) {
      await client.query(
        `UPDATE categories
            SET parent_id=$2,name=$3,slug=$4,canonical_key=$5,active=$6,
                sort_order=$7,updated_at=now()
          WHERE id=$1`,
        [
          expected.id,
          expected.parentId,
          expected.name,
          expected.slug,
          expected.canonicalKey,
          expected.active,
          expected.sortOrder,
        ],
      );
      const legacy = retainedLegacyRoots.get(expected.id)!;
      await client.query(
        `INSERT INTO slug_redirects (entity_type,entity_id,old_slug)
         VALUES ('category',$1,$2)
         ON CONFLICT DO NOTHING`,
        [expected.id, legacy.slug],
      );
      const storedRedirect = await client.query<{ entityType: string; entityId: string }>(
        `SELECT entity_type AS "entityType",entity_id AS "entityId"
           FROM slug_redirects WHERE lower(old_slug)=lower($1)`,
        [legacy.slug],
      );
      if (
        storedRedirect.rows.length !== 1
        || storedRedirect.rows[0]?.entityType !== "category"
        || storedRedirect.rows[0]?.entityId !== expected.id
      ) {
        throw new Error(`CATEGORY_REFERENCE_REDIRECT_CONFLICT: ${legacy.slug}`);
      }
      legacyRootsUpdated += 1;
    } else {
      unchanged += 1;
    }
  }

  if (strictAllRows) {
    const postcondition = await client.query<{ total: number; roots: number; children: number }>(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE parent_id IS NULL)::int AS roots,
              count(*) FILTER (WHERE parent_id IS NOT NULL)::int AS children
         FROM categories`,
    );
    const totals = postcondition.rows[0];
    if (!totals || totals.total !== 93 || totals.roots !== 15 || totals.children !== 78) {
      throw new Error("CATEGORY_REFERENCE_POSTCONDITION_CONFLICT");
    }
  }

  return { inserted, legacyRootsUpdated, unchanged };
}

export async function reconcileCanonicalCategoryReferences(
  client?: PoolClient,
  options: { strictAllRows?: boolean } = {},
): Promise<CategoryReferenceReconciliationResult> {
  const strictAllRows = options.strictAllRows ?? process.env.NODE_ENV === "production";
  if (client) return reconcileWithClient(client, strictAllRows);

  const ownedClient = await getDatabasePool().connect();
  try {
    await ownedClient.query("BEGIN");
    const result = await reconcileWithClient(ownedClient, strictAllRows);
    await ownedClient.query("COMMIT");
    return result;
  } catch (error) {
    await ownedClient.query("ROLLBACK");
    throw error;
  } finally {
    ownedClient.release();
  }
}