import { withDisposableNeonBranch } from "./neon-branch-harness.js";

async function run(): Promise<void> {
  await withDisposableNeonBranch(
    { sourceVerifiedEmpty: true },
    async (branch, closePools) => {
      let pool: import("pg").Pool | undefined;
      try {
        // These imports intentionally occur only after the harness has installed
        // the derived DATABASE_URL.
        const { runMigrations } = await import("../db/migrate.js");
        await runMigrations();
        const { Pool } = await import("pg");
        pool = new Pool({ connectionString: process.env.DATABASE_URL });
        const result = await pool.query<{
          present: string[] | null;
          migration_count: string;
          trigger_count: string;
        }>(`
          SELECT
            ARRAY_REMOVE(ARRAY[
              to_regclass('public.toonies_settlements'),
              to_regclass('public.toonies_settlement_evidence'),
              to_regclass('public.financial_operation_reservations')
            ]::text[], NULL) AS present,
            (SELECT count(*)::text FROM drizzle."__drizzle_migrations") AS migration_count,
            (SELECT count(*)::text FROM pg_trigger
              WHERE tgrelid IN ('public.toonies_settlements'::regclass,
                                'public.toonies_settlement_evidence'::regclass)
                AND NOT tgisinternal) AS trigger_count
        `);
        const row = result.rows[0];
        if (!row || row.present?.length !== 3 || Number(row.migration_count) < 96 || Number(row.trigger_count) < 3) {
          throw new Error("Critical Stage-3 database attestation failed.");
        }
        console.info(`Disposable Neon branch migrated and attested: ${branch.branchName}`);
      } finally {
        await closePools(async () => {
          if (pool) await pool.end();
          const { closeDatabase } = await import("../db/client.js");
          await closeDatabase();
        });
      }
    },
  );
}

run().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Neon branch smoke failed.");
  process.exitCode = 1;
});
