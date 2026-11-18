import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const API_ROOT = "https://console.neon.tech/api/v2";
const BRANCH_NAME_PATTERN = /^lizzor-stage3-test-[a-z0-9]+$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROTECTED_BRANCH_NAME = "production";

type NeonBranch = {
  id: string;
  name: string;
  project_id?: string;
  default?: boolean;
  parent_id?: string;
};

type NeonProject = {
  id: string;
  org_id?: string;
  effective_project_permission?: string;
};

type NeonEndpoint = {
  id: string;
  branch_id: string;
  type?: string;
};

type DurableOwnershipRecord = {
  version: 2;
  projectId: string;
  branchId: string | null;
  branchName: string;
  testRunId: string;
  createdAt: string;
  parentBranchId: string;
  parentBranchName: string;
  ownershipState: "creating" | "owned" | "cleanup_started" | "cleaned";
  cleanupState: "pending" | "in_progress" | "complete";
  signature: string;
};

type NeonFetch = (input: string, init?: RequestInit) => Promise<Response>;
const OWNERSHIP_KEYS = [
  "version", "projectId", "branchId", "branchName", "testRunId", "createdAt",
  "parentBranchId", "parentBranchName", "ownershipState", "cleanupState", "signature",
] as const;

export type DisposableNeonBranch = {
  readonly projectId: string;
  readonly branchId: string;
  readonly branchName: string;
  readonly databaseUrl: string;
  readonly defaultBranchId: string;
  readonly ownershipToken: string;
  readonly ownershipDir: string;
};

export type NeonBranchHarnessOptions = {
  /**
   * This is deliberately required by the harness. Neon branches inherit their
   * parent, so callers must establish that the source contains no real data
   * before permitting the first mutation.
   */
  sourceVerifiedEmpty: boolean;
  fetchImpl?: NeonFetch;
  ownershipDir?: string;
};

const ownedBranches = new Map<string, { projectId: string; branchId: string; branchName: string }>();
const defaultOwnershipDir = () => process.env.NEON_TEST_OWNERSHIP_DIR
  ? path.resolve(process.env.NEON_TEST_OWNERSHIP_DIR)
  : path.join(process.cwd(), ".neon-test-ownership");

function canonicalRecord(record: Omit<DurableOwnershipRecord, "signature">): string {
  return JSON.stringify(record);
}

function signRecord(record: Omit<DurableOwnershipRecord, "signature">, apiKey: string): DurableOwnershipRecord {
  const key = createHmac("sha256", apiKey).update(`lizzor-neon-ownership-v2\0${record.projectId}`).digest();
  return { ...record, signature: createHmac("sha256", key).update(canonicalRecord(record)).digest("hex") };
}

function verifyRecord(record: DurableOwnershipRecord, apiKey: string): boolean {
  const { signature, ...unsigned } = record;
  if (!/^[a-f0-9]{64}$/.test(signature)) return false;
  const expected = signRecord(unsigned, apiKey).signature;
  return timingSafeEqual(Buffer.from(signature, "hex"), Buffer.from(expected, "hex"));
}

async function ensureOwnershipDir(dir: string): Promise<void> {
  const resolved = path.resolve(dir);
  const workspaceDefault = path.join(process.cwd(), ".neon-test-ownership");
  if (resolved !== workspaceDefault
    && !(resolved === os.tmpdir() || resolved.startsWith(`${os.tmpdir()}${path.sep}`))) {
    throw new Error("Neon ownership journal path is outside the protected workspace location.");
  }
  const parentInfo = await fs.lstat(path.dirname(resolved));
  if (parentInfo.isSymbolicLink()) {
    throw new Error("Neon ownership journal path has a symbolic-link parent.");
  }
  if (await fs.realpath(path.dirname(resolved)) !== path.dirname(resolved)) {
    throw new Error("Neon ownership journal path has a symbolic-link parent.");
  }
  try {
    const info = await fs.lstat(resolved);
    if (info.isSymbolicLink() || !info.isDirectory() || (info.mode & 0o077) !== 0
      || (typeof process.getuid === "function" && info.uid !== process.getuid())) {
      throw new Error("Neon ownership journal directory is not a private, owned directory.");
    }
    if (await fs.realpath(resolved) !== resolved) {
      throw new Error("Neon ownership journal directory resolves through a symbolic link.");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
    await fs.mkdir(resolved, { recursive: true, mode: 0o700 });
    const info = await fs.lstat(resolved);
    if (info.isSymbolicLink() || !info.isDirectory() || (info.mode & 0o077) !== 0
      || (typeof process.getuid === "function" && info.uid !== process.getuid())) {
      throw new Error("Neon ownership journal directory could not be hardened.");
    }
  }
}

function ownershipFile(dir: string, testRunId: string): string {
  return path.join(dir, `${testRunId}.json`);
}

async function writeOwnershipRecord(dir: string, record: Omit<DurableOwnershipRecord, "signature"> | DurableOwnershipRecord, apiKey: string): Promise<void> {
  await ensureOwnershipDir(dir);
  const unsigned = { ...record } as Omit<DurableOwnershipRecord, "signature">;
  delete (unsigned as Partial<DurableOwnershipRecord>).signature;
  const signed = signRecord(unsigned, apiKey);
  const target = ownershipFile(dir, record.testRunId);
  const temporary = `${target}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(signed)}\n`, { mode: 0o600, flag: "wx" });
  await fs.rename(temporary, target);
}

async function readOwnershipRecords(dir: string, apiKey: string): Promise<Array<{ file: string; record: DurableOwnershipRecord }>> {
  await ensureOwnershipDir(dir);
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return [];
    throw error;
  });
  const records: Array<{ file: string; record: DurableOwnershipRecord }> = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const file = path.join(dir, entry.name);
    const parsed = JSON.parse(await fs.readFile(file, "utf8")) as DurableOwnershipRecord & { version?: number };
    if ((parsed as { version?: number }).version === 1) {
      if (parsed.ownershipState === "cleaned" && parsed.cleanupState === "complete") continue;
      throw new Error("Unsigned legacy Neon ownership journal cannot authorize deletion.");
    }
    const keys = Object.keys(parsed).sort();
    const expectedKeys = [...OWNERSHIP_KEYS].sort();
    if (parsed.version !== 2 || !parsed.projectId || parsed.branchId !== null && !parsed.branchId || !parsed.branchName
      || !parsed.testRunId || !parsed.createdAt || !parsed.parentBranchId
      || !parsed.parentBranchName || !["creating", "owned", "cleanup_started", "cleaned"].includes(parsed.ownershipState)
      || !["pending", "in_progress", "complete"].includes(parsed.cleanupState)
      || keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])
      || entry.name !== `${parsed.testRunId}.json`
      || !BRANCH_NAME_PATTERN.test(parsed.branchName)
      || !UUID_PATTERN.test(parsed.testRunId)
      || parsed.parentBranchName !== PROTECTED_BRANCH_NAME
      || Number.isNaN(Date.parse(parsed.createdAt))
      || !verifyRecord(parsed, apiKey)
      || (parsed.ownershipState === "creating" && parsed.branchId !== null)
      || (parsed.ownershipState === "creating" && parsed.cleanupState !== "pending")
      || (parsed.ownershipState === "owned" && (!parsed.branchId || parsed.cleanupState !== "pending"))
      || (parsed.ownershipState === "cleanup_started" && (!parsed.branchId || parsed.cleanupState !== "in_progress"))
      || (parsed.ownershipState === "cleaned" && parsed.cleanupState !== "complete")) {
      throw new Error("Neon ownership journal contains an invalid record.");
    }
    records.push({ file, record: parsed });
  }
  return records;
}

function requireTestEnvironment(): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("Neon disposable branch harness requires raw NODE_ENV=test.");
  }
}

function requireCredentials(): { apiKey: string; projectId: string } {
  const apiKey = process.env.NEON_TEST_API_KEY;
  const projectId = process.env.NEON_TEST_PROJECT_ID;
  if (!apiKey || !projectId) {
    throw new Error("NEON_TEST_API_KEY and NEON_TEST_PROJECT_ID are required.");
  }
  return { apiKey, projectId };
}

function safeApiError(status: number, operation: string): Error {
  return new Error(`Neon ${operation} failed (HTTP ${status}).`);
}

async function neonRequest<T>(
  fetchImpl: NeonFetch,
  apiKey: string,
  path: string,
  operation: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetchImpl(`${API_ROOT}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${apiKey}`,
      accept: "application/json",
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  });
  if (!response.ok) throw safeApiError(response.status, operation);
  try {
    return await response.json() as T;
  } catch {
    throw new Error(`Neon ${operation} returned an invalid response.`);
  }
}

async function readProjectAndDefault(
  fetchImpl: NeonFetch,
  apiKey: string,
  projectId: string,
): Promise<{ project: NeonProject; defaultBranch: NeonBranch }> {
  const projectResponse = await neonRequest<{ project?: NeonProject }>(
    fetchImpl, apiKey, `/projects/${encodeURIComponent(projectId)}`, "project identity lookup",
  );
  const project = projectResponse.project;
  if (!project || project.id !== projectId || !project.org_id || project.effective_project_permission !== "ADMIN") {
    throw new Error("Neon project identity or administrative permission could not be proven.");
  }
  const visibleProjects = await neonRequest<{ projects?: Array<{ id?: string }> }>(
    fetchImpl,
    apiKey,
    `/projects?org_id=${encodeURIComponent(project.org_id)}&limit=100`,
    "project scope lookup",
  );
  if ((visibleProjects.projects ?? []).length !== 1 || visibleProjects.projects?.[0]?.id !== projectId) {
    throw new Error("Neon credential exposes an unexpected project scope.");
  }
  const branchesResponse = await neonRequest<{ branches?: NeonBranch[] }>(
    fetchImpl, apiKey, `/projects/${encodeURIComponent(projectId)}/branches`, "branch inventory lookup",
  );
  const defaults = (branchesResponse.branches ?? []).filter((branch) => branch.default === true);
  if (defaults.length !== 1 || !defaults[0]?.id || defaults[0].name !== PROTECTED_BRANCH_NAME) {
    throw new Error("Neon default production branch could not be proven.");
  }
  return { project, defaultBranch: defaults[0] };
}

function generateBranchName(): string {
  return `lizzor-stage3-test-${randomBytes(12).toString("hex")}`;
}

export async function createDisposableNeonBranch(
  options: NeonBranchHarnessOptions,
): Promise<DisposableNeonBranch> {
  requireTestEnvironment();
  const { apiKey, projectId } = requireCredentials();
  if (!options.sourceVerifiedEmpty) {
    throw new Error("Neon branch source has not been verified empty; refusing branch creation.");
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const { defaultBranch } = await readProjectAndDefault(fetchImpl, apiKey, projectId);
  const branchName = generateBranchName();
  const testRunId = randomUUID();
  const createdAt = new Date().toISOString();
  if (!BRANCH_NAME_PATTERN.test(branchName)) {
    throw new Error("Generated Neon branch name failed the internal safety check.");
  }
  const ownershipDir = options.ownershipDir ? path.resolve(options.ownershipDir) : defaultOwnershipDir();
  await writeOwnershipRecord(ownershipDir, {
    version: 2, projectId, branchId: null, branchName, testRunId, createdAt,
    parentBranchId: defaultBranch.id, parentBranchName: defaultBranch.name,
    ownershipState: "creating", cleanupState: "pending",
  }, apiKey);
  if (process.env.NEON_CRASH_AFTER_INTENT === "1") process.exit(92);
  const created = await neonRequest<{ branch?: NeonBranch; endpoints?: NeonEndpoint[] }>(
    fetchImpl,
    apiKey,
    `/projects/${encodeURIComponent(projectId)}/branches`,
    "branch creation",
    {
      method: "POST",
      body: JSON.stringify({
        branch: { name: branchName, parent_id: defaultBranch.id },
        endpoints: [{ type: "read_write" }],
      }),
    },
  );
  const branch = created.branch;
  if (!branch || branch.id === defaultBranch.id || branch.name !== branchName || branch.project_id !== projectId
    || branch.parent_id !== defaultBranch.id) {
    throw new Error("Neon returned an unverifiable disposable branch identity.");
  }
  const endpoints = created.endpoints ?? [];
  if (endpoints.length !== 1 || endpoints[0]?.branch_id !== branch.id || endpoints[0].type !== "read_write") {
    throw new Error("Neon returned an unverifiable disposable branch endpoint.");
  }
  const ownershipToken = randomUUID();
  ownedBranches.set(ownershipToken, { projectId, branchId: branch.id, branchName });
  try {
    await writeOwnershipRecord(ownershipDir, {
      version: 2,
      projectId,
      branchId: branch.id,
      branchName,
      testRunId,
      createdAt,
      parentBranchId: defaultBranch.id,
      parentBranchName: defaultBranch.name,
      ownershipState: "owned",
      cleanupState: "pending",
    }, apiKey);
    if (process.env.NEON_CRASH_AFTER_OWNED === "1") process.exit(93);
    const uriResponse = await neonRequest<{ uri?: string }>(
      fetchImpl,
      apiKey,
      `/projects/${encodeURIComponent(projectId)}/connection_uri?branch_id=${encodeURIComponent(branch.id)}&database_name=neondb&role_name=neondb_owner`,
      "branch connection lookup",
    );
    if (!uriResponse.uri || !uriResponse.uri.startsWith("postgres")) {
      throw new Error("Neon disposable branch connection could not be proven.");
    }
    return Object.freeze({
      projectId,
      branchId: branch.id,
      branchName,
      databaseUrl: uriResponse.uri,
      defaultBranchId: defaultBranch.id,
      ownershipToken,
      ownershipDir,
    });
  } catch (error) {
    try {
      await recoverOwnedNeonBranches({ fetchImpl, ownershipDir });
    } catch {
      throw new Error(`Neon branch setup cleanup failed for owned branch ${branch.id} (${branchName}).`);
    }
    throw error instanceof Error ? error : new Error("Neon branch connection setup failed.");
  }
}

export async function deleteOwnedNeonBranch(
  owned: DisposableNeonBranch,
  options: { fetchImpl?: NeonFetch } = {},
): Promise<void> {
  requireTestEnvironment();
  const { apiKey, projectId } = requireCredentials();
  const fetchImpl = options.fetchImpl ?? fetch;
  if (
    owned.projectId !== projectId
    || !owned.branchId
    || owned.branchId === owned.defaultBranchId
    || owned.branchName === PROTECTED_BRANCH_NAME
    || !BRANCH_NAME_PATTERN.test(owned.branchName)
    || !owned.ownershipToken
  ) {
    throw new Error("Neon branch ownership could not be proven; refusing deletion.");
  }
  const recorded = ownedBranches.get(owned.ownershipToken);
  if (
    !recorded
    || recorded.projectId !== owned.projectId
    || recorded.branchId !== owned.branchId
    || recorded.branchName !== owned.branchName
  ) {
    throw new Error("Neon branch ownership could not be proven; refusing deletion.");
  }
  const { defaultBranch } = await readProjectAndDefault(fetchImpl, apiKey, projectId);
  if (defaultBranch.id !== owned.defaultBranchId) {
    throw new Error("Neon default branch changed; refusing disposable branch deletion.");
  }
  const branchesResponse = await neonRequest<{ branches?: NeonBranch[] }>(
    fetchImpl, apiKey, `/projects/${encodeURIComponent(projectId)}/branches`, "owned branch verification",
  );
  const branch = (branchesResponse.branches ?? []).find((candidate) => candidate.id === owned.branchId);
  if (!branch || branch.project_id !== projectId || branch.id === defaultBranch.id || branch.default === true
    || branch.name !== owned.branchName || branch.name === PROTECTED_BRANCH_NAME
    || branch.parent_id !== defaultBranch.id) {
    throw new Error("Neon branch ownership could not be proven; refusing deletion.");
  }
  const journalRecords = await readOwnershipRecords(owned.ownershipDir ?? defaultOwnershipDir(), apiKey);
  const journal = journalRecords.find((entry) => entry.record.branchId === owned.branchId);
  if (!journal || journal.record.ownershipState !== "owned"
    || journal.record.projectId !== projectId
    || journal.record.branchName !== owned.branchName
    || journal.record.parentBranchId !== defaultBranch.id
    || journal.record.parentBranchName !== defaultBranch.name) {
    throw new Error("Neon branch ownership journal could not be proven; refusing deletion.");
  }
  const cleanupStarted = { ...journal.record, ownershipState: "cleanup_started" as const, cleanupState: "in_progress" as const };
  await writeOwnershipRecord(owned.ownershipDir ?? defaultOwnershipDir(), cleanupStarted, apiKey);
  await neonRequest<unknown>(
    fetchImpl,
    apiKey,
    `/projects/${encodeURIComponent(projectId)}/branches/${encodeURIComponent(owned.branchId)}`,
    "owned branch deletion",
    { method: "DELETE" },
  );
  const after = await neonRequest<{ branches?: NeonBranch[] }>(
    fetchImpl, apiKey, `/projects/${encodeURIComponent(projectId)}/branches`, "deletion verification",
  );
  if ((after.branches ?? []).some((candidate) => candidate.id === owned.branchId)) {
    throw new Error("Neon disposable branch still exists after deletion.");
  }
  const finalDefault = (after.branches ?? []).find((candidate) => candidate.default === true);
  if (!finalDefault || finalDefault.id !== owned.defaultBranchId || finalDefault.name !== PROTECTED_BRANCH_NAME) {
    throw new Error("Neon default production branch changed during teardown.");
  }
  ownedBranches.delete(owned.ownershipToken);
  await writeOwnershipRecord(owned.ownershipDir ?? defaultOwnershipDir(), {
    ...cleanupStarted, ownershipState: "cleaned", cleanupState: "complete",
  }, apiKey);
}

/**
 * Recovers only journaled branches whose exact identity still agrees with the
 * current single-project Neon inventory. This intentionally has no in-memory
 * token requirement: it is the process-death recovery path.
 */
export async function recoverOwnedNeonBranches(
  options: { fetchImpl?: NeonFetch; ownershipDir?: string } = {},
): Promise<string[]> {
  requireTestEnvironment();
  const { apiKey, projectId } = requireCredentials();
  const fetchImpl = options.fetchImpl ?? fetch;
  const dir = options.ownershipDir ? path.resolve(options.ownershipDir) : defaultOwnershipDir();
  const recovered: string[] = [];
  for (const entry of await readOwnershipRecords(dir, apiKey)) {
    const record = entry.record;
    if (record.cleanupState === "complete") continue;
    if (record.projectId !== projectId || record.branchName === PROTECTED_BRANCH_NAME) {
      throw new Error("Neon ownership journal record failed project or production protection checks.");
    }
    const { defaultBranch } = await readProjectAndDefault(fetchImpl, apiKey, projectId);
    if (defaultBranch.id !== record.parentBranchId || defaultBranch.name !== record.parentBranchName) {
      throw new Error("Neon ownership journal parent branch no longer matches the protected default.");
    }
    const branches = (await neonRequest<{ branches?: NeonBranch[] }>(
      fetchImpl, apiKey, `/projects/${encodeURIComponent(projectId)}/branches`, "recovery branch verification",
    )).branches ?? [];
    const branch = record.branchId
      ? branches.find((candidate) => candidate.id === record.branchId)
      : branches.find((candidate) => candidate.name === record.branchName);
    if ((record.ownershipState === "creating" || record.ownershipState === "cleanup_started") && !branch) {
      await writeOwnershipRecord(dir, { ...record, branchId: null, ownershipState: "cleaned", cleanupState: "complete" }, apiKey);
      recovered.push(record.testRunId);
      continue;
    }
    if (!branch || branch.project_id !== projectId || branch.id === defaultBranch.id
      || branch.default === true || branch.name !== record.branchName
      || branch.name === PROTECTED_BRANCH_NAME || !BRANCH_NAME_PATTERN.test(branch.name)
      || branch.parent_id !== record.parentBranchId) {
      throw new Error("Neon ownership journal branch identity could not be proven; refusing recovery deletion.");
    }
    const ownedRecord = { ...record, branchId: branch.id, ownershipState: "cleanup_started" as const, cleanupState: "in_progress" as const };
    await writeOwnershipRecord(dir, ownedRecord, apiKey);
    await neonRequest<unknown>(
      fetchImpl, apiKey,
      `/projects/${encodeURIComponent(projectId)}/branches/${encodeURIComponent(branch.id)}`,
      "recovered branch deletion", { method: "DELETE" },
    );
    if (process.env.NEON_CRASH_AFTER_DELETE === "1") process.exit(94);
    const after = (await neonRequest<{ branches?: NeonBranch[] }>(
      fetchImpl, apiKey, `/projects/${encodeURIComponent(projectId)}/branches`, "recovery deletion verification",
    )).branches ?? [];
    const finalDefault = after.find((candidate) => candidate.default === true);
    if (after.some((candidate) => candidate.id === branch.id)
      || !finalDefault || finalDefault.id !== record.parentBranchId || finalDefault.name !== PROTECTED_BRANCH_NAME) {
      throw new Error("Recovered Neon branch deletion could not be verified safely.");
    }
    await writeOwnershipRecord(dir, { ...ownedRecord, ownershipState: "cleaned", cleanupState: "complete" }, apiKey);
    recovered.push(branch.id);
  }
  return recovered;
}


/** Read-only evidence report for the historical orphan; never deletes. */
export async function inspectHistoricalNeonOrphan(
  branchId: string,
  branchName: string,
  options: { fetchImpl?: NeonFetch } = {},
): Promise<{ branchId: string; branchName: string; projectMatches: boolean; defaultProtected: boolean; metadataMatches: boolean; deletable: false }> {
  requireTestEnvironment();
  const { apiKey, projectId } = requireCredentials();
  const fetchImpl = options.fetchImpl ?? fetch;
  const { defaultBranch } = await readProjectAndDefault(fetchImpl, apiKey, projectId);
  const branches = (await neonRequest<{ branches?: NeonBranch[] }>(
    fetchImpl, apiKey, `/projects/${encodeURIComponent(projectId)}/branches`, "orphan inspection",
  )).branches ?? [];
  const branch = branches.find((candidate) => candidate.id === branchId);
  return {
    branchId,
    branchName,
    projectMatches: Boolean(branch?.project_id === projectId),
    defaultProtected: defaultBranch.id !== branchId && defaultBranch.name === PROTECTED_BRANCH_NAME && branchName !== PROTECTED_BRANCH_NAME,
    metadataMatches: Boolean(branch && branch.id === branchId && branch.name === branchName),
    deletable: false,
  };
}

/**
 * Runs a test callback against the derived branch URL and always tears down
 * the exact process-owned branch. The callback is responsible for stopping
 * workers and closing application pools before it resolves.
 */
export async function withDisposableNeonBranch<T>(
  options: NeonBranchHarnessOptions,
  run: (branch: DisposableNeonBranch, closePools: (close: () => Promise<void>) => Promise<void>) => Promise<T>,
): Promise<T> {
  const branch = await createDisposableNeonBranch(options);
  const previousDatabaseUrl = process.env.DATABASE_URL;
  let poolsClosed = false;
  const closePools = async (close: () => Promise<void>): Promise<void> => {
    await close();
    poolsClosed = true;
  };
  process.env.DATABASE_URL = branch.databaseUrl;
  try {
    const result = await run(branch, closePools);
    if (!poolsClosed) {
      throw new Error("Disposable branch callback must close application and migration pools before teardown.");
    }
    return result;
  } finally {
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
    if (poolsClosed) await deleteOwnedNeonBranch(branch, options);
  }
}
