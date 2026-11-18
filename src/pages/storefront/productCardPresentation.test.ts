import assert from "node:assert/strict";
import { productCardTierMessages, selectSellableProducts } from "./productCardPresentation";

const messages = productCardTierMessages(
  {
    promotion: { name: "Launch offer" },
    nextTier: { minQuantity: 12, unitPrice: 8.5 },
  },
  (value) => `€${value.toFixed(2)}`,
);

assert.deepEqual(messages, [
  "Launch offer",
  "From 12 units · €8.50 each",
]);

assert.deepEqual(
  selectSellableProducts([
    { id: "in-stock", availability: "in_stock" },
    { id: "out-of-stock", availability: "out_of_stock" },
    { id: "low-stock", availability: "low_stock" },
  ]).map((product) => product.id),
  ["in-stock", "low-stock"],
);

console.log("Product-card pricing presentation checks passed.");