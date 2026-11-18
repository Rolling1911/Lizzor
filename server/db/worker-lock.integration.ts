import assert from "node:assert/strict";
import { closeDatabase, withBackgroundWorkerLock } from "./client.js";

const pause = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function main() {
  let executions = 0;
  try {
    const [first, second] = await Promise.all([
      withBackgroundWorkerLock(async () => {
        executions += 1;
        await pause(100);
      }),
      withBackgroundWorkerLock(async () => {
        executions += 1;
        await pause(100);
      }),
    ]);
    assert.equal(Number(first.acquired) + Number(second.acquired), 1);
    assert.equal(executions, 1);

    const afterRelease = await withBackgroundWorkerLock(async () => { executions += 1; });
    assert.equal(afterRelease.acquired, true);
    assert.equal(executions, 2);
    console.log("PostgreSQL background worker advisory lock checks passed.");
  } finally {
    await closeDatabase();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});