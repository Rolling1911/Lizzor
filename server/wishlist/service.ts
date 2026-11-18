import type { PoolClient } from "pg";
import { getDatabasePool } from "../db/client.js";
import { AppError } from "../middleware/error-handler.js";
import { listProducts } from "../catalog/service.js";
import { getPricing } from "../pricing/service.js";

async function withDefaultWishlist<T>(userId: string, operation: (client: PoolClient, wishlistId: string) => Promise<T>): Promise<T> {
  const pool = getDatabasePool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [userId]);
    const existing = await client.query<{ id: string }>(
      "SELECT id FROM wishlists WHERE user_id = $1 ORDER BY created_at, id LIMIT 1",
      [userId],
    );
    const id = existing.rows[0]?.id
      ?? (await client.query<{ id: string }>(
        "INSERT INTO wishlists (user_id, name) VALUES ($1, 'Default wishlist') RETURNING id",
        [userId],
      )).rows[0]?.id;
    if (!id) throw new Error("Wishlist could not be created.");
    const result = await operation(client, id);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function getDefaultWishlistId(userId: string): Promise<string> {
  return withDefaultWishlist(userId, async (_client, wishlistId) => wishlistId);
}

export async function listWishlist(userId: string, page = 1, pageSize = 24) {
  const wishlistId = await getDefaultWishlistId(userId);
  const safePage = Math.max(1, Math.floor(page));
  const safePageSize = Math.min(48, Math.max(1, Math.floor(pageSize)));
  const offset = (safePage - 1) * safePageSize;
  const count = await getDatabasePool().query<{ count: string }>(
    `SELECT count(*)::text AS count
       FROM wishlist_items wi
       JOIN products p ON p.id = wi.product_id
       JOIN categories c ON c.id = p.category_id
       WHERE wi.wishlist_id = $1 AND p.status = 'active' AND p.published_at IS NOT NULL
         AND c.active=true AND (c.parent_id IS NULL OR EXISTS (SELECT 1 FROM categories parent WHERE parent.id=c.parent_id AND parent.active=true))`,
    [wishlistId],
  );
  const total = Number(count.rows[0]?.count ?? 0);
  const saved = await getDatabasePool().query<{ productId: string; createdAt: string }>(
    `SELECT wi.product_id AS "productId", wi.created_at AS "createdAt"
       FROM wishlist_items wi
       JOIN products p ON p.id = wi.product_id
       JOIN categories c ON c.id = p.category_id
       WHERE wi.wishlist_id = $1 AND p.status = 'active' AND p.published_at IS NOT NULL
         AND c.active=true AND (c.parent_id IS NULL OR EXISTS (SELECT 1 FROM categories parent WHERE parent.id=c.parent_id AND parent.active=true))
      ORDER BY wi.created_at DESC, wi.product_id
      LIMIT $2 OFFSET $3`,
    [wishlistId, safePageSize, offset],
  );
  const pageIds = saved.rows.map((row) => row.productId);
  if (!pageIds.length) return { id: wishlistId, name: "Default wishlist", items: [], meta: { page: safePage, pageSize: safePageSize, total, hasNext: false } };
  const products = await listProducts({ ids: pageIds, status: "active", published: true, publicOnly: true, pageSize: safePageSize, sort: "updated", direction: "desc" });
  const savedAt = new Map(saved.rows.map((row) => [row.productId, row.createdAt]));
  const publicItems = await Promise.all(products.items.map(async (product) => {
    const [pricing, stock] = await Promise.all([
      getPricing(product.id, null, 1),
      getDatabasePool().query<{ available: string }>(
        `SELECT COALESCE(sum(i.quantity_on_hand-i.quantity_reserved),0)::text AS available
           FROM inventory i LEFT JOIN product_variants pv ON pv.id=i.variant_id
           WHERE i.active=true AND (i.product_id=$1 OR pv.product_id=$1)`,
        [product.id],
      ),
    ]);
    const available = Math.max(0, Number(stock.rows[0]?.available ?? 0));
    return {
      id: product.id, name: product.name, slug: product.slug, parentSku: product.parentSku,
      brand: product.brand, category: product.category, shortDescription: product.shortDescription,
      price: pricing.unitPrice, nextTier: pricing.nextTier, available,
      availability: available <= 0 ? "out_of_stock" as const : available <= 5 ? "low_stock" as const : "in_stock" as const,
      featured: product.featured, newArrival: product.newArrival, thumbnailUrl: product.thumbnailUrl,
      variantCount: product.variantCount, savedAt: savedAt.get(product.id), wishlisted: true,
    };
  }));
  return {
    id: wishlistId,
    name: "Default wishlist",
    items: publicItems
      .sort((left, right) => String(right.savedAt).localeCompare(String(left.savedAt))),
    meta: { page: safePage, pageSize: safePageSize, total, hasNext: safePage * safePageSize < total },
  };
}

export async function wishlistMembership(userId: string, productIds: string[]): Promise<Set<string>> {
  if (!productIds.length) return new Set();
  const wishlistId = await getDefaultWishlistId(userId);
  const result = await getDatabasePool().query<{ productId: string }>(
    "SELECT product_id AS \"productId\" FROM wishlist_items WHERE wishlist_id=$1 AND product_id=ANY($2::uuid[])",
    [wishlistId, productIds],
  );
  return new Set(result.rows.map((row) => row.productId));
}

export async function addWishlistItem(userId: string, productId: string): Promise<void> {
  await withDefaultWishlist(userId, async (client, wishlistId) => {
    const product = await client.query(
      `SELECT p.id FROM products p JOIN categories c ON c.id=p.category_id
        WHERE p.id = $1 AND p.status = 'active' AND p.published_at IS NOT NULL
          AND c.active=true AND (c.parent_id IS NULL OR EXISTS (SELECT 1 FROM categories parent WHERE parent.id=c.parent_id AND parent.active=true))`,
      [productId],
    );
    if (!product.rowCount) throw new AppError(404, "PRODUCT_NOT_FOUND", "The requested product was not found.");
    await client.query(
      "INSERT INTO wishlist_items (wishlist_id, product_id) VALUES ($1, $2) ON CONFLICT (wishlist_id, product_id) DO NOTHING",
      [wishlistId, productId],
    );
  });
}

export async function removeWishlistItem(userId: string, productId: string): Promise<void> {
  await withDefaultWishlist(userId, async (client, wishlistId) => {
    await client.query("DELETE FROM wishlist_items WHERE wishlist_id = $1 AND product_id = $2", [wishlistId, productId]);
  });
}