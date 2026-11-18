import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { TooniesClient, TooniesError, TooniesFixtureTransport, signTooniesRequest } from "./toonies.js";
import { EcbFxProvider, parseEcbCsv } from "../fx/ecb.js";
import { assertValidFxObservation, FxProviderError, normalizeCnyToEur } from "../fx/provider.js";
import { deriveTooniesDisplayWeight, downloadTooniesImage, parseTooniesCnyAmount, parseTooniesMoq } from "./toonies-service.js";

const body = Buffer.from('{"keyword":"<b>bag</b>"}', "utf8");
const headers = signTooniesRequest({
  appKey: "app-key",
  appSecret: "local-secret",
  path: "/v1/product/search",
  timestamp: 1_700_000_000,
  nonce: "nonce-123",
  body,
});
const expected = createHmac("sha256", "local-secret")
  .update(Buffer.concat([Buffer.from("POST&/v1/product/search&1700000000&nonce-123&"), body]))
  .digest("hex")
  .toUpperCase();
assert.equal(headers["X-Signature"], expected);
assert.equal(headers["content-type"], "application/json");
assert.equal(headers["X-App-Key"], "app-key");
assert.equal(headers["X-Signature"].includes("local-secret"), false);

const isolationTestFetch = globalThis.fetch;
let unexpectedLiveFetches = 0;
globalThis.fetch = (async () => {
  unexpectedLiveFetches += 1;
  throw new Error("unexpected live fetch");
}) as typeof fetch;
try {
  const missingFixture = new TooniesClient({ appKey: "test-key", appSecret: "test-secret" });
  await assert.rejects(
    () => missingFixture.search({ keyword: "must-not-reach-live" }),
    (error: unknown) => error instanceof TooniesError && error.code === 50001,
    "a missing fixture must fail as a supplier transport error",
  );
  assert.equal(unexpectedLiveFetches, 0, "tests must fail before any live Toonies HTTP request");
} finally {
  globalThis.fetch = isolationTestFetch;
}

const fixture = new TooniesFixtureTransport({
  "/v1/product/search": {
    status: true,
    code: 200,
    msg: "ok",
    data: { items: [{ product_code: "P1" }], total: 1, total_page: 1, page: 1, page_size: 20, currency: "CNY" },
  },
  "/v1/product/detail": {
    status: true,
    code: 200,
    msg: "ok",
    data: { product_code: "P1", skus: [{ sku_code: "S1" }] },
  },
  "/v1/order/create": [
    { status: false, code: 50001, msg: "unknown", data: null },
    { status: true, code: 200, msg: "ok", data: { order_sn: "O1", api_order_sn: "api1", duplicated: true } },
  ],
  "/v1/order/get": { status: true, code: 200, msg: "ok", data: { order_sn: "O1", api_order_sn: "api1" } },
  "/v1/order/list": { status: true, code: 200, msg: "ok", data: { items: [{ order_sn: "O1", api_order_sn: "api1" }] } },
  "/v1/user/balance": { status: true, code: 200, msg: "ok", data: { balance: "10.00", currency: "CNY" } },
});
const client = new TooniesClient({
  appKey: "test-key",
  appSecret: "test-secret",
  transport: fixture.request,
  now: () => 1_700_000_000,
  nonce: () => "deterministic",
});
const search = await client.search({ keyword: "<b>bag</b>" }) as { items: Array<{ product_code: string }> };
assert.equal(search.items[0]?.product_code, "P1");
await client.detail({ product_code: "P1" });
await client.detail({ product_code: "P1" });
assert.equal(fixture.requests.length, 2);
assert.equal(fixture.requests[0]?.body.toString("utf8"), JSON.stringify({ keyword: "bag", page: 1, page_size: 20 }));
assert.equal(fixture.requests[0]?.headers["X-Signature"].length, 64);
const createBody = {
  task_id: "T1", api_order_sn: "api1", consignee: "Ada Lovelace", phone: "+123456",
  country_code: "IE", province: "Leinster", city: "Dublin", address: "1 Main Street",
  postcode: "D01", email: "ada@example.test",
};
await assert.rejects(() => client.create(createBody), (error: unknown) => error instanceof TooniesError && error.code === 50001);
assert.equal(fixture.requests.filter((request) => request.path === "/v1/order/create").length, 1, "create must never use generic retries");
const duplicate = await client.create(createBody) as { duplicated: boolean };
assert.equal(duplicate.duplicated, true);
assert.deepEqual(await client.get({ order_sn: "O1" }), { order_sn: "O1", api_order_sn: "api1" });
assert.deepEqual(await client.listOrders({ page: 1, page_size: 50 }), { items: [{ order_sn: "O1", api_order_sn: "api1" }] });
assert.deepEqual(await client.balance(), { balance: "10.00", currency: "CNY" });

const csv = [
  "KEY,FREQ,CURRENCY,CURRENCY_DENOM,EXR_TYPE,EXR_SUFFIX,TIME_PERIOD,OBS_VALUE",
  "EXR.D.CNY.EUR.SP00.A,D,CNY,EUR,SP00,A,2024-01-02,7.80",
  "EXR.D.CNY.EUR.SP00.A,D,CNY,EUR,SP00,A,2024-01-04,8.00",
].join("\n");
assert.deepEqual(parseEcbCsv(csv, new Date("2024-01-05T12:00:00Z")), { rate: "8.00", observedAt: new Date("2024-01-04T00:00:00Z") });
assert.equal(normalizeCnyToEur("12.00", "8.00"), "1.5000");
assert.equal(normalizeCnyToEur("1.00", "3"), "0.3333");
assert.equal(parseTooniesCnyAmount("12.000000000001"), "12.000000000001");
assert.deepEqual(parseTooniesMoq("6"), { value: 6, raw: "6" });
assert.deepEqual(parseTooniesMoq(0), { value: 1, raw: 0 });
assert.equal(deriveTooniesDisplayWeight([null, "0.250", 0.4, -1, 0, Infinity]), 0.25);
assert.equal(deriveTooniesDisplayWeight([null, "0", 0, -1, Infinity, NaN]), null);
assert.equal(deriveTooniesDisplayWeight([null, undefined]), null);

const originalFetch = globalThis.fetch;
try {
  globalThis.fetch = (async () => {
    throw new Error("fetch_should_not_be_called");
  }) as typeof fetch;
  await assert.rejects(() => downloadTooniesImage("http://cbu01.alicdn.com/image.png"));
  await assert.rejects(() => downloadTooniesImage("https://localhost/image.png"));
  await assert.rejects(() => downloadTooniesImage("https://127.0.0.1/image.png"));
  await assert.rejects(() => downloadTooniesImage("https://cbu01.alicdn.com:443/image.png"));
  await assert.rejects(() => downloadTooniesImage("https://unapproved.example/image.png"));

  globalThis.fetch = (async () => new Response(null, {
    status: 302,
    headers: { location: "https://unapproved.example/image.png" },
  })) as typeof fetch;
  await assert.rejects(() => downloadTooniesImage("https://cbu01.alicdn.com/image.png"));

  globalThis.fetch = (async () => new Response(new Uint8Array(0), {
    status: 200,
    headers: { "content-type": "image/png", "content-length": String(10 * 1024 * 1024 + 1) },
  })) as typeof fetch;
  await assert.rejects(() => downloadTooniesImage("https://cbu01.alicdn.com/image.png"));

  const validPng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  globalThis.fetch = (async () => new Response(validPng, {
    status: 200,
    headers: { "content-type": "image/png" },
  })) as typeof fetch;
  const downloaded = await downloadTooniesImage("https://cbu01.alicdn.com/image.png");
  assert.deepEqual(downloaded.bytes, validPng);
  assert.equal(downloaded.contentType, "image/png");
} finally {
  globalThis.fetch = originalFetch;
}
const unsafeParsedAmount = JSON.parse('{"charge":9007199254740993}').charge;
assert.throws(() => parseTooniesCnyAmount(unsafeParsedAmount), (error: unknown) => error instanceof Error && "code" in error && error.code === "TOONIES_UNSAFE_NUMERIC_AMOUNT");
let fxRequests = 0;
const ecb = new EcbFxProvider({
  now: () => new Date("2024-01-05T12:00:00Z"),
  transport: async ({ headers }) => {
    fxRequests += 1;
    assert.equal(headers.Accept, "text/csv");
    assert.ok(headers["User-Agent"]);
    return { status: 200, body: csv };
  },
});
const observation = await ecb.fetchObservation();
assert.equal(observation.rate, "8.00");
assert.equal(fxRequests, 1);

for (const invalidRate of ["0", "-1", "1001", "not-a-rate"]) {
  assert.throws(() => assertValidFxObservation({
    ...observation,
    rate: invalidRate,
  }, new Date("2024-01-05T12:00:00Z"), 120 * 60 * 60 * 1000), FxProviderError);
}
assert.throws(() => assertValidFxObservation({
  ...observation,
  observedAt: new Date("2024-01-06T00:00:00Z"),
}, new Date("2024-01-05T12:00:00Z"), 120 * 60 * 60 * 1000), (error: unknown) => error instanceof FxProviderError && error.code === "FX_OBSERVATION_FUTURE");
assert.throws(() => assertValidFxObservation({
  ...observation,
  observedAt: new Date("2023-12-01T00:00:00Z"),
}, new Date("2024-01-05T12:00:00Z"), 120 * 60 * 60 * 1000), (error: unknown) => error instanceof FxProviderError && error.code === "FX_OBSERVATION_STALE");
assert.throws(() => parseEcbCsv("KEY,WRONG_HEADER\nEXR,8", new Date("2024-01-05T12:00:00Z")), (error: unknown) => error instanceof FxProviderError && error.code === "FX_CSV_INVALID");
assert.throws(() => parseEcbCsv([
  "KEY,FREQ,CURRENCY,CURRENCY_DENOM,EXR_TYPE,EXR_SUFFIX,TIME_PERIOD,OBS_VALUE",
  "EXR.D.USD.EUR.SP00.A,D,USD,EUR,SP00,A,2024-01-04,1.10",
].join("\n"), new Date("2024-01-05T12:00:00Z")), (error: unknown) => error instanceof FxProviderError && error.code === "FX_PAIR_INVALID");

let retryableRequests = 0;
const retryableEcb = new EcbFxProvider({
  now: () => new Date("2024-01-05T12:00:00Z"),
  delay: async () => undefined,
  maxRetries: 2,
  transport: async () => {
    retryableRequests += 1;
    return retryableRequests < 3 ? { status: 503, body: "" } : { status: 200, body: csv };
  },
});
assert.equal((await retryableEcb.fetchObservation()).rate, "8.00");
assert.equal(retryableRequests, 3);

let nonRetryableRequests = 0;
const nonRetryableEcb = new EcbFxProvider({
  delay: async () => undefined,
  transport: async () => {
    nonRetryableRequests += 1;
    return { status: 400, body: "" };
  },
});
await assert.rejects(() => nonRetryableEcb.fetchObservation(), (error: unknown) => error instanceof FxProviderError && error.status === 400);
assert.equal(nonRetryableRequests, 1);

const oversizedEcb = new EcbFxProvider({
  delay: async () => undefined,
  transport: async () => ({ status: 200, body: "x".repeat(1_000_001) }),
});
await assert.rejects(() => oversizedEcb.fetchObservation(), (error: unknown) => error instanceof FxProviderError && error.code === "FX_RESPONSE_TOO_LARGE");

let approvalCalls = 0;
const approval = new TooniesClient({
  appKey: "test-key",
  appSecret: "test-secret",
  approvalCooldownMs: 60_000,
  transport: async () => {
    approvalCalls += 1;
    return { envelope: { status: false, code: 40006, msg: "not approved", data: null } };
  },
});
await assert.rejects(() => approval.search({ keyword: "bag" }), (error: unknown) => error instanceof TooniesError && error.code === 40006);
await assert.rejects(() => approval.search({ keyword: "bag" }), (error: unknown) => error instanceof TooniesError && error.code === 40006);
assert.equal(approvalCalls, 1);

let rateLimitCalls = 0;
const rateLimited = new TooniesClient({
  appKey: "test-key",
  appSecret: "test-secret",
  rateLimitCooldownMs: 60_000,
  transport: async () => {
    rateLimitCalls += 1;
    return { envelope: { status: false, code: 42901, msg: "private provider detail", data: null } };
  },
});
await assert.rejects(() => rateLimited.search({ keyword: "charger" }), (error: unknown) => error instanceof TooniesError && error.code === 42901);
await assert.rejects(() => rateLimited.search({ keyword: "charger" }), (error: unknown) => error instanceof TooniesError && error.code === 42901);
assert.equal(rateLimitCalls, 1);

const detailTimes: number[] = [];
const pacedDetails = new TooniesClient({
  appKey: "test-key",
  appSecret: "test-secret",
  detailIntervalMs: 1_250,
  transport: async (request) => {
    detailTimes.push(Date.now());
    return { envelope: { status: true, code: 200, msg: "ok", data: { product_code: JSON.parse(request.body.toString("utf8")).product_code } } };
  },
});
await Promise.all([
  pacedDetails.detail({ product_code: "paced-a" }),
  pacedDetails.detail({ product_code: "paced-b" }),
]);
assert.equal(detailTimes.length, 2);
assert.ok(detailTimes[1] - detailTimes[0] >= 1_200);

let unrestrictedCalls = 0;
const boundedSearch = new TooniesClient({
  appKey: "test-key",
  appSecret: "test-secret",
  transport: async () => {
    unrestrictedCalls += 1;
    return { envelope: { status: true, code: 200, msg: "ok", data: { items: [] } } };
  },
});
await assert.rejects(() => boundedSearch.search({ keyword: "" }));
assert.equal(unrestrictedCalls, 0);

console.log("Toonies adapter tests passed.");