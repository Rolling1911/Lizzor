import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createDisposableNeonBranch, deleteOwnedNeonBranch, inspectHistoricalNeonOrphan, recoverOwnedNeonBranches, type DisposableNeonBranch } from "./neon-branch-harness.js";

type Branch = { id: string; name: string; default?: boolean; project_id?: string };

const projectId = "test-project";
const defaultBranch: Branch = { id: "default-branch", name: "production", default: true, project_id: projectId };

function fakeNeonFetch(state: { branches: Branch[]; project?: Record<string, unknown>; visibleProjects?: Array<{ id: string }>; uriFailure?: boolean; deleteNoop?: boolean }) {
  return async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input);
    if (url.pathname.endsWith(`/projects/${projectId}`)) {
      return Response.json({ project: state.project ?? { id: projectId, org_id: "test-org", effective_project_permission: "ADMIN" } });
    }
    if (url.pathname.endsWith("/projects") && url.searchParams.get("org_id") === "test-org") {
      return Response.json({ projects: state.visibleProjects ?? [{ id: projectId }] });
    }
    if (url.pathname.endsWith(`/projects/${projectId}/branches`)) {
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { branch: { name: string; parent_id: string }; endpoints: Array<{ type: string }> };
        assert.equal(body.branch.parent_id, defaultBranch.id);
        assert.deepEqual(body.endpoints, [{ type: "read_write" }]);
        const branch = { id: "owned-branch", name: body.branch.name, project_id: projectId, parent_id: defaultBranch.id };
        state.branches.push(branch);
        return Response.json({ branch, endpoints: [{ id: "owned-endpoint", branch_id: branch.id, type: "read_write" }] }, { status: 201 });
      }
      return Response.json({ branches: state.branches });
    }
    if (url.pathname.includes("/connection_uri")) {
      if (state.uriFailure) return new Response(null, { status: 503 });
      return Response.json({ uri: "postgresql://test-only.invalid/neondb" });
    }
    if (url.pathname.endsWith("/owned-branch") && init?.method === "DELETE") {
      if (!state.deleteNoop) state.branches = state.branches.filter((branch) => branch.id !== "owned-branch");
      return Response.json({}, { status: 202 });
    }
    return new Response(null, { status: 404 });
  };
}

function env(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  const before = { NODE_ENV: process.env.NODE_ENV, NEON_TEST_API_KEY: process.env.NEON_TEST_API_KEY, NEON_TEST_PROJECT_ID: process.env.NEON_TEST_PROJECT_ID, DATABASE_URL: process.env.DATABASE_URL, NEON_TEST_OWNERSHIP_DIR: process.env.NEON_TEST_OWNERSHIP_DIR };
  if (Object.prototype.hasOwnProperty.call(overrides, "NODE_ENV") && overrides.NODE_ENV === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = overrides.NODE_ENV ?? "test";
  process.env.NEON_TEST_API_KEY = overrides.NEON_TEST_API_KEY ?? "test-key";
  process.env.NEON_TEST_PROJECT_ID = overrides.NEON_TEST_PROJECT_ID ?? projectId;
  if (overrides.NEON_TEST_OWNERSHIP_DIR === undefined) delete process.env.NEON_TEST_OWNERSHIP_DIR;
  else process.env.NEON_TEST_OWNERSHIP_DIR = overrides.NEON_TEST_OWNERSHIP_DIR;
  if (overrides.DATABASE_URL === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = overrides.DATABASE_URL;
  return before;
}

function restore(before: Record<string, string | undefined>): void {
  for (const key of ["NODE_ENV", "NEON_TEST_API_KEY", "NEON_TEST_PROJECT_ID", "DATABASE_URL", "NEON_TEST_OWNERSHIP_DIR"]) {
    if (before[key] === undefined) delete process.env[key];
    else process.env[key] = before[key];
  }
}

async function rejects(work: () => Promise<unknown>, message: RegExp): Promise<void> {
  await assert.rejects(work, message);
}

async function run(): Promise<void> {
  const before = env();
  const testOwnershipDir = await mkdtemp(path.join(os.tmpdir(), "neon-harness-workspace-"));
  process.env.NEON_TEST_OWNERSHIP_DIR = testOwnershipDir;
  try {
    const state = { branches: [defaultBranch] };
    const fetchImpl = fakeNeonFetch(state);
    await rejects(() => createDisposableNeonBranch({ sourceVerifiedEmpty: false, fetchImpl }), /source has not been verified empty/);
    const owned = await createDisposableNeonBranch({ sourceVerifiedEmpty: true, fetchImpl });
    assert.match(owned.branchName, /^lizzor-stage3-test-[a-z0-9]+$/);
    await deleteOwnedNeonBranch(owned, { fetchImpl });
    assert.deepEqual(state.branches, [defaultBranch]);

    const scopeState = { branches: [{ ...defaultBranch }], visibleProjects: [{ id: projectId }, { id: "unexpected-project" }] };
    await rejects(() => createDisposableNeonBranch({ sourceVerifiedEmpty: true, fetchImpl: fakeNeonFetch(scopeState) }), /unexpected project scope/);
    assert.deepEqual(scopeState.branches, [defaultBranch]);

    const uriState = { branches: [{ ...defaultBranch }], uriFailure: true };
    await rejects(() => createDisposableNeonBranch({ sourceVerifiedEmpty: true, fetchImpl: fakeNeonFetch(uriState) }), /HTTP 503/);
    assert.deepEqual(uriState.branches, [defaultBranch]);

    const unwritableRoot = await mkdtemp(path.join(os.tmpdir(), "neon-harness-unwritable-"));
    const unwritableJournalPath = path.join(unwritableRoot, "not-a-directory");
    await writeFile(unwritableJournalPath, "fixture");
    const journalFailureState = { branches: [{ ...defaultBranch }] };
    await rejects(
      () => createDisposableNeonBranch({
        sourceVerifiedEmpty: true,
        fetchImpl: fakeNeonFetch(journalFailureState),
        ownershipDir: unwritableJournalPath,
      }),
      /private, owned directory/,
    );
    assert.deepEqual(journalFailureState.branches, [defaultBranch]);
    await rm(unwritableRoot, { recursive: true, force: true });
    const symlinkRoot = await mkdtemp(path.join(os.tmpdir(), "neon-harness-link-"));
    const symlinkTarget = await mkdtemp(path.join(os.tmpdir(), "neon-harness-target-"));
    const symlinkPath = path.join(symlinkRoot, "journal");
    await symlink(symlinkTarget, symlinkPath, "dir");
    const symlinkState = { branches: [{ ...defaultBranch }] };
    await rejects(
      () => createDisposableNeonBranch({
        sourceVerifiedEmpty: true,
        fetchImpl: fakeNeonFetch(symlinkState),
        ownershipDir: symlinkPath,
      }),
      /private, owned directory/,
    );
    assert.deepEqual(symlinkState.branches, [defaultBranch]);
    await rm(symlinkRoot, { recursive: true, force: true });
    await rm(symlinkTarget, { recursive: true, force: true });
    const legacyDir = await mkdtemp(path.join(os.tmpdir(), "neon-harness-legacy-"));
    const legacyRecord = {
      version: 1, projectId, branchId: "legacy-branch", branchName: "lizzor-stage3-test-legacy",
      testRunId: randomUUID(), createdAt: new Date().toISOString(), parentBranchId: defaultBranch.id,
      parentBranchName: defaultBranch.name, ownershipState: "owned", cleanupState: "pending",
    };
    await writeFile(path.join(legacyDir, `${legacyRecord.testRunId}.json`), JSON.stringify(legacyRecord));
    await rejects(() => recoverOwnedNeonBranches({ fetchImpl: fakeNeonFetch({ branches: [{ ...defaultBranch }] }), ownershipDir: legacyDir }), /Unsigned legacy/);
    legacyRecord.ownershipState = "cleaned";
    legacyRecord.cleanupState = "complete";
    await writeFile(path.join(legacyDir, `${legacyRecord.testRunId}.json`), JSON.stringify(legacyRecord));
    assert.deepEqual(await recoverOwnedNeonBranches({ fetchImpl: fakeNeonFetch({ branches: [{ ...defaultBranch }] }), ownershipDir: legacyDir }), []);
    await rm(legacyDir, { recursive: true, force: true });

    const state2 = { branches: [{ ...defaultBranch }] };
    const owned2 = await createDisposableNeonBranch({ sourceVerifiedEmpty: true, fetchImpl: fakeNeonFetch(state2) });
    const forged = { ...owned2, branchId: "caller-supplied", ownershipToken: owned2.ownershipToken };
    await rejects(() => deleteOwnedNeonBranch(forged, { fetchImpl: fakeNeonFetch(state2) }), /ownership could not be proven/);
    await rejects(() => deleteOwnedNeonBranch({ ...owned2, ownershipToken: "lost" }, { fetchImpl: fakeNeonFetch(state2) }), /ownership could not be proven/);
    await rejects(() => deleteOwnedNeonBranch({ ...owned2, branchName: "production", branchId: defaultBranch.id }, { fetchImpl: fakeNeonFetch(state2) }), /ownership could not be proven/);
    const crashDir = await mkdtemp(path.join(os.tmpdir(), "neon-harness-test-"));
    try {
      const crashState = { branches: [{ ...defaultBranch }] };
      const crashBranch = await createDisposableNeonBranch({
        sourceVerifiedEmpty: true,
        fetchImpl: fakeNeonFetch(crashState),
        ownershipDir: crashDir,
      });
      const journalName = (await readdir(crashDir)).find((name) => name.endsWith(".json"));
      assert.ok(journalName);
      const journalPath = path.join(crashDir, journalName);
      const journalText = await readFile(journalPath, "utf8");
      assert.equal(journalText.includes("test-key"), false);
      assert.equal(journalText.includes("postgres"), false);
      const parsedJournal = JSON.parse(journalText) as Record<string, unknown>;
      await writeFile(journalPath, JSON.stringify({ ...parsedJournal, injected: true }));
      await rejects(() => recoverOwnedNeonBranches({ fetchImpl: fakeNeonFetch(crashState), ownershipDir: crashDir }), /invalid record/);
      delete parsedJournal.injected;
      parsedJournal.signature = "0".repeat(64);
      await writeFile(journalPath, JSON.stringify(parsedJournal));
      await rejects(() => recoverOwnedNeonBranches({ fetchImpl: fakeNeonFetch(crashState), ownershipDir: crashDir }), /invalid record/);
      await writeFile(journalPath, journalText);
      const creatingJournal = JSON.parse(journalText) as Record<string, unknown>;
      delete creatingJournal.signature;
      creatingJournal.branchId = null;
      creatingJournal.ownershipState = "creating";
      creatingJournal.cleanupState = "pending";
      const signingKey = createHmac("sha256", "test-key")
        .update(`lizzor-neon-ownership-v2\0${creatingJournal.projectId}`).digest();
      creatingJournal.signature = createHmac("sha256", signingKey)
        .update(JSON.stringify(creatingJournal)).digest("hex");
      await writeFile(journalPath, JSON.stringify(creatingJournal));
      const noopState = { branches: crashState.branches.map((branch) => ({ ...branch })), deleteNoop: true };
      await rejects(
        () => recoverOwnedNeonBranches({ fetchImpl: fakeNeonFetch(noopState), ownershipDir: crashDir }),
        /deletion could not be verified safely/,
      );
      const recovered = await recoverOwnedNeonBranches({ fetchImpl: fakeNeonFetch(crashState), ownershipDir: crashDir });
      assert.deepEqual(recovered, ["owned-branch"]);
      assert.deepEqual(crashState.branches, [defaultBranch]);
      const orphanReport = await inspectHistoricalNeonOrphan("historical-branch", "lizzor-stage3-test-historical", { fetchImpl: fakeNeonFetch(crashState) });
      assert.equal(orphanReport.deletable, false);
    } finally {
      await rm(crashDir, { recursive: true, force: true });
    }

    restore(before);
    for (const nodeEnv of ["production", "development", undefined]) {
      const prior = env({ NODE_ENV: nodeEnv });
      await rejects(() => createDisposableNeonBranch({ sourceVerifiedEmpty: true, fetchImpl }), /requires raw NODE_ENV=test/);
      restore(prior);
    }
    const prior = env({ DATABASE_URL: "postgresql://must-not-be-used.invalid/db" });
    delete process.env.NEON_TEST_API_KEY;
    await rejects(() => createDisposableNeonBranch({ sourceVerifiedEmpty: true, fetchImpl }), /NEON_TEST_API_KEY/);
    restore(prior);
    const mismatch = env({ NEON_TEST_PROJECT_ID: "wrong-project" });
    await rejects(() => createDisposableNeonBranch({ sourceVerifiedEmpty: true, fetchImpl }), /HTTP 404|project identity/);
    restore(mismatch);
    const unexpected = env();
    await rejects(() => createDisposableNeonBranch({
      sourceVerifiedEmpty: true,
      fetchImpl: fakeNeonFetch({ branches: [defaultBranch], project: { id: projectId, org_id: "test-org", effective_project_permission: "VIEWER" } }),
    }), /project identity or administrative/);
    restore(unexpected);
    console.info("Neon branch harness safety tests passed.");
  } finally {
    await rm(testOwnershipDir, { recursive: true, force: true });
    restore(before);
  }
}

run().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Neon branch harness safety tests failed.");
  process.exitCode = 1;
});
