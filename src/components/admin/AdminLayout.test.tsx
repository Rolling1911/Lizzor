// @vitest-environment jsdom
import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";

vi.mock("../../auth/AuthContext", () => ({
  useAuth: () => ({ logout: vi.fn(async () => undefined) }),
}));

import { AdminLayout } from "./AdminLayout";

describe("AdminLayout permission navigation", () => {
  afterEach(() => cleanup());

  it("renders the Legal & Compliance item when legal.view is granted", () => {
    render(
      <MemoryRouter initialEntries={["/admin"]}>
        <AdminLayout permissions={["legal.view"]}>
          <div>Admin dashboard</div>
        </AdminLayout>
      </MemoryRouter>,
    );

    expect(screen.getByRole("link", { name: "Legal & Compliance" })).toBeTruthy();
    expect(screen.getByText("Admin dashboard")).toBeTruthy();
  });

  it("shows supplier mappings only when the view permission is granted", () => {
    const { rerender } = render(
      <MemoryRouter initialEntries={["/admin"]}>
        <AdminLayout permissions={[]}>
          <div>Admin dashboard</div>
        </AdminLayout>
      </MemoryRouter>,
    );
    expect(screen.queryByRole("link", { name: "Supplier mappings" })).toBeNull();
    rerender(
      <MemoryRouter initialEntries={["/admin"]}>
        <AdminLayout permissions={["supplier_category_mappings.view"]}>
          <div>Admin dashboard</div>
        </AdminLayout>
      </MemoryRouter>,
    );
    expect(screen.getByRole("link", { name: "Supplier mappings" })).toBeTruthy();
  });
});