import assert from "node:assert/strict";
import { isQuantityInTier, quantityForTier } from "./quantityTierSelection.js";

const tiers = [
  { minQuantity: 1, maxQuantity: 9 },
  { minQuantity: 10, maxQuantity: 24 },
  { minQuantity: 25, maxQuantity: 49 },
  { minQuantity: 50, maxQuantity: null },
];

assert.deepEqual(tiers.map((tier) => quantityForTier(tier, 100)), [1, 10, 25, 50]);
assert.equal(quantityForTier(tiers[2], 24), null, "a tier above available stock must be unavailable");
assert.equal(isQuantityInTier(10, tiers[1]), true);
assert.equal(isQuantityInTier(24, tiers[1]), true);
assert.equal(isQuantityInTier(25, tiers[1]), false);
assert.equal(isQuantityInTier(50, tiers[3]), true);
assert.equal(isQuantityInTier(250, tiers[3]), true);

const variantTier = { minQuantity: 6, maxQuantity: 11 };
assert.equal(quantityForTier(variantTier, 7), 6, "the selected variant tier minimum remains the shortcut quantity");
assert.equal(isQuantityInTier(7, variantTier), true);

console.log("Quantity tier selection checks passed.");