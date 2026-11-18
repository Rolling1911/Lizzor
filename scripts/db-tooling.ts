import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

function serviceLine(name: string, value: string): string {
  return `${name}=${value.replaceAll("\\", "\\\\").replaceAll("\n", "\\n")}`;
}

export function databaseIdentity(connectionString: string): string {
  const url = new URL(connectionString);
  return `${url.hostname.toLowerCase()}:${url.port || "5432"}/${url.pathname.replace(/^\//, "")}`;
}

export async function withPgService<T>(connectionString: string, work: (environment: NodeJS.ProcessEnv) => Promise<T>): Promise<T> {
  const url = new URL(connectionString);
  if (!url.hostname || !url.pathname.slice(1)) throw new Error("The database connection string must include a host and database name.");
  const directory = await mkdtemp(path.join(tmpdir(), "lizzor-pg-"));
  const serviceFile = path.join(directory, "pg_service.conf");
  const lines = [
    "[lizzor_operator]",
    serviceLine("host", url.hostname),
    serviceLine("port", url.port || "5432"),
    serviceLine("dbname", decodeURIComponent(url.pathname.slice(1))),
    serviceLine("user", decodeURIComponent(url.username)),
    serviceLine("password", decodeURIComponent(url.password)),
  ];
  const sslmode = url.searchParams.get("sslmode");
  if (sslmode) lines.push(serviceLine("sslmode", sslmode));
  await writeFile(serviceFile, `${lines.join("\n")}\n`, { mode: 0o600 });
  await chmod(directory, 0o700);
  try {
    return await work({ ...process.env, PGSERVICEFILE: serviceFile, PGSERVICE: "lizzor_operator" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function runPg(command: string, args: string[], environment: NodeJS.ProcessEnv): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { env: environment, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-4000); });
    child.once("error", () => reject(new Error(`${command} could not be started. Ensure PostgreSQL client tools are installed.`)));
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`${command} failed with exit code ${code}${stderr ? `: ${stderr}` : "."}`)));
  });
}