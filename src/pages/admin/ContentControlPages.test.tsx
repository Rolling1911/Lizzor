// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { apiRequest } = vi.hoisted(() => ({ apiRequest: vi.fn() }));
vi.mock("../../auth/api", () => ({ apiRequest }));
vi.mock("../../auth/AuthContext", () => ({ useAuth: () => ({ permissions: ["content.view", "content.manage"] }) }));

import { ContentPagesPage } from "./ContentControlPages";

const draft = {
  id: "draft-1", slug: "shipping", pageType: "informational", title: "Shipping", excerpt: "Shipping details",
  bodyJson: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Details" }] }] },
  seoTitle: "Shipping", seoDescription: "Shipping information", noIndex: false, status: "draft",
  createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-02T00:00:00Z", createdByAdmin: "Ada", updatedByAdmin: "Ada",
};
const published = { ...draft, id: "published-1", slug: "about", title: "About", status: "published" };

describe("ContentPagesPage CMS safeguards", () => {
  beforeEach(() => {
    apiRequest.mockReset();
    apiRequest.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === `/admin/content/${draft.id}/preview` && init?.method === "POST") return { data: { page: { ...draft, title: "Shipping preview" }, previewReceipt: "preview-receipt-1" } };
      if (path === `/admin/content/${published.id}/status` && init?.method === "POST") return { data: { ...published, status: "draft" } };
      if (path === `/admin/content/${draft.id}/status` && init?.method === "POST") return { data: { ...draft, status: "published" } };
      if (path.startsWith("/admin/content") && !init) {
        if (path.includes("status=published")) return { data: { items: [published] } };
        return { data: { items: [draft] } };
      }
      throw new Error(`Unexpected API request: ${path}`);
    });
  });
  afterEach(() => cleanup());

  it("loads without status=all, sends authoritative search/status filters, and protects drafts behind preview", async () => {
    render(<ContentPagesPage />);
    await screen.findByText("Shipping");
    expect(apiRequest).toHaveBeenCalledWith("/admin/content");
    expect(screen.queryByRole("button", { name: "Publish" })).toBeNull();

    fireEvent.change(screen.getByRole("textbox", { name: "Search content pages" }), { target: { value: "ship" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Filter by status" }), { target: { value: "draft" } });
    await waitFor(() => expect(apiRequest).toHaveBeenCalledWith("/admin/content?status=draft&search=ship"));

    fireEvent.click((await screen.findByText("Shipping", { selector: "strong" })).closest("button")!);
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    await waitFor(() => expect(apiRequest).toHaveBeenCalledWith(`/admin/content/${draft.id}/preview`, { method: "POST", body: "{}" }));
    expect(screen.getByText("Shipping preview")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Continue to publish" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Continue to publish" }));
    expect(screen.getByRole("dialog")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Confirm and publish" }));
    await waitFor(() => expect(apiRequest).toHaveBeenCalledWith(`/admin/content/${draft.id}/status`, expect.objectContaining({
      method: "POST", body: JSON.stringify({ action: "publish", confirmed: true, previewReceipt: "preview-receipt-1" }),
    })));
  });

  it("keeps public fields and Legal workspace separation copy visible", async () => {
    render(<ContentPagesPage />);
    expect(screen.getByText(/Canonical Legal & Compliance documents remain in their separate workspace/)).toBeTruthy();
    fireEvent.click((await screen.findByText("Shipping", { selector: "strong" })).closest("button")!);
    expect(screen.getByText("Title")).toBeTruthy();
    expect(screen.getByText("Slug")).toBeTruthy();
    expect(screen.getByText("Page type")).toBeTruthy();
    expect(screen.getByText("SEO title")).toBeTruthy();
    expect(screen.getByText("SEO description")).toBeTruthy();
    expect(screen.getByText("Exclude from search indexing")).toBeTruthy();
  });

  it("requires confirmation before unpublishing a published page", async () => {
    apiRequest.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === "/admin/content") return { data: { items: [published] } };
      if (path === "/admin/content?status=published") return { data: { items: [published] } };
      if (path === `/admin/content/${published.id}/status` && init?.method === "POST") return { data: { ...published, status: "draft" } };
      throw new Error(`Unexpected API request: ${path}`);
    });
    render(<ContentPagesPage />);
    fireEvent.change(screen.getByRole("combobox", { name: "Filter by status" }), { target: { value: "published" } });
    fireEvent.click((await screen.findByText("About", { selector: "strong" })).closest("button")!);
    fireEvent.click(screen.getByRole("button", { name: "Unpublish" }));
    expect(screen.getByRole("dialog")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Confirm unpublish" }));
    await waitFor(() => expect(apiRequest).toHaveBeenCalledWith(`/admin/content/${published.id}/status`, expect.objectContaining({
      method: "POST", body: JSON.stringify({ action: "unpublish", confirmed: true }),
    })));
  });
});