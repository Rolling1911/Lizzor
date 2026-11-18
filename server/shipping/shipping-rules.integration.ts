import assert from "node:assert/strict";
import type { Server } from "node:http";
import { createApp } from "../app.js";
import { hashPassword } from "../auth/password.js";
import { closeDatabase, getDatabasePool } from "../db/client.js";
import { assertMutableIntegrationTestDatabase } from "../testing/database-safety.js";
import { resolveTooniesShipping, saveShippingRule } from "../suppliers/toonies-service.js";
import { TooniesTemporaryShippingProvider } from "./supplier-provider.js";

const pool = getDatabasePool();
const marker = `shipping-rules-${Date.now().toString(36)}-${Math.random().toString(16).slice(2)}`;
const password = "ShippingRulesIntegrationPassword1";
const ruleIds: string[] = [];
const zoneIds: string[] = [];
const userIds: string[] = [];
const roleIds: string[] = [];

class Client {
  private readonly cookies = new Map<string, string>();
  constructor(private readonly baseUrl: string) {}
  async request(path: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    if (init.body) headers.set("content-type", "application/json");
    if (this.cookies.size) headers.set("cookie", [...this.cookies].map(([key, value]) => `${key}=${value}`).join("; "));
    if (init.method && !["GET", "HEAD"].includes(init.method.toUpperCase())) {
      const csrf = this.cookies.get("lizzor_csrf");
      if (csrf) headers.set("x-csrf-token", decodeURIComponent(csrf));
    }
    const response = await fetch(`${this.baseUrl}/api/v1${path}`, { ...init, headers });
    const setCookies = (response.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.()
      ?? (response.headers.get("set-cookie")?.split(/,(?=[^;]+?=)/) ?? []);
    for (const cookie of setCookies) {
      const [pair] = cookie.split(";");
      const separator = pair.indexOf("=");
      if (separator > 0) this.cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
    }
    return { response, body: response.headers.get("content-type")?.includes("json") ? await response.json() : await response.text() };
  }
}

function rule(destination: { countryCode?: string; destinationZoneId?: string }, minWeightKg: number, maxWeightKg: number | null, amountEur = 7) {
  return {
    ...destination,
    minWeightKg,
    maxWeightKg,
    amountEur,
    minDeliveryDays: 2,
    maxDeliveryDays: 4,
    temporary: true as const,
    active: true,
    expiresAt: null,
  };
}

async function save(input: ReturnType<typeof rule>, actor?: string): Promise<string> {
  const id = await saveShippingRule(input, undefined, actor);
  ruleIds.push(id!);
  return id!;
}

async function run(): Promise<void> {
  assertMutableIntegrationTestDatabase("shipping rules integration");
  let server: Server | undefined;
  try {
    const supplier = (await pool.query<{ id: string }>("SELECT id FROM suppliers WHERE slug='toonies' AND active=true LIMIT 1")).rows[0];
    assert.ok(supplier, "Toonies supplier must exist");
    await assert.rejects(
      () => pool.query(
        `INSERT INTO supplier_shipping_rules
          (supplier_id,country_code,min_weight_kg,max_weight_kg,amount_eur,temporary,active)
         VALUES($1,'DK',1,1,1,true,false)`,
        [supplier.id],
      ),
      (error: any) => error?.constraint === "supplier_shipping_rules_weight_valid",
    );
    await assert.rejects(
      () => pool.query(
        `INSERT INTO supplier_shipping_rules
          (supplier_id,country_code,min_weight_kg,max_weight_kg,amount_eur,min_delivery_days,max_delivery_days,temporary,active)
         VALUES($1,'DK',0,1,1,-1,2,true,false)`,
        [supplier.id],
      ),
      (error: any) => error?.constraint === "supplier_shipping_rules_delivery_valid",
    );
    const actor = (await pool.query<{ id: string }>(
      "INSERT INTO users(email,password_hash,first_name,last_name,status,email_verified_at) VALUES($1,$2,'Shipping','Admin','active',now()) RETURNING id",
      [`${marker}-admin@example.test`, await hashPassword(password)],
    )).rows[0].id;
    userIds.push(actor);

    const zone = (await pool.query<{ id: string }>("INSERT INTO shipping_zones(name,active) VALUES($1,true) RETURNING id", [`${marker} zone`])).rows[0].id;
    const sharedZone = (await pool.query<{ id: string }>("INSERT INTO shipping_zones(name,active) VALUES($1,true) RETURNING id", [`${marker} shared zone`])).rows[0].id;
    zoneIds.push(zone, sharedZone);
    await pool.query("INSERT INTO shipping_zone_countries(zone_id,country_code) VALUES($1,'NL'),($1,'BE'),($2,'BE'),($2,'DE')", [zone, sharedZone]);

    // Provider resolves membership on the server, not a client-supplied zone
    // name. The second query result is an ambiguity and fails closed.
    const zoneRule = await save(rule({ destinationZoneId: zone }, 0, 1), actor);
    const quote = (await pool.query<{ amountEur: string }>(
      `SELECT amount_eur AS "amountEur" FROM supplier_shipping_rules WHERE id=$1`, [zoneRule],
    )).rows[0];
    assert.equal(Number(quote.amountEur), 7);
    const provider = new TooniesTemporaryShippingProvider();
    const matched = await provider.quote({ supplierId: supplier.id, countryCode: "NL", weightKg: .5, client: pool });
    assert.equal(matched?.ruleId, zoneRule);
    const ambiguous = await provider.quote({
      supplierId: supplier.id,
      countryCode: "NL",
      weightKg: .5,
      client: { query: async () => ({ rows: [{ id: "one" }, { id: "two" }] }) },
    });
    assert.equal(ambiguous, null);

    // Country-vs-zone and zone-vs-zone effective destination intersections
    // are rejected even though their stored destinations differ.
    await assert.rejects(() => saveShippingRule(rule({ countryCode: "NL" }, 0, 1), undefined, actor), (error: any) => error?.code === "OVERLAPPING_SHIPPING_RULE");
    await assert.rejects(() => saveShippingRule(rule({ destinationZoneId: sharedZone }, 0, 1), undefined, actor), (error: any) => error?.code === "OVERLAPPING_SHIPPING_RULE");

    // The Admin quote preview uses the exact same fail-closed provider as
    // checkout. Even legacy/directly-corrupted overlaps cannot select an
    // arbitrary rule.
    const conflictingRule = (await pool.query<{ id: string }>(
      `INSERT INTO supplier_shipping_rules
        (supplier_id,country_code,min_weight_kg,max_weight_kg,amount_eur,min_delivery_days,max_delivery_days,temporary,active)
       VALUES($1,'NL',0,1,99,1,1,true,true) RETURNING id`,
      [supplier.id],
    )).rows[0].id;
    ruleIds.push(conflictingRule);
    assert.equal(await resolveTooniesShipping({ countryCode: "NL", weightKg: .5 }), null);
    await pool.query("UPDATE supplier_shipping_rules SET active=false WHERE id=$1", [conflictingRule]);

    const adjacentA = await save(rule({ destinationZoneId: zone }, 1, 2), actor);
    const adjacentB = await save(rule({ destinationZoneId: zone }, 2, 3), actor);
    assert.notEqual(adjacentA, adjacentB);

    const concurrent = await Promise.allSettled([
      save(rule({ countryCode: "PT" }, 0, 1), actor),
      save(rule({ countryCode: "PT" }, 0, 1), actor),
    ]);
    assert.equal(concurrent.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(concurrent.filter((result) => result.status === "rejected" && (result.reason as any)?.code === "OVERLAPPING_SHIPPING_RULE").length, 1);

    const updateTarget = await save(rule({ countryCode: "SE" }, 1, 2), actor);
    const update = saveShippingRule(rule({ countryCode: "SE" }, 0, 1), updateTarget, actor);
    const create = saveShippingRule(rule({ countryCode: "SE" }, 0, 1), undefined, actor).then((id) => {
      ruleIds.push(id!);
      return id;
    });
    const race = await Promise.allSettled([update, create]);
    assert.equal(race.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(race.filter((result) => result.status === "rejected" && (result.reason as any)?.code === "OVERLAPPING_SHIPPING_RULE").length, 1);

    const auditTarget = await save(rule({ countryCode: "FI" }, 0, 1), actor);
    await saveShippingRule({ ...rule({ countryCode: "FI" }, 0, 1, 8), active: true }, auditTarget, actor);
    await saveShippingRule({ ...rule({ countryCode: "FI" }, 0, 1, 8), active: false }, auditTarget, actor);
    const audits = (await pool.query(
      `SELECT actor_admin_id AS "actor",action,old_values_json AS "oldValues",new_values_json AS "newValues"
         FROM audit_logs WHERE entity_type='supplier_shipping_rule' AND entity_id=$1 ORDER BY created_at`, [auditTarget],
    )).rows;
    assert.equal(audits.length, 3);
    assert.deepEqual(audits.map((entry) => entry.actor), [actor, actor, actor]);
    assert.match(audits[0].action, /created$/);
    assert.match(audits[1].action, /updated$/);
    assert.match(audits[2].action, /deactivated$/);
    assert.equal(audits[0].oldValues, null);
    assert.ok(audits[1].oldValues && audits[1].newValues);
    assert.equal(audits[2].oldValues.active, true);
    assert.equal(audits[2].newValues.active, false);

    // Dedicated permission boundaries are exercised through the same API
    // that the admin UI uses.
    const app = await createApp({ serveFrontend: false });
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server!.once("listening", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const role = (await pool.query<{ id: string }>("INSERT INTO admin_roles(name) VALUES($1) RETURNING id", [`${marker} viewer`])).rows[0].id;
    const emptyRole = (await pool.query<{ id: string }>("INSERT INTO admin_roles(name) VALUES($1) RETURNING id", [`${marker} no shipping`])).rows[0].id;
    roleIds.push(role, emptyRole);
    const viewer = (await pool.query<{ id: string }>(
      "INSERT INTO users(email,password_hash,first_name,last_name,status,email_verified_at) VALUES($1,$2,'Shipping','Viewer','active',now()) RETURNING id",
      [`${marker}-viewer@example.test`, await hashPassword(password)],
    )).rows[0].id;
    const noViewer = (await pool.query<{ id: string }>(
      "INSERT INTO users(email,password_hash,first_name,last_name,status,email_verified_at) VALUES($1,$2,'Shipping','NoViewer','active',now()) RETURNING id",
      [`${marker}-no-viewer@example.test`, await hashPassword(password)],
    )).rows[0].id;
    userIds.push(viewer, noViewer);
    await pool.query("INSERT INTO admin_user_roles(user_id,role_id) VALUES($1,$2),($3,$4)", [viewer, role, noViewer, emptyRole]);
    await pool.query("INSERT INTO admin_role_permissions(role_id,permission_id) SELECT $1,id FROM admin_permissions WHERE permission_key='supplier_shipping.view'", [role]);
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const viewerClient = new Client(baseUrl);
    const noViewerClient = new Client(baseUrl);
    await viewerClient.request("/auth/me");
    await noViewerClient.request("/auth/me");
    assert.equal((await viewerClient.request("/auth/admin/login", { method: "POST", body: JSON.stringify({ email: `${marker}-viewer@example.test`, password }) })).response.status, 200);
    assert.equal((await noViewerClient.request("/auth/admin/login", { method: "POST", body: JSON.stringify({ email: `${marker}-no-viewer@example.test`, password }) })).response.status, 200);
    assert.equal((await viewerClient.request("/admin/suppliers/toonies/shipping")).response.status, 200);
    assert.equal((await viewerClient.request("/admin/suppliers/toonies/shipping/zones")).response.status, 200);
    assert.equal((await viewerClient.request("/admin/suppliers/toonies/shipping", { method: "POST", body: JSON.stringify(rule({ countryCode: "GR" }, 0, 1)) })).response.status, 403);
    assert.equal((await noViewerClient.request("/admin/suppliers/toonies/shipping")).response.status, 403);
    assert.equal((await noViewerClient.request("/admin/suppliers/toonies/shipping/zones")).response.status, 403);
  } finally {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    const cleanup = await pool.connect();
    try {
      await cleanup.query("BEGIN");
      if (ruleIds.length) {
        await cleanup.query("DELETE FROM audit_logs WHERE entity_id=ANY($1::uuid[])", [ruleIds]);
        await cleanup.query("DELETE FROM supplier_shipping_rules WHERE id=ANY($1::uuid[])", [ruleIds]);
      }
      if (zoneIds.length) {
        await cleanup.query("DELETE FROM shipping_zone_countries WHERE zone_id=ANY($1::uuid[])", [zoneIds]);
        await cleanup.query("DELETE FROM shipping_zones WHERE id=ANY($1::uuid[])", [zoneIds]);
      }
      if (userIds.length) {
        await cleanup.query("DELETE FROM admin_user_roles WHERE user_id=ANY($1::uuid[])", [userIds]);
        await cleanup.query("DELETE FROM auth_sessions WHERE user_id=ANY($1::uuid[])", [userIds]);
        await cleanup.query("DELETE FROM users WHERE id=ANY($1::uuid[])", [userIds]);
      }
      if (roleIds.length) await cleanup.query("DELETE FROM admin_roles WHERE id=ANY($1::uuid[])", [roleIds]);
      await cleanup.query("COMMIT");
    } catch (error) {
      await cleanup.query("ROLLBACK");
      throw error;
    } finally {
      cleanup.release();
    }
    await closeDatabase();
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});