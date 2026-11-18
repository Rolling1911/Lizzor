import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { recoverOwnedNeonBranches } from "./neon-branch-harness.js";

async function run(): Promise<void> {
  if (process.env.NEON_CRASH_CHILD === "1") {
    const { createDisposableNeonBranch } = await import("./neon-branch-harness.js");
    const branch = await createDisposableNeonBranch({
      sourceVerifiedEmpty: true,
      ownershipDir: process.env.NEON_TEST_OWNERSHIP_DIR,
    });
    if (process.env.NEON_CRASH_PHASE === "after-delete") {
      await recoverOwnedNeonBranches({ ownershipDir: process.env.NEON_TEST_OWNERSHIP_DIR });
    } else {
      process.exit(process.env.NEON_CRASH_PHASE === "after-intent" ? 92 : 93);
    }
    void branch;
    return;
  }
  for (const [phase, expected] of [["after-intent", 92], ["after-owned", 93], ["after-delete", 94]] as const) {
    const ownershipDir = await mkdtemp(path.join(os.tmpdir(), "neon-ownership-crash-"));
    let recoveryCompleted = false;
    try {
      const child = spawn(process.execPath, ["--import", "tsx/esm", process.argv[1]], {
        env: {
          ...process.env, NEON_CRASH_CHILD: "1", NEON_CRASH_PHASE: phase,
          ...(phase === "after-intent" ? { NEON_CRASH_AFTER_INTENT: "1" } : {}),
          ...(phase === "after-owned" ? { NEON_CRASH_AFTER_OWNED: "1" } : {}),
          ...(phase === "after-delete" ? { NEON_CRASH_AFTER_DELETE: "1" } : {}),
          NEON_TEST_OWNERSHIP_DIR: ownershipDir,
        },
        stdio: "inherit",
      });
      const exitCode = await new Promise<number>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code) => resolve(code ?? 1));
      });
      if (exitCode !== expected) throw new Error(`Crash child exited unexpectedly during ${phase} (${exitCode}).`);
      const recovered = await recoverOwnedNeonBranches({ ownershipDir });
      if (phase !== "after-delete" && recovered.length !== 1) throw new Error(`Crash recovery did not delete exactly one owned branch during ${phase}.`);
      recoveryCompleted = true;
      console.info(`Neon durable ownership crash recovery passed: ${phase}`);
    } finally {
      if (recoveryCompleted) {
        await rm(ownershipDir, { recursive: true, force: true });
      } else {
        console.error(`Neon recovery evidence preserved at ${ownershipDir}`);
      }
    }
  }
}

run().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : "Neon crash recovery failed.");
  process.exitCode = 1;
});