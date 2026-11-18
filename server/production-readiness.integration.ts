import assert from "node:assert/strict";
import { request } from "node:http";
import type { Server } from "node:http";
import { createApp } from "./app.js";
import {
  beginApplicationStartup,
  markApplicationReady,
  markApplicationStartupFailed,
} from "./lib/runtime-status.js";

function get(url: string, host: string, forwardedHeaders: Record<string, string> = {}): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const requestUrl = new URL(url);
    const clientRequest = request({
      hostname: requestUrl.hostname,
      port: requestUrl.port,
      path: requestUrl.pathname,
      headers: { host, ...forwardedHeaders },
    }, (response) => {
      let raw = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { raw += chunk; });
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body: JSON.parse(raw) }));
    });
    clientRequest.on("error", reject);
    clientRequest.end();
  });
}

async function main() {
  beginApplicationStartup();
  const app = await createApp({ serveFrontend: false, enforceStartupReadiness: true });
  const server: Server = await new Promise((resolve) => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Readiness test server did not start.");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    const startingRequest = await get(`${baseUrl}/api/v1/meta`, "shop.example.test");
    assert.equal(startingRequest.status, 503);
    assert.equal(startingRequest.body.error.code, "SERVICE_STARTING");

    const livenessDuringStartup = await get(`${baseUrl}/api/v1/health`, "shop.example.test");
    assert.equal(livenessDuringStartup.status, 200);

    const readiness = await get(`${baseUrl}/api/v1/readiness`, "shop.example.test");
    assert.equal(readiness.status, 503);
    assert.equal(readiness.body.data.status, "degraded");
    assert.equal(readiness.body.data.checks.startup, "starting");
    assert.ok(["connected", "not_configured"].includes(readiness.body.data.checks.database));
    assert.equal(readiness.body.data.checks.sessionSecret, "configured");
    assert.equal(readiness.body.data.checks.paymentProvider, "not_configured");
    assert.equal(readiness.body.data.checks.paymentFrontend, "not_configured");
    assert.equal(readiness.body.data.checks.paymentWebhook, "not_configured");
    assert.ok(["configured", "not_configured"].includes(readiness.body.data.checks.notificationProvider));
    assert.ok(["configured", "not_configured"].includes(readiness.body.data.checks.mediaStorage));
    const paymentConfigDuringStartup = await get(`${baseUrl}/api/v1/payments/config`, "shop.example.test");
    assert.equal(paymentConfigDuringStartup.status, 503);
    assert.equal(paymentConfigDuringStartup.body.error.code, "SERVICE_STARTING");

    markApplicationReady();
    const readyRequest = await get(`${baseUrl}/api/v1/meta`, "shop.example.test");
    assert.equal(readyRequest.status, 200);
    const paymentConfig = await get(`${baseUrl}/api/v1/payments/config`, "shop.example.test");
    assert.equal(paymentConfig.status, 200);
    assert.deepEqual(paymentConfig.body.data, { provider: "stripe", publishableKey: null, returnOrigin: "https://shop.example.test" });

    beginApplicationStartup();
    markApplicationStartupFailed(new Error("private startup detail"));
    const failedRequest = await get(`${baseUrl}/api/v1/meta`, "shop.example.test");
    assert.equal(failedRequest.status, 503);
    assert.equal(failedRequest.body.error.code, "SERVICE_INITIALIZATION_FAILED");
    assert.equal(failedRequest.body.error.message, "The service is temporarily unavailable.");
    assert.equal(JSON.stringify(failedRequest.body).includes("private startup detail"), false);

    markApplicationReady();

    const wwwHost = await get(`${baseUrl}/api/v1/health`, "www.shop.example.test");
    assert.equal(wwwHost.status, 200);

    const replitHost = await get(`${baseUrl}/api/v1/health`, "shop-deployment.replit.app");
    assert.equal(replitHost.status, 200);

    const forwardedHost = await get(`${baseUrl}/api/v1/health`, "127.0.0.1", {
      "x-forwarded-host": "shop.example.test",
      "x-forwarded-proto": "https",
    });
    assert.equal(forwardedHost.status, 200);

    const rejectedForwardedHost = await get(`${baseUrl}/api/v1/health`, "shop.example.test", {
      "x-forwarded-host": "untrusted.example.test",
      "x-forwarded-proto": "https",
    });
    assert.equal(rejectedForwardedHost.status, 421);
    assert.equal(rejectedForwardedHost.body.error.code, "UNTRUSTED_HOST");

    const rejectedHost = await get(`${baseUrl}/api/v1/health`, "untrusted.example.test");
    assert.equal(rejectedHost.status, 421);
    assert.equal(rejectedHost.body.error.code, "UNTRUSTED_HOST");
    console.log("Production startup gate, readiness status, and host protection checks passed.");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});