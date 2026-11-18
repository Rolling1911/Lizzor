import assert from "node:assert/strict";
import { inventoryPresentation } from "./inventoryPresentation";

assert.equal(inventoryPresentation(undefined), "No inventory record");
assert.equal(inventoryPresentation({ active: false, status: "inactive", available: 73483 }), "Inventory inactive");
assert.equal(inventoryPresentation({ active: false, status: "inactive", available: 0 }), "Out of stock · Inventory inactive");
assert.equal(inventoryPresentation({ active: true, status: "in_stock", available: 4 }), "In stock");
assert.equal(inventoryPresentation({ active: true, status: "out", available: 0 }), "Out of stock");

console.log("Inventory presentation checks passed.");