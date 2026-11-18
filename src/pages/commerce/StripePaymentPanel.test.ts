import assert from "node:assert/strict";
import { canStartPayment, shouldUnmountPaymentElement } from "./StripePaymentPanel.js";

assert.equal(canStartPayment("pending"), true);
assert.equal(canStartPayment("pending", "pending"), true);
assert.equal(canStartPayment("pending", "requires_action"), true);
assert.equal(canStartPayment("pending", "failed"), true);
assert.equal(canStartPayment("pending", "cancelled"), true);
assert.equal(canStartPayment("pending", "processing"), false);
assert.equal(canStartPayment("pending", "paid"), false);
assert.equal(canStartPayment("confirmed", "pending"), false);
assert.equal(shouldUnmountPaymentElement("paid"), true);
assert.equal(shouldUnmountPaymentElement("cancelled"), true);
assert.equal(shouldUnmountPaymentElement("failed"), false);
assert.equal(shouldUnmountPaymentElement("requires_action"), false);

console.log("Stripe payment-panel state checks passed.");