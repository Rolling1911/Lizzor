// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";

const mocks = vi.hoisted(() => ({
  apiRequest: vi.fn(),
  auth: {
    user: null,
    sessionType: null,
    loading: false,
    logout: vi.fn(async () => undefined),
  },
}));

vi.mock("../../auth/api", () => ({ apiRequest: mocks.apiRequest }));
vi.mock("../../auth/AuthContext", () => ({ useAuth: () => mocks.auth }));

import { StorefrontLayout } from "./StorefrontLayout";

const categories = [
  { id: "root", parentId: null, name: "Home", slug: "home" },
  { id: "child", parentId: "root", name: "Kitchen", slug: "kitchen" },
  { id: "electronics", parentId: null, name: "Electronics", slug: "electronics" },
  { id: "audio", parentId: "electronics", name: "Audio", slug: "audio" },
];

describe("StorefrontLayout nested category navigation", () => {
  beforeEach(() => {
    mocks.apiRequest.mockImplementation(async (path: string) => {
      if (path === "/catalog/categories") return { data: categories };
      if (path === "/storefront/site-settings") return { data: {} };
      if (path === "/cart") return { data: { items: [] } };
      return { data: {} };
    });
  });
  afterEach(() => cleanup());

  it("exposes root and nested canonical links in the desktop popover", async () => {
    render(<MemoryRouter><StorefrontLayout><div>Page</div></StorefrontLayout></MemoryRouter>);
    const triggers = screen.getAllByRole("button", { name: /All categories/i });
    fireEvent.click(triggers[triggers.length - 1]);
    await waitFor(() => expect(document.querySelector(".category-popover__name")).toBeTruthy());
    expect(document.querySelector('a[href="/categories/home"]')).toBeTruthy();
    expect(document.querySelector('a[href="/categories/kitchen"]')).toBeTruthy();
  });

  it("supports mobile disclosure of a root's subcategories", async () => {
    render(<MemoryRouter><StorefrontLayout><div>Page</div></StorefrontLayout></MemoryRouter>);
    fireEvent.click(screen.getByRole("button", { name: "Open navigation" }));
    const disclosure = await screen.findByRole("button", { name: "Expand Home subcategories" });
    fireEvent.click(disclosure);
    expect(screen.getByRole("link", { name: "Kitchen" }).getAttribute("href")).toBe("/categories/kitchen");
    expect(disclosure.getAttribute("aria-expanded")).toBe("true");
  });

  it("updates the desktop content from category focus and reports the dynamic department count", async () => {
    render(<MemoryRouter><StorefrontLayout><div>Page</div></StorefrontLayout></MemoryRouter>);
    const triggers = screen.getAllByRole("button", { name: /All categories/i });
    fireEvent.click(triggers[triggers.length - 1]);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Home" })).toBeTruthy());
    expect(screen.getByText("2 departments")).toBeTruthy();
    const electronics = document.querySelector<HTMLAnchorElement>('.category-mega__departments a[href="/categories/electronics"]');
    expect(electronics).toBeTruthy();
    fireEvent.focus(electronics!);
    expect(screen.getByRole("heading", { name: "Electronics" })).toBeTruthy();
    expect(document.querySelector('.category-mega__subcategories a[href="/categories/audio"]')).toBeTruthy();
    expect(document.querySelector('.category-mega__subcategories a[href="/categories/kitchen"]')).toBeFalsy();
  });

  it("keeps the mobile footer compact and preserves its existing actions", async () => {
    const cookieSettings = vi.fn();
    window.addEventListener("lizzor:open-cookie-settings", cookieSettings);
    render(<MemoryRouter><StorefrontLayout><div>Page</div></StorefrontLayout></MemoryRouter>);
    const marketplace = screen.getByRole("button", { name: "Marketplace" });
    const account = screen.getByRole("button", { name: "Account" });
    expect(marketplace.getAttribute("aria-expanded")).toBe("false");
    expect(account.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(marketplace);
    expect(marketplace.getAttribute("aria-expanded")).toBe("true");
    expect(document.querySelector('#footer-marketplace a[href="/categories"]')).toBeTruthy();
    fireEvent.click(account);
    expect(marketplace.getAttribute("aria-expanded")).toBe("false");
    expect(account.getAttribute("aria-expanded")).toBe("true");
    expect(document.querySelector('#footer-support a[href="/chat"]')).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cookie settings" }));
    expect(cookieSettings).toHaveBeenCalledTimes(1);
    window.removeEventListener("lizzor:open-cookie-settings", cookieSettings);
  });
});