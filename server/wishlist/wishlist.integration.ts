import assert from "node:assert/strict";
import type { Server } from "node:http";
import { createApp } from "../app.js";
import { closeDatabase, getDatabasePool } from "../db/client.js";

const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
const marker = `wishlist-${suffix}`;
const password = "WishlistTestPassword1";

class Client {
  private cookies = new Map<string, string>();
  constructor(private readonly baseUrl: string) {}

  async request(path: string, init: RequestInit = {}, includeCsrf = true) {
    const headers = new Headers(init.headers);
    if (init.body) headers.set("content-type", "application/json");
    if (this.cookies.size) headers.set("cookie", [...this.cookies].map(([key, value]) => `${key}=${value}`).join("; "));
    if (includeCsrf && !["GET", "HEAD"].includes(init.method?.toUpperCase() ?? "GET")) {
      const csrf = this.cookies.get("lizzor_csrf");
      if (csrf) headers.set("x-csrf-token", decodeURIComponent(csrf));
    }
    const response = await fetch(`${this.baseUrl}/api/v1${path}`, { ...init, headers });
    const getSetCookie = (response.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie;
    const setCookies = getSetCookie ? getSetCookie.call(response.headers) : (response.headers.get("set-cookie")?.split(/,(?=[^;]+?=)/) ?? []);
    for (const cookie of setCookies) {
      const [pair] = cookie.split(";");
      const separator = pair.indexOf("=");
      const name = pair.slice(0, separator);
      const value = pair.slice(separator + 1);
      if (value) this.cookies.set(name, value);
    }
    const body = await response.json();
    return { response, body };
  }
}

async function run() {
  const pool = getDatabasePool();
  const app = await createApp({ serveFrontend: false });
  const server: Server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const first = new Client(baseUrl);
  const second = new Client(baseUrl);
  let categoryId = "";
  let productId = "";
  let secondProductId = "";

  try {
    categoryId = (await pool.query("INSERT INTO categories (name,slug) VALUES ($1,$2) RETURNING id", [`${marker} Category`, `${marker}-category`])).rows[0].id;
    productId = (await pool.query(
      `INSERT INTO products (name,slug,parent_sku,category_id,description,cost_price,base_price,vat_rate,weight,status,published_at)
       VALUES ($1,$2,$3,$4,'Wishlist product',4,12,19,1,'active',now()) RETURNING id`,
      [`${marker} Product`, `${marker}-product`, `${marker}-sku`, categoryId],
    )).rows[0].id;
    secondProductId = (await pool.query(
      `INSERT INTO products (name,slug,parent_sku,category_id,description,cost_price,base_price,vat_rate,weight,status,published_at)
       VALUES ($1,$2,$3,$4,'Second wishlist product',5,14,19,1,'active',now()) RETURNING id`,
      [`${marker} Product Two`, `${marker}-product-two`, `${marker}-sku-two`, categoryId],
    )).rows[0].id;

    for (const [client, email] of [[first, `${marker}-one@example.test`], [second, `${marker}-two@example.test`]] as const) {
      await client.request("/auth/me");
      const registration = await client.request("/auth/register", {
        method: "POST",
        body: JSON.stringify({ firstName: "Wishlist", lastName: "Tester", email, phone: "99123456", countryCode: "CY", password, confirmPassword: password }),
      });
      assert.equal(registration.response.status, 201);
    }

    assert.equal((await first.request("/wishlist")).body.data.items.length, 0);
    const missingCsrf = await first.request("/wishlist/items", { method: "POST", body: JSON.stringify({ productId }) }, false);
    assert.equal(missingCsrf.response.status, 403);

    let result = await first.request("/wishlist/items", { method: "POST", body: JSON.stringify({ productId }) });
    assert.equal(result.response.status, 201);
    assert.deepEqual(result.body.data, { productId, saved: true });

    const duplicateAdds = await Promise.all([
      first.request("/wishlist/items", { method: "POST", body: JSON.stringify({ productId }) }),
      first.request("/wishlist/items", { method: "POST", body: JSON.stringify({ productId }) }),
    ]);
    assert.ok(duplicateAdds.every(({ response }) => response.status === 201));
    assert.equal((await first.request("/wishlist")).body.data.items.length, 1);
    assert.equal((await second.request("/wishlist")).body.data.items.length, 0);

    await first.request("/wishlist/items", { method: "POST", body: JSON.stringify({ productId: secondProductId }) });
    const firstPage = await first.request("/wishlist?page=1&pageSize=1");
    const secondPage = await first.request("/wishlist?page=2&pageSize=1");
    assert.equal(firstPage.body.data.meta.total, 2);
    assert.equal(firstPage.body.data.items.length, 1);
    assert.equal(firstPage.body.data.meta.hasNext, true);
    assert.equal(secondPage.body.data.items.length, 1);
    assert.equal(secondPage.body.data.meta.hasNext, false);
    assert.notEqual(firstPage.body.data.items[0].id, secondPage.body.data.items[0].id);

    assert.equal((await second.request(`/wishlist/items/${productId}`, { method: "DELETE" })).response.status, 200);
    assert.equal((await first.request("/wishlist")).body.data.items.length, 2);
    assert.equal((await first.request(`/wishlist/items/${productId}`, { method: "DELETE" })).response.status, 200);
    assert.equal((await first.request(`/wishlist/items/${secondProductId}`, { method: "DELETE" })).response.status, 200);
    assert.equal((await first.request("/wishlist")).body.data.items.length, 0);
    console.log("Wishlist integration passed.");
  } finally {
    await pool.query("DELETE FROM products WHERE id=ANY($1::uuid[])", [[productId, secondProductId].filter(Boolean)]).catch(() => undefined);
    await pool.query("DELETE FROM categories WHERE id=$1", [categoryId]).catch(() => undefined);
    await pool.query("DELETE FROM users WHERE email LIKE $1", [`${marker}-%`]).catch(() => undefined);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await closeDatabase();
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});