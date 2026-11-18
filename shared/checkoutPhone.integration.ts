import assert from "node:assert/strict";
import { normalizeCheckoutPhone, splitCheckoutPhone } from "./checkoutPhone.js";

assert.equal(normalizeCheckoutPhone("", "CY"), undefined);
assert.equal(normalizeCheckoutPhone("99 123456", "CY"), "+35799123456");
assert.equal(normalizeCheckoutPhone("357 99 123456", "CY"), "+35799123456");
assert.equal(normalizeCheckoutPhone("+357 99 123456", "CY"), "+35799123456");
assert.equal(normalizeCheckoutPhone("691 234 5678", "GR"), "+306912345678");
assert.equal(normalizeCheckoutPhone("02 12345678", "IT"), "+390212345678");
assert.equal(normalizeCheckoutPhone("not a phone", "CY"), undefined);
assert.deepEqual(splitCheckoutPhone("+35799123456"), { countryCode: "CY", local: "99123456" });
assert.deepEqual(splitCheckoutPhone("+390212345678"), { countryCode: "IT", local: "0212345678" });

console.info("Checkout phone normalization checks passed.");