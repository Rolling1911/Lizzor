import { closeDatabase, getDatabasePool } from "./client.js";

async function remove(): Promise<void> {
  const pool = getDatabasePool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`DELETE FROM products WHERE parent_sku LIKE 'DEMO-%'`);
    await client.query(`DELETE FROM brands WHERE name LIKE 'DEMO-%'`);
    await client.query(`DELETE FROM categories WHERE name LIKE 'DEMO-%'`);
    await client.query(`DELETE FROM warehouses WHERE code LIKE 'DEMO-%'`);
    await client.query("COMMIT");
    console.info("Demo catalog removed. Non-demo catalog records were not changed.");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

remove().catch((error: unknown) => {
  console.error("Demo catalog removal failed.", error);
  process.exitCode = 1;
}).finally(closeDatabase);