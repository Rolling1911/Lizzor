import assert from "node:assert/strict";
import { calculatePayableTotals } from "./payable-total.js";

const exclusive = calculatePayableTotals({
  lines: [{ key: "exclusive", merchandiseCents: 10_000, vatRate: 19, taxMode: "exclusive" }],
  shippingCents: 0,
});
assert.equal(exclusive.taxCents, 1_900);
assert.equal(exclusive.payableTotalCents, 11_900);

const inclusive = calculatePayableTotals({
  lines: [{ key: "inclusive", merchandiseCents: 11_900, vatRate: 19, taxMode: "inclusive" }],
  shippingCents: 0,
});
assert.equal(inclusive.taxCents, 1_900);
assert.equal(inclusive.payableTotalCents, 11_900);

const discountedAndShipped = calculatePayableTotals({
  lines: [{ key: "discounted", merchandiseCents: 8_000, vatRate: 19, taxMode: "exclusive" }],
  shippingCents: 700,
});
assert.equal(discountedAndShipped.taxCents, 1_520);
assert.equal(discountedAndShipped.payableTotalCents, 10_220);

const explicitZero = calculatePayableTotals({
  lines: [{ key: "zero", merchandiseCents: 10_000, vatRate: 0, taxMode: "exclusive", vatClassifiedAt: new Date(0) }],
  shippingCents: 0,
});
assert.equal(explicitZero.taxCents, 0);
assert.ok(explicitZero.lines[0]!.vatClassifiedAt);

console.info("Canonical payable-total checks passed.");