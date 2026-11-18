// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";

const mocks = vi.hoisted(() => ({
  auth: {
    user: null as null | { firstName: string },
    sessionType: null as "customer" | null,
    loading: false,
    logout: vi.fn(async () => undefined),
  },
  apiRequest: vi.fn(async (path: string) => {
    if (path === "/storefront/site-settings") return { data: {} };
    if (path === "/cart") return { data: { items: [] } };
    if (path.startsWith("/account/notifications")) return { data: { unreadCount: 0 } };
    if (path === "/catalog/categories") return { data: [] };
    return { data: {} };
  }),
}));

vi.mock("../../auth/AuthContext", () => ({ useAuth: () => mocks.auth }));
vi.mock("../../auth/api", () => ({ apiRequest: mocks.apiRequest }));

import { StorefrontLayout } from "./StorefrontLayout";

function renderHeader() {
  return render(<MemoryRouter><StorefrontLayout><div>Page content</div></StorefrontLayout></MemoryRouter>);
}

describe("StorefrontLayout authentication presentation", () => {
  beforeEach(() => {
    mocks.auth.user = null;
    mocks.auth.sessionType = null;
    mocks.auth.loading = false;
    mocks.auth.logout.mockClear();
    mocks.apiRequest.mockClear();
  });

  afterEach(() => cleanup());

  it("clearly presents signed-out identity on desktop and mobile", () => {
    renderHeader();
    const accountButton = screen.getByRole("button", { name: /Sign in\s*Customer account/i });
    fireEvent.click(accountButton);
    expect(screen.getByRole("menuitem", { name: "Sign in" })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: "Sign out" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open navigation" }));
    expect(screen.getByText("Not signed in")).toBeTruthy();
    expect(screen.getAllByRole("link", { name: /Sign in/ }).length).toBeGreaterThan(0);
  });

  it("shows first-name identity, signed-in status, destinations, and sign out", async () => {
    mocks.auth.user = { firstName: "Fanos" };
    mocks.auth.sessionType = "customer";
    renderHeader();
    const accountButton = screen.getByRole("button", { name: /Hi, Fanos\s*Account/i });
    fireEvent.click(accountButton);
    expect(screen.getByText("Signed in")).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "My account" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "My orders" })).toBeTruthy();
    fireEvent.click(screen.getByRole("menuitem", { name: "Sign out" }));
    await waitFor(() => expect(mocks.auth.logout).toHaveBeenCalledTimes(1));
  });
});