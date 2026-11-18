import assert from "node:assert/strict";
import { calculateSupplierPrice } from "../suppliers/toonies-service.js";
import { assertMerchandisePriceFloor } from "./floor.js";

for (const [raw, expected] of [
  [17, 17.99],
  [17.01, 17.99],
  [17.82, 17.99],
  [17.99, 17.99],
  [17.995, 18.99],
  [18, 18.99],
  [18.2, 18.99],
] as const) {
  assert.equal(calculateSupplierPrice(raw, { ruleType: "markup_fixed", value: 0, roundingMode: "99" }), expected);
}

assert.equal(calculateSupplierPrice(10, { ruleType: "markup_percent", value: 20, roundingMode: "none" }), 12);
assert.equal(calculateSupplierPrice(10, { ruleType: "margin_percent", value: 20, roundingMode: "none" }), 12.5);
assert.doesNotThrow(() => assertMerchandisePriceFloor({ unitCost: 4.99, quantity: 2, merchandiseRevenue: 9.98 }));
assert.throws(
  () => assertMerchandisePriceFloor({ unitCost: 10.004, quantity: 100, merchandiseRevenue: 1000 }),
  (error: any) => error?.code === "MERCHANDISE_PRICE_BELOW_COST",
);
assert.throws(
  () => assertMerchandisePriceFloor({ unitCost: 5, quantity: 2, merchandiseRevenue: 9.99 }),
  (error: any) => error?.code === "MERCHANDISE_PRICE_BELOW_COST",
);

console.log("Toonies pricing safety arithmetic checks passed.");