import assert from "node:assert/strict";
import { publicCategories, publicCategoryChildren, publicCategoryName, publicProductName } from "./publicDisplay";

const unsafeNames = [
  "return-api-1788081438297-f016e168221e68",
  "category_1788081438297_deadbeef12345678",
  "1788081438297",
  "f016e168221e68aa",
  "550e8400-e29b-41d4-a716-446655440000",
  "home-and-kitchen",
  "Catalog collection",
  "Unknown",
  " ",
];

for (const name of unsafeNames) {
  assert.equal(publicCategoryName(name), null, `Unsafe category name must not be public: ${name}`);
}

assert.equal(publicCategoryName("Home & Kitchen"), "Home & Kitchen");
assert.equal(publicCategoryName("DEMO Beauty & Personal Care"), "Beauty & Personal Care");
assert.equal(publicCategoryName("T-Shirts"), "T-Shirts");
assert.equal(publicProductName("DEMO-Arc USB-C Desk Hub"), "Arc USB-C Desk Hub");
assert.equal(publicProductName("Arc USB-C Desk Hub"), "Arc USB-C Desk Hub");
assert.equal(publicProductName("550e8400-e29b-41d4-a716-446655440000"), "Wholesale product");

const categories = publicCategories([
  { id: "internal-category-id", name: unsafeNames[0], slug: "preserved-internal-route" },
  { id: "public-category-id", name: "Home & Kitchen", slug: "home-and-kitchen" },
]);

assert.deepEqual(categories, [
  { id: "public-category-id", name: "Home & Kitchen", slug: "home-and-kitchen", publicName: "Home & Kitchen" },
]);
assert.equal(JSON.stringify(categories).includes(unsafeNames[0]), false);

const nestedCategories = [
  { id: "root", parentId: null, name: "Home", slug: "home" },
  { id: "child", parentId: "root", name: "Kitchen", slug: "kitchen" },
  { id: "other", parentId: null, name: "Office", slug: "office" },
];
assert.deepEqual(publicCategoryChildren(nestedCategories, "root").map((item) => item.slug), ["kitchen"]);
assert.deepEqual(publicCategoryChildren(nestedCategories, "other"), []);

console.log("Public category display-name checks passed.");