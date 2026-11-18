// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";

const mocks = vi.hoisted(() => ({
  apiRequest: vi.fn(),
  permissions: ["supplier_category_mappings.view", "supplier_category_mappings.manage"],
}));

vi.mock("../../../auth/api", () => ({ apiRequest: mocks.apiRequest }));
vi.mock("../../../auth/AuthContext", () => ({ useAuth: () => ({ permissions: mocks.permissions }) }));

import { SupplierCategoryMappingsPage } from "./SupplierCategoryMappingsPage";

const categories = [
  { id: "root-1", parentId: null, name: "Home", slug: "home", active: true },
  { id: "child-1", parentId: "root-1", name: "Kitchen", slug: "kitchen", active: true },
  { id: "root-2", parentId: null, name: "Office", slug: "office", active: true },
  { id: "child-2", parentId: "root-2", name: "Desks", slug: "desks", active: true },
];

const mapping = {
  id: "mapping-1",
  externalCategoryName: "Supplier kitchen",
  externalCategoryPath: "Home / Kitchen",
  rootCategoryId: null,
  childCategoryId: null,
  status: "unmapped",
};

function mockApi(items = [mapping]) {
  mocks.apiRequest.mockImplementation(async (path: string) => {
    if (path === "/admin/catalog/supplier-category-mappings/categories") return { data: categories };
    if (path.startsWith("/admin/supplier-category-mappings?")) return { data: { items, meta: { page: 1, pageSize: 25, total: items.length, hasNext: false } } };
    if (path.startsWith("/admin/supplier-category-mappings/")) return { data: { items, meta: { page: 1, pageSize: 25, total: items.length, hasNext: false } } };
    throw new Error(`Unexpected API request: ${path}`);
  });
}

function renderPage() {
  return render(<MemoryRouter><SupplierCategoryMappingsPage /></MemoryRouter>);
}

describe("SupplierCategoryMappingsPage", () => {
  beforeEach(() => {
    mocks.apiRequest.mockReset();
    mocks.permissions = ["supplier_category_mappings.view", "supplier_category_mappings.manage"];
  });
  afterEach(() => cleanup());

  it("keeps the polished no-feed empty state", async () => {
    mockApi([]);
    renderPage();
    expect(await screen.findByText("Supplier category mappings are ready")).toBeTruthy();
    expect(screen.getByText(/No supplier feed is connected yet/)).toBeTruthy();
  });

  it("shows a load error without hiding the page context", async () => {
    mocks.apiRequest.mockImplementation(async (path: string) => {
      if (path === "/admin/catalog/supplier-category-mappings/categories") return { data: categories };
      throw new Error("Mapping feed unavailable");
    });
    renderPage();
    expect(await screen.findByText("Mapping feed unavailable")).toBeTruthy();
    expect(screen.getByText("Supplier category mapping")).toBeTruthy();
  });

  it("scopes child choices to the selected root and saves a manual mapping", async () => {
    mockApi();
    renderPage();
    await screen.findByText("Supplier kitchen");

    const root = screen.getByLabelText("Lizzor root for Supplier kitchen");
    fireEvent.change(root, { target: { value: "root-1" } });
    const child = screen.getByLabelText("Lizzor subcategory for Supplier kitchen") as HTMLSelectElement;
    expect(Array.from(child.options).map((option) => option.textContent)).toEqual(["No child", "Kitchen"]);
    fireEvent.change(child, { target: { value: "child-1" } });
    fireEvent.change(screen.getByLabelText("Mapping status for Supplier kitchen"), { target: { value: "mapped" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(mocks.apiRequest).toHaveBeenCalledWith(
      "/admin/supplier-category-mappings/mapping-1",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ rootCategoryId: "root-1", childCategoryId: "child-1", status: "mapped" }),
      }),
    ));
  });

  it("loads canonical options with mapping permissions without categories.view", async () => {
    expect(mocks.permissions).toEqual(["supplier_category_mappings.view", "supplier_category_mappings.manage"]);
    mockApi();
    renderPage();
    await screen.findByText("Supplier kitchen");
    expect(mocks.apiRequest).toHaveBeenCalledWith("/admin/catalog/supplier-category-mappings/categories");
    expect(screen.getByRole("option", { name: "Home" })).toBeTruthy();
  });

  it("supports bulk root, child, and status remapping", async () => {
    mockApi();
    renderPage();
    await screen.findByText("Supplier kitchen");
    fireEvent.click(screen.getByLabelText("Select Supplier kitchen"));
    fireEvent.change(screen.getByLabelText("Bulk Lizzor root"), { target: { value: "root-2" } });
    fireEvent.change(screen.getByLabelText("Bulk Lizzor child"), { target: { value: "child-2" } });
    fireEvent.change(screen.getByLabelText("Bulk mapping status"), { target: { value: "mapped" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply mapping" }));

    await waitFor(() => expect(mocks.apiRequest).toHaveBeenCalledWith(
      "/admin/supplier-category-mappings/bulk",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ ids: ["mapping-1"], rootCategoryId: "root-2", childCategoryId: "child-2", status: "mapped" }),
      }),
    ));
  });

  it("hides all mapping edit controls without manage permission", async () => {
    mocks.permissions = ["supplier_category_mappings.view"];
    mockApi();
    renderPage();
    await screen.findByText("Supplier kitchen");
    expect(screen.queryByLabelText("Lizzor root for Supplier kitchen")).toBeNull();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(screen.queryByLabelText("Select Supplier kitchen")).toBeNull();
    expect(screen.getAllByText("Unmapped").length).toBeGreaterThan(0);
  });
});