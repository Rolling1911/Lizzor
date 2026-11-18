import assert from "node:assert/strict";
import type { Server } from "node:http";
import { execFileSync } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { chromium, type Page } from "playwright";
import { createApp } from "../app.js";
import { hashPassword } from "../auth/password.js";
import { closeDatabase, getDatabasePool } from "../db/client.js";
import { assertMutableIntegrationTestDatabase } from "../testing/database-safety.js";

const password = "ReportsResponsiveTestPassword1";
const marker = `reports-responsive-${Date.now()}-${Math.random().toString(16).slice(2)}`;
const screenshotDir = "/tmp/lizzor-reports-regression";
const routes = ["overview", "sales", "orders", "products", "customers", "promotions", "inventory", "margin", "fulfillment", "returns"] as const;
const titles = ["Analytics overview", "Sales report", "Orders report", "Products report", "Customers report", "Promotions report", "Inventory report", "Margin report", "Fulfillment report", "Returns report"];

function chromiumPath() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  try { return execFileSync("which", ["chromium"], { encoding: "utf8" }).trim(); }
  catch { return "/nix/store/qa9cnw4v5xkxyip6mb9kxqfq1z4x2dx1-chromium-138.0.7204.100/bin/chromium"; }
}

async function login(page: Page, email: string) {
  await page.goto("/admin/login", { waitUntil: "networkidle" });
  const result = await page.evaluate(async ({ email, password }) => {
    await fetch("/api/v1/auth/me", { credentials: "include" });
    const csrf = decodeURIComponent(document.cookie.match(/(?:^|; )lizzor_csrf=([^;]*)/)?.[1] ?? "");
    const response = await fetch("/api/v1/auth/admin/login", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json", "x-csrf-token": csrf },
      body: JSON.stringify({ email, password }),
    });
    return { status: response.status, body: await response.text() };
  }, { email, password });
  assert.equal(result.status, 200, `admin browser login failed: ${result.body}`);
}

async function assertNoOverflow(page: Page, route: string, width: number) {
  const metrics = await page.evaluate(() => {
    const viewport = document.documentElement.clientWidth;
    const overflow = [...document.querySelectorAll("body *")].filter((element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      if (style.display === "none" || style.visibility === "hidden" || style.position === "fixed" || rect.right <= 0 || rect.left >= viewport || rect.left >= -1 && rect.right <= viewport + 1) return false;
      let parent = element.parentElement;
      while (parent && parent !== document.body) {
        const parentStyle = getComputedStyle(parent);
        const parentRect = parent.getBoundingClientRect();
        if ((parentStyle.overflowX === "auto" || parentStyle.overflowX === "scroll") && parentRect.left >= -1 && parentRect.right <= viewport + 1) return false;
        parent = parent.parentElement;
      }
      return true;
    }).slice(0, 5).map((element) => `${element.tagName.toLowerCase()} ${Math.round(element.getBoundingClientRect().right)}`);
    return { documentWidth: document.documentElement.scrollWidth, bodyWidth: document.body.scrollWidth, viewport, overflow };
  });
  assert.ok(metrics.documentWidth <= metrics.viewport + 1, `${route} overflows document at ${width}px`);
  assert.ok(metrics.bodyWidth <= metrics.viewport + 1, `${route} overflows body at ${width}px`);
  assert.deepEqual(metrics.overflow, [], `${route} has visible viewport overflow at ${width}px`);
}

async function waitForReport(page: Page, route: string) {
  await page.waitForFunction(() => !document.body.innerText.includes("Loading verified analytics…"), null, { timeout: 15_000 });
  const visibleError = page.locator('[role="alert"]:visible, .error-state:visible');
  assert.equal(await visibleError.count(), 0, `${route} rendered a visible error state: ${await page.locator("body").innerText()}`);
  const body = await page.locator("body").innerText();
  assert.doesNotMatch(body, /unsupported filter|filter (?:is )?not supported/i, `${route} rendered an unsupported-filter message`);
}

async function exerciseDateFilters(page: Page) {
  await page.getByRole("button", { name: "7 days" }).click();
  await waitForReport(page, "date preset");
  await page.getByRole("button", { name: "Custom" }).click();
  const dates = page.locator('input[type="date"]');
  assert.equal(await dates.count(), 2);
  const end = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const start = new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10);
  await dates.nth(0).fill(start);
  await dates.nth(1).fill(end);
  await waitForReport(page, "custom date range");
}

async function run() {
  assertMutableIntegrationTestDatabase("reports responsive integration");
  const pool = getDatabasePool();
  const app = await createApp({ serveFrontend: true });
  const server: Server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const baseURL = `http://127.0.0.1:${address.port}`;
  const userId = (await pool.query("INSERT INTO users (email,password_hash,first_name,last_name,status,email_verified_at) VALUES ($1,$2,'Reports','Smoke','active',now()) RETURNING id", [`${marker}@example.test`, await hashPassword(password)])).rows[0].id as string;
  const roleId = (await pool.query("INSERT INTO admin_roles (name) VALUES ($1) RETURNING id", [marker])).rows[0].id as string;
  const permissions = ["analytics.view", "analytics.sales", "analytics.customers", "analytics.inventory", "analytics.margin", "analytics.promotions", "reports.view", "reports.export"];
  try {
    await pool.query("INSERT INTO admin_permissions (permission_key) SELECT unnest($1::text[]) ON CONFLICT (permission_key) DO NOTHING", [permissions]);
    await pool.query("INSERT INTO admin_role_permissions (role_id,permission_id) SELECT $1,id FROM admin_permissions WHERE permission_key=ANY($2::text[])", [roleId, permissions]);
    await pool.query("INSERT INTO admin_user_roles (user_id,role_id) VALUES ($1,$2)", [userId, roleId]);
    await rm(screenshotDir, { force: true, recursive: true });
    await mkdir(screenshotDir, { recursive: true });
    const browser = await chromium.launch({ executablePath: chromiumPath(), headless: true, args: ["--no-sandbox"] });
    try {
      const context = await browser.newContext({ baseURL, viewport: { width: 1280, height: 800 } });
      const page = await context.newPage();
      const browserErrors: string[] = [];
      page.on("pageerror", (error) => browserErrors.push(error.stack ?? error.message));
      page.on("console", (message) => { if (message.type() === "error") browserErrors.push(message.text()); });
      await login(page, `${marker}@example.test`);
      for (const [index, route] of routes.entries()) {
        await page.setViewportSize(index % 2 ? { width: 390, height: 844 } : { width: 1280, height: 800 });
        const path = route === "sales" ? "/admin/reports" : `/admin/reports/${route}`;
        await page.goto(path, { waitUntil: "networkidle" });
        await waitForReport(page, route);
        const heading = page.locator("h1").first();
        assert.ok(await heading.count(), `${route} has no page title at ${page.url()}: ${(await page.locator("body").innerText()).slice(0, 500)} ${browserErrors.join("\n").slice(0, 2_000)}`);
        assert.equal(await heading.textContent(), titles[index], `${route} title`);
        const active = page.locator(".analytics-nav a.is-active");
        assert.equal(await active.count(), 1, `${route} active report tab`);
        assert.equal((await active.textContent())?.trim(), route === "margin" ? "Product contribution" : route[0]!.toUpperCase() + route.slice(1), `${route} active tab`);
        await assertNoOverflow(page, route, index % 2 ? 390 : 1280);
        if (route === "overview") await exerciseDateFilters(page);
        if (route === "overview" || route === "sales") await page.screenshot({ path: `${screenshotDir}/${route}-${index % 2 ? "mobile" : "desktop"}.png`, fullPage: true });
      }
      await context.close();
    } finally { await browser.close(); }
  } finally {
    await pool.query("DELETE FROM audit_logs WHERE actor_user_id=$1", [userId]);
    await pool.query("DELETE FROM auth_sessions WHERE user_id=$1", [userId]);
    await pool.query("DELETE FROM admin_user_roles WHERE user_id=$1", [userId]);
    await pool.query("DELETE FROM admin_role_permissions WHERE role_id=$1", [roleId]);
    await pool.query("DELETE FROM admin_roles WHERE id=$1", [roleId]);
    await pool.query("DELETE FROM users WHERE id=$1", [userId]);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await closeDatabase();
  }
}

run().catch((error) => { console.error(error); process.exitCode = 1; });