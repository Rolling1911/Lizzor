import { spawn } from "node:child_process";
import { once } from "node:events";

const port = Number(process.env.PORT ?? 5052);
const baseUrl = `http://127.0.0.1:${port}`;
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const viteStartupPattern = /setupVite|createViteServer|vite\.config|vite dev server/i;

const childEnv: NodeJS.ProcessEnv = { ...process.env, PORT: String(port) };
delete childEnv.NODE_ENV;

const server = spawn(npmCommand, ["start"], {
  detached: process.platform !== "win32",
  env: childEnv,
  stdio: ["ignore", "pipe", "pipe"],
});

let output = "";
const recordOutput = (chunk: Buffer) => {
  output += chunk.toString();
};
server.stdout.on("data", recordOutput);
server.stderr.on("data", recordOutput);

async function stopServer() {
  if (server.exitCode !== null) return;
  const signalServer = (signal: NodeJS.Signals) => {
    try {
      if (process.platform !== "win32" && server.pid) process.kill(-server.pid, signal);
      else server.kill(signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  };
  const exited = once(server, "exit");
  signalServer("SIGTERM");
  await Promise.race([
    exited,
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ]);
  if (server.exitCode === null) {
    signalServer("SIGKILL");
  }
}

try {
  await new Promise<void>((resolve, reject) => {
    const checkOutput = () => {
      if (viteStartupPattern.test(output)) {
        reject(new Error(`Production startup initialized Vite:\n${output}`));
        return;
      }
      if (output.includes("application initialization completed")) {
        resolve();
      }
    };
    server.stdout.on("data", checkOutput);
    server.stderr.on("data", checkOutput);
    server.once("error", reject);
    server.once("exit", (code) => {
      reject(new Error(`Production server exited before becoming ready (code ${code}).\n${output}`));
    });
  });

  const request = (path: string, headers: Record<string, string> = {}) => fetch(`${baseUrl}${path}`, {
    headers,
    signal: AbortSignal.timeout(5_000),
  });

  const storefront = await request("/");
  const storefrontHtml = await storefront.text();
  if (storefront.status !== 200 || !storefrontHtml.includes('<div id="root"></div>')) {
    throw new Error(`Production storefront check failed: HTTP ${storefront.status}`);
  }

  const rejectedInternalApi = await request("/api/v1/health");
  if (rejectedInternalApi.status !== 421) {
    throw new Error(`Internal host exception was broader than GET /: HTTP ${rejectedInternalApi.status}`);
  }

  const health = await request("/api/v1/health", {
    "x-forwarded-host": "lizzor.com",
    "x-forwarded-proto": "https",
  });
  const healthBody = await health.json() as { data?: { status?: string } };
  if (health.status !== 200 || healthBody.data?.status !== "ok") {
    throw new Error(`Production health check failed: HTTP ${health.status}`);
  }

  const readiness = await request("/api/v1/readiness", {
    "x-forwarded-host": "lizzor.com",
    "x-forwarded-proto": "https",
  });
  const readinessBody = await readiness.json() as {
    data?: {
      checks?: {
        startup?: string;
        database?: string;
        recoveryWorker?: string;
      };
    };
  };
  if (
    readiness.status !== 200
    || readinessBody.data?.checks?.startup !== "ready"
    || readinessBody.data?.checks?.database !== "connected"
    || !["idle", "standby"].includes(readinessBody.data?.checks?.recoveryWorker ?? "")
  ) {
    throw new Error(`Production startup did not reach ready state: HTTP ${readiness.status}`);
  }

  if (viteStartupPattern.test(output)) {
    throw new Error(`Production startup initialized Vite:\n${output}`);
  }
  console.log("Production start regression passed: npm start serves the built storefront without Vite.");
} finally {
  await stopServer();
}