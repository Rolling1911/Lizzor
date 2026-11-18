import assert from "node:assert/strict";
import { createHash, createDecipheriv, randomUUID } from "node:crypto";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { closeDatabase, getDatabasePool } from "../server/db/client.js";
import { env } from "../server/config/env.js";

const baseURL = process.env.BROWSER_BASE_URL ?? "http://127.0.0.1:5000";
const marker = `browser-${Date.now().toString(36)}-${randomUUID().slice(0, 12)}`;
const password = "BrowserSmoke-Password-2026!";
const productName = `AAA ${marker} Product`;
const orderIds: string[] = [];
let categoryId = "";
let productId = "";
let warehouseId = "";
const address = {
  firstName: "Browser",
  lastName: "Verifier",
  addressLine1: "1 Test Street",
  city: "Nicosia",
  postalCode: "1000",
  countryCode: "CY",
  phone: "+35700000000",
};

const emailFor = (role: string) => `${marker}-${role}@example.test`;
const secretKey = () => createHash("sha256").update(env.SESSION_SECRET ?? "development-only-notification-key").digest();

function decryptNotificationSecret(value: string): string {
  const [iv, tag, encrypted] = value.split(".");
  if (!iv || !tag || !encrypted) throw new Error("Invalid invitation notification secret.");
  const decipher = createDecipheriv("aes-256-gcm", secretKey(), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(encrypted, "base64url")), decipher.final()]).toString("utf8");
}

async function waitForText(page: Page, text: RegExp | string) {
  await page.getByText(text).first().waitFor({ state: "visible", timeout: 15_000 });
}

async function fillCheckout(page: Page, email: string) {
  const values: Record<string, string> = {
    email,
    phone: address.phone,
    firstName: address.firstName,
    lastName: address.lastName,
    addressLine1: address.addressLine1,
    city: address.city,
    postalCode: address.postalCode,
    countryCode: address.countryCode,
  };
  for (const [name, value] of Object.entries(values)) {
    await page.locator(`input[name="${name}"]`).first().fill(value);
  }
}

async function addFirstProduct(page: Page) {
  await page.goto(`/products/${marker}-product`);
  const addButton = page.locator(".purchase-panel").getByRole("button", { name: "Add to cart" });
  await addButton.waitFor({ state: "visible", timeout: 15_000 });
  const [response] = await Promise.all([
    page.waitForResponse((candidate) => candidate.url().includes("/cart/items") && candidate.request().method() === "POST"),
    addButton.click(),
  ]);
  assert.ok(response.ok(), `Add to cart failed with HTTP ${response.status()}.`);
}

async function placeOrder(page: Page, email: string, expected: RegExp) {
  await page.goto("/checkout");
  await page.locator('input[name="email"]').first().waitFor({ state: "visible", timeout: 15_000 });
  await fillCheckout(page, email);
  await page.getByRole("button", { name: "Validate totals" }).click();
  const validationNotice = page.locator(".commerce-notice").filter({
    hasText: /available at the displayed total|authoritative price, promotion, or shipping total changed/i,
  });
  await validationNotice.waitFor({ state: "visible", timeout: 15_000 });
  const acknowledgement = page.locator(".check-line--ack input");
  if (await acknowledgement.count()) await acknowledgement.check();
  await page.getByRole("button", { name: "Place order" }).click();
  await waitForText(page, expected);
  return page.url();
}

async function registerPersonal(page: Page, email: string) {
  await page.goto("/register");
  await page.locator('input[name="firstName"]').fill("Browser");
  await page.locator('input[name="lastName"]').fill("Verifier");
  await page.locator('input[name="email"]').fill(email);
  await page.locator('select[name="countryCode"]').selectOption("CY");
  await page.locator('input[name="phone"]').fill("99123456");
  await page.locator('input[name="password"]').fill(password);
  await page.locator('input[name="confirmPassword"]').fill(password);
  await page.getByRole("button", { name: "Create personal account" }).click();
  await page.waitForURL(/\/account(?:$|\/)/, { timeout: 15_000 });
}

async function registerBusiness(page: Page, email: string, name: string) {
  await page.goto("/start-a-business");
  const fields: Record<string, string> = {
    firstName: "Browser",
    lastName: "Owner",
    email,
    phone: "99123456",
    password,
    confirmPassword: password,
    companyName: name,
    vatNumber: `VAT-${createHash("sha256").update(name).digest("hex").slice(0, 20)}`,
    contactPerson: "Browser Owner",
    companyEmail: email,
    companyPhone: "22333333",
  };
  for (const [field, value] of Object.entries(fields)) {
    await page.locator(`input[name="${field}"]`).fill(value);
  }
  await page.locator('select[name="countryCode"]').selectOption("CY");
  const invalidFields = await page.locator("form input:invalid").evaluateAll((inputs) =>
    inputs.map((input) => ({ name: (input as HTMLInputElement).name, message: (input as HTMLInputElement).validationMessage })),
  );
  assert.deepEqual(invalidFields, [], `Business registration has invalid fields: ${JSON.stringify(invalidFields)}`);
  const [response] = await Promise.all([
    page.waitForResponse((candidate) => candidate.url().includes("/auth/register/business") && candidate.request().method() === "POST"),
    page.getByRole("button", { name: "Create business account" }).click(),
  ]);
  if (!response.ok()) throw new Error(`Business registration failed with HTTP ${response.status()}: ${await response.text()}`);
  await page.goto("/account");
}

async function apiStatus(page: Page, path: string) {
  return page.evaluate(async (url) => {
    const response = await fetch(url, { credentials: "include" });
    return { status: response.status, body: await response.json().catch(() => null) };
  }, `/api/v1${path}`);
}

async function invitationToken(invitedEmail: string): Promise<string> {
  const pool = getDatabasePool();
  const row = (await pool.query(
    `SELECT encrypted_secret FROM notification_deliveries
      WHERE recipient_email=$1 AND event_type='company.invitation'
      ORDER BY created_at DESC LIMIT 1`,
    [invitedEmail],
  )).rows[0];
  assert.ok(row?.encrypted_secret, "Invitation notification was not persisted.");
  return decryptNotificationSecret(row.encrypted_secret);
}

async function createCatalogFixture() {
  const pool = getDatabasePool();
  categoryId = (await pool.query(
    "INSERT INTO categories (name,slug,description) VALUES ($1,$2,$3) RETURNING id",
    [`${marker} Category`, `${marker}-category`, marker],
  )).rows[0].id;
  productId = (await pool.query(
    `INSERT INTO products
      (name,slug,parent_sku,category_id,description,cost_price,base_price,vat_rate,weight,status,published_at)
      VALUES ($1,$2,$3,$4,$5,4,12,19,1,'active',now()) RETURNING id`,
    [productName, `${marker}-product`, `${marker}-sku`, categoryId, marker],
  )).rows[0].id;
  warehouseId = (await pool.query(
    "INSERT INTO warehouses (name,code,country_code) VALUES ($1,$2,'CY') RETURNING id",
    [`${marker} Warehouse`, `${marker}-wh`],
  )).rows[0].id;
  await pool.query(
    "INSERT INTO inventory (warehouse_id,product_id,quantity_on_hand,quantity_reserved,low_stock_threshold) VALUES ($1,$2,100,0,5)",
    [warehouseId, productId],
  );
}

async function main() {
  const contexts: BrowserContext[] = [];
  let browser: Browser | null = null;
  let clientIp = 10;
  let ownerCompanyId = "";
  let otherCompanyId = "";
  try {
    await createCatalogFixture();
    browser = await chromium.launch({
      executablePath: process.env.CHROMIUM_PATH ?? "/nix/store/qa9cnw4v5xkxyip6mb9kxqfq1z4x2dx1-chromium-138.0.7204.100/bin/chromium",
      headless: true,
      args: ["--no-sandbox"],
    });
    const newContext = () => browser!.newContext({
      baseURL,
      extraHTTPHeaders: { "x-forwarded-for": `198.51.100.${clientIp++}` },
    });
    // Guest checkout and guest order confirmation.
    const guestContext = await newContext();
    contexts.push(guestContext);
    const guest = await guestContext.newPage();
    await addFirstProduct(guest);
    const guestConfirmation = await placeOrder(guest, emailFor("guest"), /We have your order/i);
    assert.match(guestConfirmation, /\/checkout$/);
    const guestOrderLink = guest.getByRole("link", { name: "View confirmation" });
    orderIds.push((await guestOrderLink.getAttribute("href"))!.split("/").pop()!);
    await guestOrderLink.click();
    await waitForText(guest, /Order timeline|Payment status|Order confirmation/i);
    console.log("PASS guest checkout and order confirmation");

    // Create an account, log out in the same browser, then prove the guest
    // cart is claimed by an existing-account login before checkout.
    const customerContext = await newContext();
    contexts.push(customerContext);
    const customer = await customerContext.newPage();
    const customerEmail = emailFor("customer");
    await registerPersonal(customer, customerEmail);
    await customer.evaluate(async () => {
      const csrf = document.cookie.split("; ").find((entry) => entry.startsWith("lizzor_csrf="))?.split("=")[1];
      if (!csrf) throw new Error("CSRF cookie missing before logout.");
      const response = await fetch("/api/v1/auth/logout", {
        method: "POST",
        headers: { "x-csrf-token": decodeURIComponent(csrf) },
      });
      if (!response.ok) throw new Error(`Logout failed with HTTP ${response.status}.`);
    });
    await addFirstProduct(customer);
    await customer.goto("/login");
    await customer.locator('input[name="email"]').fill(customerEmail);
    await customer.locator('input[name="password"]').fill(password);
    await customer.getByRole("button", { name: "Sign in" }).click();
    await customer.waitForURL(/\/account(?:$|\/)/, { timeout: 15_000 });
    await customer.goto("/cart");
    await customer.locator(".cart-item").first().waitFor({ state: "visible", timeout: 15_000 });
    await placeOrder(customer, customerEmail, /We have your order/i);
    const customerOrderLink = customer.getByRole("link", { name: "View order" });
    orderIds.push((await customerOrderLink.getAttribute("href"))!.split("/").pop()!);
    await customerOrderLink.click();
    await waitForText(customer, /Payment status|Delivery & returns|Order timeline/i);
    console.log("PASS guest cart to existing-account login and authenticated checkout");

    // Owner creates a company-admin invitation through the rendered company
    // workspace. The invitation token is read from the persisted notification
    // only because email delivery is intentionally not configured here.
    const ownerContext = await newContext();
    contexts.push(ownerContext);
    const owner = await ownerContext.newPage();
    const ownerEmail = emailFor("owner");
    const companyName = `${marker} Company`;
    await registerBusiness(owner, ownerEmail, companyName);
    await owner.goto("/account/companies");
    await owner.getByRole("button", { name: "Open company" }).first().click();
    await owner.getByRole("link", { name: "Members" }).click();
    await waitForText(owner, /People with access/i);
    const adminEmail = emailFor("company-admin");
    await owner.getByRole("button", { name: /Invite member/i }).click();
    await owner.locator('input[name="email"]').fill(adminEmail);
    await owner.locator('select[name="role"]').selectOption("admin");
    await owner.getByRole("button", { name: "Send invitation" }).click();
    await waitForText(owner, /Invitation sent/i);
    const companies = await apiStatus(owner, "/account/companies");
    ownerCompanyId = companies.body?.data?.items?.[0]?.id ?? companies.body?.data?.[0]?.id;
    assert.ok(ownerCompanyId, "Owner company ID was not available.");
    console.log("PASS company invitation creation");

    const adminContext = await newContext();
    contexts.push(adminContext);
    const admin = await adminContext.newPage();
    await registerPersonal(admin, adminEmail);
    const token = await invitationToken(adminEmail);
    await admin.goto(`/account/invitations/accept?token=${encodeURIComponent(token)}`);
    await admin.getByRole("button", { name: /Accept invitation/i }).click();
    await waitForText(admin, /Invitation accepted/i);
    console.log("PASS invitation acceptance");

    await admin.goto(`/account/companies/${ownerCompanyId}/members`);
    await admin.getByRole("button", { name: /Invite member/i }).click();
    await admin.locator('input[name="email"]').fill(emailFor("forbidden-admin"));
    await admin.locator('select[name="role"]').selectOption("admin");
    await admin.getByRole("button", { name: "Send invitation" }).click();
    await waitForText(admin, /Only an owner may invite a company administrator/i);
    console.log("PASS owner-only admin invitation boundary");

    // The sole owner cannot remove themself and leave the company ownerless.
    await owner.goto(`/account/companies/${ownerCompanyId}/members`);
    const ownerRow = owner.locator("tr").filter({ hasText: ownerEmail });
    await ownerRow.getByRole("button", { name: "Remove" }).click();
    await waitForText(owner, /company must retain at least one active owner/i);
    console.log("PASS last-owner protection");

    // Disable the company and verify the browser session loses access.
    const pool = getDatabasePool();
    await pool.query("UPDATE companies SET status='suspended' WHERE id=$1", [ownerCompanyId]);
    await admin.goto(`/account/companies/${ownerCompanyId}`);
    await waitForText(admin, /You do not have access to this company/i);
    console.log("PASS disabled company handling");
    await pool.query("UPDATE companies SET status='active' WHERE id=$1", [ownerCompanyId]);

    // Create an unrelated company and prove the authenticated admin cannot
    // read its company order scope.
    const otherContext = await newContext();
    contexts.push(otherContext);
    const otherOwner = await otherContext.newPage();
    await registerBusiness(otherOwner, emailFor("other-owner"), `${marker} Other Company`);
    const otherCompanies = await apiStatus(otherOwner, "/account/companies");
    otherCompanyId = otherCompanies.body?.data?.items?.[0]?.id ?? otherCompanies.body?.data?.[0]?.id;
    assert.ok(otherCompanyId, "Other company ID was not available.");
    const crossCompany = await apiStatus(admin, `/account/orders?scope=company&companyId=${encodeURIComponent(otherCompanyId)}`);
    assert.equal(crossCompany.status, 403);
    console.log("PASS cross-company order visibility and authorization");

    console.log("All production browser smoke flows passed.");
  } finally {
    const pool = getDatabasePool();
    if (orderIds.length) await pool.query("DELETE FROM audit_logs WHERE entity_id=ANY($1::uuid[])", [orderIds]).catch(() => undefined);
    await pool.query("DELETE FROM audit_logs WHERE actor_user_id IN (SELECT id FROM users WHERE email LIKE $1)", [`${marker}%`]).catch(() => undefined);
    if (orderIds.length) await pool.query("DELETE FROM orders WHERE id=ANY($1::uuid[])", [orderIds]).catch(() => undefined);
    await pool.query(`DELETE FROM company_invitations WHERE email LIKE $1`, [`${marker}%`]).catch(() => undefined);
    await pool.query(`DELETE FROM companies WHERE company_name LIKE $1`, [`${marker}%`]).catch(() => undefined);
    await pool.query(`DELETE FROM users WHERE email LIKE $1`, [`${marker}%`]).catch(() => undefined);
    if (productId) {
      await pool.query("DELETE FROM recently_viewed_products WHERE product_id=$1", [productId]);
      await pool.query("DELETE FROM wishlist_items WHERE product_id=$1", [productId]);
      await pool.query("DELETE FROM cart_items WHERE product_id=$1", [productId]);
      await pool.query("DELETE FROM inventory_movements WHERE product_id=$1", [productId]);
      await pool.query("DELETE FROM order_items WHERE product_id=$1", [productId]);
      await pool.query("DELETE FROM products WHERE id=$1", [productId]);
    }
    if (warehouseId) await pool.query("DELETE FROM warehouses WHERE id=$1", [warehouseId]);
    if (categoryId) await pool.query("DELETE FROM categories WHERE id=$1", [categoryId]);
    if (productId) assert.equal(Number((await pool.query("SELECT count(*) AS count FROM products WHERE id=$1", [productId])).rows[0].count), 0, "browser fixture product cleanup failed");
    if (categoryId) assert.equal(Number((await pool.query("SELECT count(*) AS count FROM categories WHERE id=$1", [categoryId])).rows[0].count), 0, "browser fixture category cleanup failed");
    await Promise.all(contexts.map((context) => context.close().catch(() => undefined)));
    if (browser) await browser.close();
    await closeDatabase();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});