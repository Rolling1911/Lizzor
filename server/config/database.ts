import { checkDatabaseConnection } from "../db/client.js";
import { databaseConfigured } from "./env.js";

export interface DatabaseConfig {
  provider: "postgresql";
  configured: boolean;
}

export type DatabaseReadiness = "connected" | "not_configured" | "unavailable";

export const databaseConfig: DatabaseConfig = {
  provider: "postgresql",
  configured: databaseConfigured,
};

export async function getDatabaseReadiness(): Promise<DatabaseReadiness> {
  if (!databaseConfig.configured) {
    return "not_configured";
  }

  return (await checkDatabaseConnection()) ? "connected" : "unavailable";
}