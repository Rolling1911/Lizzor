// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { apiRequest } = vi.hoisted(() => ({ apiRequest: vi.fn() }));

vi.mock("../../auth/api", () => ({ apiRequest }));
vi.mock("../../auth/AuthContext", () => ({
  useAuth: () => ({ permissions: ["roles.view", "roles.manage"], isSuperAdmin: true }),
}));

import { RolesPage } from "./RolesPage";

const customRole = { id: "11111111-1111-4111-8111-111111111111", name: "Warehouse", description: "Warehouse access", active: true, systemKey: null, staffAssignable: false, staffCount: 1, permissionCount: 0, createdAt: "2026-01-01", updatedAt: "2026-01-01" };
const systemRole = { id: "22222222-2222-4222-8222-222222222222", name: "Super Admin", description: "Protected", active: true, systemKey: "super_admin", staffAssignable: false, staffCount: 1, permissionCount: 5, createdAt: "2026-01-01", updatedAt: "2026-01-01" };

describe("RolesPage staff assignment state", () => {
  beforeEach(() => {
    apiRequest.mockReset();
    apiRequest.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === "/admin/roles" && !init) return { data: { items: [customRole, systemRole] } };
      if (path === "/admin/permissions") return { data: { groups: {} } };
      if (path === `/admin/roles/${customRole.id}` && !init) return { data: { role: customRole, permissions: [] } };
      if (path === `/admin/roles/${customRole.id}` && init?.method === "PATCH") return { data: { role: { ...customRole, staffAssignable: true }, permissions: [] } };
      throw new Error(`Unexpected API request: ${path}`);
    });
  });
  afterEach(() => cleanup());

  it("shows authoritative states and submits explicit assignability changes", async () => {
    const { container } = render(<RolesPage />);

    expect((await screen.findAllByText("Not assignable")).length).toBeGreaterThan(0);
    expect(screen.getByText("Protected system role")).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: "Inspect" })[0]);
    await screen.findByText("Disabling future assignment does not remove this role from existing staff.");
    const assignmentSelect = [...container.querySelectorAll("select")].find((select) => [...select.options].some((option) => option.value === "assignable"));
    expect(assignmentSelect).toBeTruthy();
    fireEvent.change(assignmentSelect!, { target: { value: "assignable" } });
    fireEvent.click(screen.getByRole("button", { name: "Save role settings" }));

    await waitFor(() => expect(apiRequest).toHaveBeenCalledWith(
      `/admin/roles/${customRole.id}`,
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ name: customRole.name, description: customRole.description, active: true, staffAssignable: true }),
      }),
    ));
  });
});