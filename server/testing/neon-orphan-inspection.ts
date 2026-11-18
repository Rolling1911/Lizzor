import { inspectHistoricalNeonOrphan } from "./neon-branch-harness.js";

const branchId = process.env.NEON_HISTORICAL_ORPHAN_BRANCH_ID ?? "br-billowing-tooth-b42x98u0";
const branchName = process.env.NEON_HISTORICAL_ORPHAN_BRANCH_NAME
  ?? "lizzor-stage3-test-b783cc2aa7dbf695eaaadeb7";

inspectHistoricalNeonOrphan(branchId, branchName)
  .then((report) => console.info(JSON.stringify(report)))
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack : "Historical orphan inspection failed.");
    process.exitCode = 1;
  });