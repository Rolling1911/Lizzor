import { describe, expect, it } from "vitest";
import { canonicalAdminPath } from "./adminRouting";

describe("canonicalAdminPath", () => {
  it.each([
    ["/admin", "/admin"],
    ["/ADMIN", "/admin"],
    ["/Admin/Products", "/admin/products"],
    ["/ADMIN/SUPPLIERS/TOONIES", "/admin/suppliers/toonies"],
  ])("canonicalizes Admin route casing for %s", (pathname, expected) => {
    expect(canonicalAdminPath(pathname)).toBe(expected);
  });

  it.each(["/", "/shop", "/administrator", "/account/admin"])(
    "does not claim storefront path %s",
    (pathname) => {
      expect(canonicalAdminPath(pathname)).toBeNull();
    },
  );
});