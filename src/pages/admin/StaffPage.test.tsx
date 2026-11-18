// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";

const { apiRequest } = vi.hoisted(() => ({ apiRequest: vi.fn() }));

vi.mock("../../auth/api", () => ({ apiRequest }));
vi.mock("../../auth/AuthContext", () => ({
  useAuth: () => ({ permissions: ["staff.view", "staff.manage", "roles.view"], isSuperAdmin: true }),
}));

import { StaffPage } from "./StaffPage";

const legacyRole = { id: "11111111-1111-4111-8111-111111111111", name: "Legacy role", active: true, systemKey: null, staffAssignable: false };
const staff = {
  id: "22222222-2222-4222-8222-222222222222",
  email: "legacy@example.test",
  firstName: "Legacy",
  lastName: "Staff",
  phone: null,
  status: "active",
  emailVerifiedAt: "2026-01-01T00:00:00.000Z",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  roles: [legacyRole],
};

describe("StaffPage role assignment boundary", () => {
  beforeEach(() => apiRequest.mockReset());
  afterEach(() => cleanup());

  it("uses only staff-role-options and presents the approved empty state", async () => {
    apiRequest.mockImplementation(async (path: string) => {
      if (!path) return { data: { items: [] } };
      if (path.startsWith("/admin/staff?")) return { data: { items: [], meta: { page: 1, pageSize: 25, total: 0, hasNext: false } } };
      if (path === "/admin/staff-role-options") return { data: { items: [] } };
      throw new Error(`Unexpected API request: ${path}`);
    });

    render(<MemoryRouter><StaffPage /></MemoryRouter>);
    fireEvent.click(await screen.findByRole("button", { name: "Invite staff" }));

    expect(await screen.findByText("No staff roles are currently approved for assignment.")).toBeTruthy();
    expect(apiRequest).toHaveBeenCalledWith("/admin/staff-role-options");
    expect(apiRequest.mock.calls.some(([path]) => path === "/admin/roles")).toBe(false);
    expect(screen.getByRole("button", { name: "Create and invite" })).toHaveProperty("disabled", true);
  });

  it("keeps an existing non-assignable role visible and preserves it on save", async () => {
    apiRequest.mockImplementation(async (path: string, init?: RequestInit) => {
      if (!path) return { data: { items: [] } };
      if (path.startsWith("/admin/staff?")) return { data: { items: [staff], meta: { page: 1, pageSize: 25, total: 1, hasNext: false } } };
      if (path === "/admin/staff-role-options") return { data: { items: [] } };
      if (path === `/admin/staff/${staff.id}`) return { data: { staff, activeAdminSessions: 0, pendingInvitations: 0 } };
      if (path === `/admin/staff/${staff.id}/roles` && init?.method === "PUT") return { data: { staff, activeAdminSessions: 0, pendingInvitations: 0 } };
      throw new Error(`Unexpected API request: ${path}`);
    });

    render(<MemoryRouter><StaffPage /></MemoryRouter>);
    fireEvent.click(await screen.findByRole("button", { name: "Inspect" }));

    expect(await screen.findByText("Legacy / non-assignable")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save roles" }));
    await waitFor(() => expect(apiRequest).toHaveBeenCalledWith(
      `/admin/staff/${staff.id}/roles`,
      expect.objectContaining({ method: "PUT", body: JSON.stringify({ roleIds: [legacyRole.id] }) }),
    ));
  });
});