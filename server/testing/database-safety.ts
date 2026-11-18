import { env } from "../config/env.js";

export function assertMutableIntegrationTestDatabase(suiteName: string) {
  if (env.NODE_ENV !== "test") {
    throw new Error(`${suiteName} requires NODE_ENV=test before it may create database fixtures.`);
  }
  if (process.env.REPLIT_DEPLOYMENT === "1") {
    throw new Error(`${suiteName} is disabled in published Replit deployments.`);
  }
}