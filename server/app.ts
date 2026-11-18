import express from "express";
import type { Server as HttpServer } from "node:http";
import { apiRouter } from "./api/index.js";
import { ensureCsrfCookie } from "./auth/cookies.js";
import { env } from "./config/env.js";
import { authMiddleware } from "./middleware/auth.js";
import { errorHandler, notFoundHandler } from "./middleware/error-handler.js";
import { requestContext } from "./middleware/request-context.js";
import { productionHostProtection, replitProxyTrust, securityMiddleware } from "./middleware/security.js";
import { serveStatic, setupVite } from "./vite.js";
import { catalogMediaMiddleware } from "./catalog/storage.js";
import { sitemap } from "./seo.js";
import { getApplicationStartupStatus } from "./lib/runtime-status.js";

export async function createApp(options: { serveFrontend?: boolean; enforceStartupReadiness?: boolean; viteHmrServer?: HttpServer } = {}) {
  const app = express();
  app.set("trust proxy", replitProxyTrust);
  app.disable("x-powered-by");
  app.use(productionHostProtection);
  app.use(...securityMiddleware);
  // Establish correlation before parsers so malformed request bodies are
  // correlated by the error handler too.
  app.use(requestContext);
  if (options.enforceStartupReadiness) {
    app.use((request, response, next) => {
      const startup = getApplicationStartupStatus();
      const probePath = request.path === "/api/v1/health" || request.path === "/api/v1/readiness";
      if (startup.state === "ready" || probePath) {
        next();
        return;
      }
      response
        .status(503)
        .set("Retry-After", "1")
        .json({
          error: {
            code: startup.state === "failed" ? "SERVICE_INITIALIZATION_FAILED" : "SERVICE_STARTING",
            message: startup.state === "failed"
              ? "The service is temporarily unavailable."
              : "The service is starting. Please retry shortly.",
          },
        });
    });
  }
  app.use("/api/v1/payments/webhook", express.raw({ type: "application/json", limit: "1mb" }));
  app.use("/api/v1/webhooks/resend", express.raw({ type: "application/json", limit: "1mb" }));
  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ extended: false }));
  app.use((req, res, next) => {
    ensureCsrfCookie(req, res);
    next();
  });
  app.use(authMiddleware);
  app.get("/robots.txt", (request, response) => {
    const origin = env.APP_ORIGIN?.replace(/\/$/, "") ?? (env.NODE_ENV === "production" ? "" : `${request.protocol}://${request.get("host")}`);
    response.type("text/plain").send(`User-agent: *\nAllow: /\nSitemap: ${origin}/sitemap.xml\n`);
  });
  app.get("/sitemap.xml", async (request, response) => {
    const origin = env.APP_ORIGIN?.replace(/\/$/, "") ?? (env.NODE_ENV === "production" ? "" : `${request.protocol}://${request.get("host")}`);
    response.type("application/xml").send(await sitemap(origin));
  });
  app.use("/api/v1", apiRouter);
  catalogMediaMiddleware(app);

  if (options.serveFrontend !== false) {
    if (env.NODE_ENV === "development") await setupVite(app, options.viteHmrServer);
    else serveStatic(app);
  }

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}