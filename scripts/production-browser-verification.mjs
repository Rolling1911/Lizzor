import assert from "node:assert/strict";
import crypto from "node:crypto";
import { chromium } from "playwright";

const origin = process.env.PRODUCTION_ORIGIN ?? "https://lizzor.com";
const executablePath = process.env.CHROMIUM_PATH ?? "chromium";
const marker = `launch-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;
const password = `Launch-${crypto.randomBytes(12).toString("base64url")}1a`;
const evidence = [];
let buyerPage;
let testOrder;

async function mail(path, init = {}) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const response = await fetch(`https://api.mail.tm${path}`, {
      ...init,
      headers: { "content-type": "application/json", ...init.headers },
    });
    const text = await response.text();
    const data = text ? JSON.parse(text) : null;
    if (response.ok) return data;
    if (response.status !== 429 || attempt === 5) {
      throw new Error(`mail.tm ${response.status}: ${JSON.stringify(data)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000 * (attempt + 1)));
  }
}

async function createInbox(label) {
  const domains = await mail("/domains?page=1");
  const domain = domains["hydra:member"][0].domain;
  const address = `${marker}-${label}@${domain}`;
  await mail("/accounts", { method: "POST", body: JSON.stringify({ address, password }) });
  const token = await mail("/token", { method: "POST", body: JSON.stringify({ address, password }) });
  return { address, token: token.token };
}

async function invitationLink(inbox, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const messages = await mail("/messages?page=1", { headers: { authorization: `Bearer ${inbox.token}` } });
    const invitation = messages["hydra:member"].find((message) => /invitation/i.test(message.subject));
    if (invitation) {
      const detail = await mail(`/messages/${invitation.id}`, { headers: { authorization: `Bearer ${inbox.token}` } });
      const text = [detail.text, ...(detail.html ?? [])].flat().join("\n");
      const match = text.match(/https:\/\/lizzor\.com\/account\/invitations\/accept\?token=[A-Za-z0-9_%.-]+/);
      if (match) return match[0].replaceAll("&amp;", "&");
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(`Invitation email did not arrive for ${inbox.address}`);
}

async function api(page, path, { method = "GET", body, headers = {} } = {}) {
  const result = await page.evaluate(async ({ path, method, body, headers }) => {
    const readCookie = (name) => document.cookie.split("; ").find((item) => item.startsWith(`${name}=`))?.split("=").slice(1).join("=");
    if (!["GET", "HEAD", "OPTIONS"].includes(method) && !readCookie("lizzor_csrf")) {
      await fetch("/api/v1/auth/me", { credentials: "include" });
    }
    const requestHeaders = { ...headers };
    if (body !== undefined) requestHeaders["content-type"] = "application/json";
    const csrf = readCookie("lizzor_csrf");
    if (csrf && !["GET", "HEAD", "OPTIONS"].includes(method)) requestHeaders["x-csrf-token"] = decodeURIComponent(csrf);
    const response = await fetch(`/api/v1${path}`, {
      method,
      credentials: "include",
      headers: requestHeaders,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const payload = response.status === 204 ? null : await response.json();
    return { status: response.status, payload };
  }, { path, method, body, headers });
  return result;
}

async function session(browser) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  await page.goto(origin, { waitUntil: "networkidle" });
  return { context, page };
}

async function registerPersonal(page, email, firstName) {
  const result = await api(page, "/auth/register", {
    method: "POST",
    body: {
      firstName,
      lastName: "LaunchCheck",
      email,
      phone: "+35799123456",
      countryCode: "CY",
      password,
      confirmPassword: password,
    },
  });
  assert.equal(result.status, 201, JSON.stringify(result.payload));
}

async function registerBusiness(page, email, label) {
  const result = await api(page, "/auth/register/business", {
    method: "POST",
    body: {
      firstName: label, lastName: "LaunchCheck", email, phone: "+35799123456", countryCode: "CY", password, confirmPassword: password,
      companyName: `${marker}-${label}`, vatNumber: `VAT-${marker}-${label}`,
      contactPerson: `${label} LaunchCheck`, companyEmail: email, companyPhone: "+35799123456", countryCode: "CY",
    },
  });
  assert.equal(result.status, 201, JSON.stringify(result.payload));
}

const browser = await chromium.launch({ executablePath, headless: true, args: ["--no-sandbox"] });
const opened = [];
try {
  const inboxes = {};
  for (const label of ["buyer", "owner", "admin", "wrong", "companyb", "revoked"]) {
    inboxes[label] = await createInbox(label);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }

  const buyerSeed = await session(browser); opened.push(buyerSeed.context);
  await registerPersonal(buyerSeed.page, inboxes.buyer.address, "Buyer");
  await api(buyerSeed.page, "/auth/logout", { method: "POST" });

  const owner = await session(browser); opened.push(owner.context);
  await registerBusiness(owner.page, inboxes.owner.address, "Owner");
  const ownerCompanies = await api(owner.page, "/account/companies");
  const companyA = ownerCompanies.payload.data[0].id;

  const admin = await session(browser); opened.push(admin.context);
  await registerPersonal(admin.page, inboxes.admin.address, "Admin");
  const wrong = await session(browser); opened.push(wrong.context);
  await registerPersonal(wrong.page, inboxes.wrong.address, "Wrong");
  const companyB = await session(browser); opened.push(companyB.context);
  await registerBusiness(companyB.page, inboxes.companyb.address, "CompanyB");

  const buyer = await session(browser); opened.push(buyer.context);
  buyerPage = buyer.page;
  const products = await api(buyer.page, "/shop/products");
  const product = products.payload.data.items.find((item) => Number(item.available) >= 2);
  assert.ok(product, "No product with two available units");
  assert.equal((await api(buyer.page, "/cart/items", { method: "POST", body: { productId: product.productId, variantId: product.variantId, quantity: 2 } })).status, 201);
  const beforeLogin = await api(buyer.page, "/cart");
  assert.equal(beforeLogin.payload.data.items.length, 1);
  assert.equal(beforeLogin.payload.data.items[0].quantity, 2);
  assert.equal((await api(buyer.page, "/auth/login", { method: "POST", body: { email: inboxes.buyer.address, password } })).status, 200);
  const afterLogin = await api(buyer.page, "/cart");
  assert.equal(afterLogin.payload.data.items.length, 1);
  assert.equal(afterLogin.payload.data.items[0].quantity, 2);
  evidence.push("Guest cart survived login exactly once");

  const address = { firstName: "Buyer", lastName: "LaunchCheck", addressLine1: "1 Test Street", city: "Nicosia", postalCode: "1010", countryCode: "CY", phone: "+35799123456" };
  const validation = await api(buyer.page, "/checkout/validate", { method: "POST", body: { shippingAddress: address } });
  assert.equal(validation.status, 200, JSON.stringify(validation.payload));
  const orderResult = await api(buyer.page, "/checkout/order", {
    method: "POST",
    body: { email: inboxes.buyer.address, billingAddress: address, shippingAddress: address, idempotencyKey: `${marker}-order`, expectedGrandTotal: validation.payload.data.grandTotal },
  });
  assert.equal(orderResult.status, 201, JSON.stringify(orderResult.payload));
  const order = orderResult.payload.data.order;
  testOrder = order;
  const history = await api(buyer.page, "/account/orders?pageSize=100");
  assert.equal(history.payload.data.items.filter((item) => item.id === order.id).length, 1);
  const payment = await api(buyer.page, `/account/orders/${order.id}/payments`, { method: "POST", body: { idempotencyKey: `${marker}-payment` } });
  assert.equal(payment.status, 201, JSON.stringify(payment.payload));
  assert.ok(payment.payload.data.clientSecret, "Stripe client secret was not returned");
  evidence.push(`Checkout created order ${order.orderNumber} once and created an uncharged Stripe intent`);

  const invite = await api(owner.page, `/account/companies/${companyA}/invitations`, { method: "POST", body: { email: inboxes.admin.address, role: "admin" } });
  assert.equal(invite.status, 201, JSON.stringify(invite.payload));
  const link = await invitationLink(inboxes.admin);
  const token = new URL(link).searchParams.get("token");
  assert.ok(token);
  const mismatch = await api(wrong.page, "/account/invitations/accept", { method: "POST", body: { token } });
  assert.equal(mismatch.status, 403);
  const accepted = await api(admin.page, "/account/invitations/accept", { method: "POST", body: { token } });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.payload));
  const companyDetail = await api(admin.page, `/account/companies/${companyA}`);
  assert.equal(companyDetail.payload.data.members.find((member) => member.email === inboxes.admin.address).role, "admin");
  const adminGrant = await api(admin.page, `/account/companies/${companyA}/invitations`, { method: "POST", body: { email: inboxes.revoked.address, role: "admin" } });
  assert.equal(adminGrant.status, 403);
  evidence.push("Owner invitation email granted admin; wrong email and admin privilege grant were rejected");

  const revokedInvite = await api(owner.page, `/account/companies/${companyA}/invitations`, { method: "POST", body: { email: inboxes.revoked.address, role: "viewer" } });
  assert.equal(revokedInvite.status, 201);
  const revokedLink = await invitationLink(inboxes.revoked);
  const revokedToken = new URL(revokedLink).searchParams.get("token");
  assert.equal((await api(owner.page, `/account/companies/${companyA}/invitations/${revokedInvite.payload.data.id}`, { method: "DELETE" })).status, 204);
  const revokedUser = await session(browser); opened.push(revokedUser.context);
  await registerPersonal(revokedUser.page, inboxes.revoked.address, "Revoked");
  assert.equal((await api(revokedUser.page, "/account/invitations/accept", { method: "POST", body: { token: revokedToken } })).status, 400);
  assert.equal((await api(companyB.page, `/account/companies/${companyA}`)).status, 403);
  evidence.push("Revoked invitation and cross-company access failed safely");

  assert.equal((await api(buyer.page, `/account/orders/${order.id}/cancel`, { method: "POST" })).status, 200);
  testOrder = undefined;
  evidence.push("Test order cancelled to release reserved inventory");

  console.log(JSON.stringify({ marker, evidence, orderNumber: order.orderNumber, companyA, status: "partial-pass" }, null, 2));
} finally {
  if (buyerPage && testOrder) {
    await api(buyerPage, `/account/orders/${testOrder.id}/cancel`, { method: "POST" }).catch(() => undefined);
  }
  await Promise.allSettled(opened.map((context) => context.close()));
  await browser.close();
}