// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";

const mocks = vi.hoisted(() => ({
  apiRequest: vi.fn(),
  permissions: ["categories.view", "categories.create", "categories.edit"],
}));

vi.mock("../../../auth/api", () => ({ apiRequest: mocks.apiRequest }));
vi.mock("../../../auth/AuthContext", () => ({ useAuth: () => ({ permissions: mocks.permissions }) }));

import { CategoriesPage } from "./CategoriesPage";

const categories = [
  { id: "root", parentId: null, name: "Home", slug: "home", canonicalKey: "home-root", description: null, imageUrl: null, sortOrder: 1, active: true, productCount: 2, childCount: 1, protectedDependencyCount: 0, createdAt: "", updatedAt: "" },
  { id: "child", parentId: "root", name: "Kitchen", slug: "kitchen", description: null, imageUrl: null, sortOrder: 1, active: false, productCount: 3, childCount: 0, protectedDependencyCount: 0, createdAt: "", updatedAt: "" },
  { id: "other", parentId: null, name: "Office", slug: "office", description: null, imageUrl: null, sortOrder: 2, active: true, productCount: 0, childCount: 0, protectedDependencyCount: 0, createdAt: "", updatedAt: "" },
];

describe("CategoriesPage hierarchy controls", () => {
  beforeEach(() => {
    mocks.apiRequest.mockReset();
    mocks.apiRequest.mockResolvedValue({ data: categories });
  });
  afterEach(() => cleanup());

  it("keeps hierarchy context while searching and filters by active state", async () => {
    render(<MemoryRouter><CategoriesPage /></MemoryRouter>);
    expect(await screen.findByText("Kitchen")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Search categories or slugs"), { target: { value: "kitchen" } });
    expect(screen.getByText("Kitchen")).toBeTruthy();
    expect(screen.getAllByText("Home").length).toBeGreaterThan(0);

    fireEvent.change(screen.getByLabelText("Filter category status"), { target: { value: "active" } });
    expect(screen.queryByText("Kitchen")).toBeNull();
    expect(screen.getAllByText("Home").length).toBeGreaterThan(0);
  });

  it("excludes the edited category and all descendants from the parent selector", async () => {
    render(<MemoryRouter><CategoriesPage /></MemoryRouter>);
    await screen.findByText("Home", { selector: "strong" });
    fireEvent.click(screen.getByText("Home", { selector: "strong" }));

    const parent = await waitFor(() => document.querySelector(".catalog-side-form select") as HTMLSelectElement);
    expect(Array.from(parent.options).map((option) => option.value)).toEqual(["", "other"]);
    expect(screen.getByText("Descendants are excluded to prevent hierarchy cycles.")).toBeTruthy();
  });

  it("shows an explicit category load error", async () => {
    mocks.apiRequest.mockRejectedValueOnce(new Error("Category service unavailable"));
    render(<MemoryRouter><CategoriesPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText("Category service unavailable")).toBeTruthy());
  });

  it("retains the API canonical key when saving an ordinary edit", async () => {
    render(<MemoryRouter><CategoriesPage /></MemoryRouter>);
    await screen.findByText("Home", { selector: "strong" });
    fireEvent.click(screen.getByText("Home", { selector: "strong" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Home essentials" } });
    fireEvent.click(screen.getByRole("button", { name: "Save category" }));

    await waitFor(() => expect(mocks.apiRequest).toHaveBeenCalledWith(
      "/admin/categories/root",
      expect.objectContaining({
        method: "PATCH",
        body: expect.stringContaining('"canonicalKey":"home-root"'),
      }),
    ));
  });
});