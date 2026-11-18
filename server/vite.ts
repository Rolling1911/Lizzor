import type { Express } from "express";
import { static as expressStatic } from "express";
import { createServer as createViteServer, type ViteDevServer } from "vite";
import type { Server as HttpServer } from "node:http";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { env } from "./config/env.js";
import { getSeoPage, injectSeo } from "./seo.js";

export async function setupVite(app: Express, hmrServer?: HttpServer): Promise<ViteDevServer> {
  const replitDevDomain = process.env.REPLIT_DEV_DOMAIN;
  const vite = await createViteServer({
    configFile: fileURLToPath(new URL("../vite.config.ts", import.meta.url)),
    server: {
      middlewareMode: true,
      hmr: hmrServer
        ? {
            server: hmrServer,
            ...(replitDevDomain
              ? {
                  protocol: "wss" as const,
                  host: replitDevDomain,
                  clientPort: 443,
                }
              : {}),
          }
        : false,
    },
    appType: "custom",
  });
  app.use(vite.middlewares);
  app.use(async (request, response, next) => {
    if (request.method !== "GET" || request.path.includes(".")) return next();
    try {
      const page = await getSeoPage(request);
      if (page.redirectPath) return response.redirect(301, page.redirectPath);
      const template = await readFile(path.resolve(process.cwd(), "index.html"), "utf8");
      const html = await vite.transformIndexHtml(request.originalUrl, injectSeo(template, page, env.APP_ORIGIN?.replace(/\/$/, "") ?? `${request.protocol}://${request.get("host")}`));
      response.status(page.statusCode ?? 200).type("html").send(html);
    } catch (error) { next(error); }
  });
  return vite;
}

export function serveStatic(app: Express): void {
  const clientPath = path.resolve(process.cwd(), "dist/client");
  app.use(expressStatic(clientPath));
  app.use(async (request, response, next) => {
    if (request.method !== "GET" || request.path.includes(".")) return next();
    try {
      const page = await getSeoPage(request);
      if (page.redirectPath) return response.redirect(301, page.redirectPath);
      const template = await readFile(path.join(clientPath, "index.html"), "utf8");
      const origin = env.APP_ORIGIN?.replace(/\/$/, "") ?? (env.NODE_ENV === "production" ? "" : `${request.protocol}://${request.get("host")}`);
      response.status(page.statusCode ?? 200).type("html").send(injectSeo(template, page, origin));
    } catch (error) { next(error); }
  });
}