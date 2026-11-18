import assert from "node:assert/strict";
import { closeDatabase, getDatabasePool } from "../db/client.js";
import { adjustStock, deleteInventoryRecord, inventoryDeletionEligibility, inventorySummary, listInventory, listMovements, setInventoryActive, setInventoryThreshold, setStockToZero, transferStock } from "./service.js";
import { exportPricingTiers, getPricing, getTiers, listPricingItems, replaceTierGroups, replaceTiers } from "../pricing/service.js";

const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
const marker = `phase4c-${suffix}`;

async function run() {
  const pool = getDatabasePool();
  let productId = "";
  let variantId = "";
  let sourceWarehouseId = "";
  let targetWarehouseId = "";
  let lifecycleWarehouseId = "";
  let categoryId = "";
  try {
    categoryId = (await pool.query<{ id: string }>("INSERT INTO categories (name, slug, description) VALUES ($1, $2, $3) RETURNING id", [`Phase 4C ${suffix}`, marker, "Temporary test category"])).rows[0]!.id;
    productId = (await pool.query<{ id: string }>(`INSERT INTO products (name, slug, parent_sku, category_id, description, cost_price, base_price, vat_rate, weight, status, published_at) VALUES ($1, $2, $3, $4, $5, 5, 15, 19, 1, 'active', now()) RETURNING id`, [`Phase 4C Product ${suffix}`, `${marker}-product`, `${marker}-sku`, categoryId, "Temporary test product"])).rows[0]!.id;
    variantId = (await pool.query<{ id: string }>(`INSERT INTO product_variants (product_id, sku, title, cost_price, base_price) VALUES ($1, $2, 'Test variant', 6, 12) RETURNING id`, [productId, `${marker}-variant`])).rows[0]!.id;
    sourceWarehouseId = (await pool.query<{ id: string }>("INSERT INTO warehouses (name, code, country_code) VALUES ($1, $2, 'CY') RETURNING id", [`Source ${suffix}`, `${marker}-A`])).rows[0]!.id;
    targetWarehouseId = (await pool.query<{ id: string }>("INSERT INTO warehouses (name, code, country_code) VALUES ($1, $2, 'CY') RETURNING id", [`Target ${suffix}`, `${marker}-B`])).rows[0]!.id;
    lifecycleWarehouseId = (await pool.query<{ id: string }>("INSERT INTO warehouses (name, code, country_code) VALUES ($1, $2, 'CY') RETURNING id", [`Lifecycle ${suffix}`, `${marker}-C`])).rows[0]!.id;

    const created = await adjustStock({ warehouseId: sourceWarehouseId, variantId, delta: 10, movementType: "purchase", note: marker });
    assert.equal(created.quantityOnHand, 10);
    await assert.rejects(() => adjustStock({ warehouseId: sourceWarehouseId, variantId, delta: 1, movementType: "damage" }), /must decrease/i);
    await assert.rejects(() => adjustStock({ warehouseId: sourceWarehouseId, variantId, delta: -11, movementType: "adjustment" }), /negative stock/i);
    const threshold = await setInventoryThreshold(created.id, 3);
    assert.equal(threshold.lowStockThreshold, 3);
    assert.equal((await listInventory({ productId })).items[0]?.variantId, variantId);

    const transfer = await transferStock({ fromWarehouseId: sourceWarehouseId, toWarehouseId: targetWarehouseId, variantId, quantity: 4, note: marker });
    assert.equal(transfer.from?.quantityOnHand, 6);
    assert.equal(transfer.to?.quantityOnHand, 4);
    await adjustStock({ warehouseId: sourceWarehouseId, variantId, delta: 2, movementType: "adjustment", note: marker });
    await adjustStock({ warehouseId: sourceWarehouseId, variantId, delta: -1, movementType: "adjustment", note: marker });
    const movements = await listMovements({ search: marker, page: 1, pageSize: 20 });
    assert.equal(movements.items.filter((movement: any) => movement.movementType === "transfer_out").length, 1);
    assert.equal(movements.items.filter((movement: any) => movement.movementType === "transfer_in").length, 1);
    assert.ok(movements.items.some((movement: any) => movement.movementType === "adjustment" && movement.quantity === 2));
    assert.ok(movements.items.some((movement: any) => movement.movementType === "adjustment" && movement.quantity === -1));

    await pool.query("UPDATE inventory SET quantity_reserved=1 WHERE id=$1", [created.id]);
    const beforeDeactivation = await pool.query<{ onHand: number; reserved: number; threshold: number; movements: string }>(
      `SELECT i.quantity_on_hand AS "onHand", i.quantity_reserved AS reserved, i.low_stock_threshold AS threshold,
              (SELECT count(*)::text FROM inventory_movements im WHERE im.warehouse_id=i.warehouse_id AND im.variant_id=i.variant_id) AS movements
         FROM inventory i WHERE i.id=$1`,
      [created.id],
    );
    const inactive = await setInventoryActive(created.id, false);
    assert.equal(inactive.active, false);
    assert.equal(inactive.status, "inactive");
    const afterDeactivation = await pool.query<{ onHand: number; reserved: number; threshold: number; movements: string }>(
      `SELECT i.quantity_on_hand AS "onHand", i.quantity_reserved AS reserved, i.low_stock_threshold AS threshold,
              (SELECT count(*)::text FROM inventory_movements im WHERE im.warehouse_id=i.warehouse_id AND im.variant_id=i.variant_id) AS movements
         FROM inventory i WHERE i.id=$1`,
      [created.id],
    );
    assert.deepEqual(afterDeactivation.rows[0], beforeDeactivation.rows[0]);
    assert.deepEqual((await listInventory({ productId, lifecycle: "active" })).items.map((item) => item.id), [transfer.to!.id]);
    assert.deepEqual((await listInventory({ productId, lifecycle: "inactive" })).items.map((item) => item.id), [created.id]);
    assert.equal((await listInventory({ productId, lifecycle: "all" })).items.length, 2);
    assert.deepEqual(await inventorySummary({ productId, lifecycle: "active" }), { skus: 1, onHand: 4, reserved: 0, available: 4, lowStock: 0, outOfStock: 0 });
    assert.deepEqual(await inventorySummary({ productId, lifecycle: "inactive" }), { skus: 1, onHand: 7, reserved: 1, available: 6, lowStock: 0, outOfStock: 0 });
    assert.deepEqual(await inventorySummary({ productId, lifecycle: "all" }), { skus: 2, onHand: 11, reserved: 1, available: 10, lowStock: 0, outOfStock: 0 });
    assert.equal(Number((await pool.query<{ available: string }>("SELECT COALESCE(sum(quantity_on_hand-quantity_reserved),0)::text AS available FROM inventory WHERE active=true AND variant_id=$1", [variantId])).rows[0]!.available), 4);
    assert.match((await inventoryDeletionEligibility(created.id)).blockers.join(" "), /remain on hand/i);
    assert.equal((await setInventoryActive(created.id, true)).active, true);
    await assert.rejects(() => setStockToZero(created.id), /currently reserved/i);
    assert.match((await inventoryDeletionEligibility(created.id)).blockers.join(" "), /currently reserved/i);
    await pool.query("UPDATE inventory SET quantity_reserved=0 WHERE id=$1", [created.id]);
    const zeroed = await setStockToZero(created.id);
    assert.equal(zeroed.quantityOnHand, 0);
    assert.equal((await inventoryDeletionEligibility(created.id)).eligible, false);
    assert.match((await inventoryDeletionEligibility(created.id)).blockers.join(" "), /movement/i);

    const unusedId = (await pool.query<{ id: string }>(`INSERT INTO inventory (warehouse_id,product_id,quantity_on_hand,quantity_reserved,low_stock_threshold) VALUES ($1,$2,0,0,0) RETURNING id`, [lifecycleWarehouseId, productId])).rows[0]!.id;
    assert.equal((await inventoryDeletionEligibility(unusedId)).eligible, true);
    await deleteInventoryRecord(unusedId);
    assert.equal((await pool.query("SELECT id FROM inventory WHERE id=$1", [unusedId])).rowCount, 0);

    await replaceTiers(productId, null, [
      { minQuantity: 1, maxQuantity: 9, unitPrice: 10, active: true },
      { minQuantity: 10, maxQuantity: null, unitPrice: 8, active: true },
    ]);
    await replaceTiers(null, variantId, [
      { minQuantity: 5, maxQuantity: null, unitPrice: 7, active: true },
      { minQuantity: 50, maxQuantity: null, unitPrice: 6, active: false },
    ]);
    await replaceTiers(null, variantId, [{ minQuantity: 3, maxQuantity: null, unitPrice: 6.5, active: true }]);
    assert.equal((await getTiers(null, variantId)).length, 1);
    assert.equal((await getTiers(null, variantId))[0]?.minQuantity, 3);
    await replaceTiers(null, variantId, []);
    assert.equal((await getTiers(null, variantId)).length, 0);
    await replaceTiers(null, variantId, [{ minQuantity: 5, maxQuantity: null, unitPrice: 7, active: true }]);
    const pricingScopes = await listPricingItems({ productId }, true);
    assert.equal(pricingScopes.items.length, 2);
    assert.ok(pricingScopes.items.some((scope: any) => scope.variantId === null));
    assert.ok(pricingScopes.items.some((scope: any) => scope.variantId === variantId));
    assert.equal((pricingScopes.items.find((scope: any) => scope.variantId === variantId) as any)?.tierCount, 1);
    const exportRows = await exportPricingTiers({ productId });
    assert.equal(exportRows.length, 3);
    assert.ok(exportRows.some((row: any) => row.scopeType === "product"));
    assert.ok(exportRows.some((row: any) => row.scopeType === "variant"));
    assert.equal((await getPricing(productId, variantId, 1)).source, "variant_base");
    assert.equal((await getPricing(productId, variantId, 1)).unitPrice, 12);
    assert.equal((await getPricing(productId, variantId, 5)).source, "variant_tier");
    assert.equal((await getPricing(productId, variantId, 5)).unitPrice, 7);
    await pool.query("UPDATE product_variants SET base_price = NULL WHERE id = $1", [variantId]);
    assert.equal((await getPricing(productId, variantId, 1)).source, "product_tier");
    assert.equal((await getPricing(productId, variantId, 10)).unitPrice, 7);
    await assert.rejects(() => replaceTiers(productId, null, [
      { minQuantity: 1, maxQuantity: 10, unitPrice: 10, active: true },
      { minQuantity: 10, maxQuantity: null, unitPrice: 8, active: true },
    ]), /overlap/i);
    const beforeAtomicFailure = await getTiers(productId, null);
    await assert.rejects(() => replaceTierGroups([
      { productId, variantId: null, tiers: [{ minQuantity: 1, maxQuantity: null, unitPrice: 10, active: true }] },
      { productId: null, variantId, tiers: [
        { minQuantity: 1, maxQuantity: 5, unitPrice: 7, active: true },
        { minQuantity: 5, maxQuantity: null, unitPrice: 7, active: true },
      ] },
    ]), /overlap/i);
    assert.deepEqual((await getTiers(productId, null)).map((tier) => [tier.minQuantity, tier.maxQuantity, tier.unitPrice]), beforeAtomicFailure.map((tier) => [tier.minQuantity, tier.maxQuantity, tier.unitPrice]));
    assert.equal((await getPricing(productId, null, 1)).quantity, 1);

    await pool.query("UPDATE products SET status='archived' WHERE id=$1", [productId]);
    assert.equal((await listInventory({ productId, lifecycle: "active" })).items.length, 0);
    assert.equal((await listInventory({ productId, lifecycle: "inactive" })).items.length, 2);
    assert.deepEqual(await inventorySummary({ productId, lifecycle: "active" }), { skus: 0, onHand: 0, reserved: 0, available: 0, lowStock: 0, outOfStock: 0 });

    console.info("Phase 4C inventory and pricing integration checks passed.");
  } finally {
    if (productId) await pool.query("DELETE FROM inventory_movements WHERE product_id = $1 OR variant_id = $2", [productId, variantId]);
    if (productId) await pool.query("DELETE FROM products WHERE id = $1", [productId]);
    if (sourceWarehouseId || targetWarehouseId || lifecycleWarehouseId) await pool.query("DELETE FROM warehouses WHERE id = ANY($1::uuid[])", [[sourceWarehouseId, targetWarehouseId, lifecycleWarehouseId].filter(Boolean)]);
    if (categoryId) await pool.query("DELETE FROM categories WHERE id = $1", [categoryId]);
    await closeDatabase();
  }
}

run().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});