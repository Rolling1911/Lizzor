// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { vi, describe, it, beforeEach, afterEach, expect } from "vitest";
import { TooniesPage } from "./TooniesPage";

const api = vi.hoisted(() => ({ request: vi.fn() }));
const auth = vi.hoisted(() => ({ permissions: ["supplier_integrations.view", "supplier_integrations.sync", "supplier_integrations.manage", "supplier_integrations.pricing", "supplier_shipping.view", "supplier_shipping.manage"] }));
vi.mock("../../../auth/api", () => ({ apiRequest: api.request, ApiError: class ApiError extends Error { code?: string; constructor(code: string, message: string) { super(message); this.code = code; } } }));
vi.mock("../../../auth/AuthContext", () => ({ useAuth: () => auth }));

describe("Toonies supplier workspace", () => {
  beforeEach(() => {
    api.request.mockReset();
    api.request.mockResolvedValue({ data: { supplier: { access: "approval_pending" }, catalogue: {}, mappings: {}, syncRuns: [] } });
  });
  afterEach(() => cleanup());

  it("renders the exact approval-pending copy without presenting a failure state", async () => {
    render(<TooniesPage />);
    await waitFor(() => expect(screen.getAllByText("API access pending approval").length).toBeGreaterThan(0));
    expect(screen.queryByText("Integration failure")).toBeNull();
  });

  it("uses paginated searchable catalogue requests", async () => {
    api.request.mockImplementation(async (path: string) => path.includes("/catalogue?") ? { data: { items: [], meta: { page: 2, pageSize: 25, total: 0, hasNext: false } } } : { data: { supplier: { access: "available" }, catalogue: {}, mappings: {}, syncRuns: [] } });
    render(<TooniesPage />);
    await waitFor(() => expect(api.request).toHaveBeenCalledWith(expect.stringContaining("/admin/suppliers/toonies/overview")));
    expect(api.request).not.toHaveBeenCalledWith(expect.stringContaining("credentials"));
  });

  it("shows authoritative Toonies categories and filters read-only local catalogue metadata", async () => {
    const mappedCategoryId = "11111111-1111-4111-8111-111111111111";
    api.request.mockImplementation(async (path: string) => {
      if (path.includes("/catalogue?")) return {
        data: {
          items: [
            { id: "catalogue-1", title: "Mapped product", externalProductId: "TO-1", externalCategoryId: "10301", categoryMappingStatus: "mapped", mappedCategoryPath: "Home & Kitchen / Kitchen & Dining", variantCount: 1, originalAmount: 10, originalCurrency: "CNY", normalizedEur: 1.25, needsReview: false },
            { id: "catalogue-2", title: "Unmapped product", externalProductId: "TO-2", externalCategoryId: "103999", categoryMappingStatus: "needs_review", mappedCategoryPath: null, variantCount: 0, originalAmount: 20, originalCurrency: "CNY", normalizedEur: 2.5, needsReview: true },
          ],
          meta: { page: 1, pageSize: 25, total: 2, hasNext: false },
          filters: { mappedCategories: [{ id: mappedCategoryId, label: "Home & Kitchen / Kitchen & Dining" }] },
        },
      };
      return { data: { supplier: { access: "available" }, catalogue: {}, mappings: {}, syncRuns: [] } };
    });
    render(<TooniesPage />);
    await waitFor(() => expect(api.request).toHaveBeenCalledWith("/admin/suppliers/toonies/overview"));
    expect(api.request.mock.calls.some(([path]) => String(path).includes("/catalogue"))).toBe(false);

    fireEvent.click(await screen.findByRole("tab", { name: "Catalogue" }));
    expect(await screen.findByText("10301")).toBeTruthy();
    expect(screen.getByText("103999")).toBeTruthy();
    expect(screen.getAllByText("Not mapped").length).toBeGreaterThan(1);
    expect(screen.getAllByText("Home & Kitchen / Kitchen & Dining").length).toBeGreaterThan(0);

    fireEvent.change(screen.getByLabelText("Category mapping"), { target: { value: "mapped" } });
    await waitFor(() => expect(api.request.mock.calls.some(([path]) => String(path).includes("mapping=mapped"))).toBe(true));
    fireEvent.change(screen.getByLabelText("Mapped Lizzor category"), { target: { value: mappedCategoryId } });
    await waitFor(() => expect(api.request.mock.calls.some(([path]) => String(path).includes(`categoryId=${mappedCategoryId}`))).toBe(true));

    expect(api.request.mock.calls.some(([path, options]) => String(path).includes("/sync") || options?.method === "POST")).toBe(false);
  });

  it("allows only one filtered sync submission while the request is pending", async () => {
    let resolveSync!: (value: unknown) => void;
    const pendingSync = new Promise((resolve) => { resolveSync = resolve; });
    api.request.mockImplementation(async (path: string, options?: RequestInit) => {
      if (path === "/admin/suppliers/toonies/catalogue/sync" && options?.method === "POST") return pendingSync;
      if (path.includes("/catalogue?")) return { data: { items: [], meta: { page: 1, pageSize: 25, total: 0, hasNext: false } } };
      return { data: { supplier: { access: "available" }, catalogue: {}, mappings: {}, syncRuns: [] } };
    });
    render(<TooniesPage />);
    fireEvent.click(await screen.findByRole("tab", { name: "Catalogue" }));
    fireEvent.change(screen.getByPlaceholderText("Enter a Toonies product keyword"), { target: { value: "charger" } });
    const button = screen.getByRole("button", { name: "Discover products" });
    fireEvent.click(button);
    fireEvent.click(button);
    expect((await screen.findByRole("button", { name: "Discovering…" }) as HTMLButtonElement).disabled).toBe(true);
    const syncCalls = api.request.mock.calls.filter((call: any[]) => call[0] === "/admin/suppliers/toonies/catalogue/sync");
    expect(syncCalls).toHaveLength(1);
    expect(JSON.parse(syncCalls[0][1].body)).toEqual({ keyword: "charger", pageSize: 20 });
    resolveSync({ data: {} });
    await waitFor(() => expect((screen.getByRole("button", { name: "Discover products" }) as HTMLButtonElement).disabled).toBe(false));
  });

  it("keeps product discovery out of the Category Mapping interface", async () => {
    api.request.mockImplementation(async (path: string) => path.includes("/categories") && path.includes("category-mappings") ? { data: [] } : path.includes("/toonies/categories?") ? { data: { items: [], meta: { page: 1, pageSize: 20, total: 0, hasNext: false } } } : { data: { supplier: { access: "available" }, catalogue: {}, mappings: {}, syncRuns: [] } });
    render(<TooniesPage />);
    fireEvent.click(screen.getAllByRole("tab", { name: "Category mapping" })[0]);
    expect((await screen.findAllByText("Category mapping")).length).toBeGreaterThan(0);
    expect(screen.queryByText("Authoritative keyword")).toBeNull();
    expect(screen.queryByRole("button", { name: "Sync keyword" })).toBeNull();
  });

  it("renders placeholder names as unavailable with exact samples and preserves the mapping payload", async () => {
    const fullProductTitle = "Pendant lamp with an intentionally complete synchronized supplier product title";
    const row = { id: "toonies-category-1", externalCategoryName: " 1032353 ", externalCategoryId: "1032353", rootCategoryId: "", childCategoryId: "", status: "needs_review", publicationEnabled: false, complianceExcluded: true, sampleProducts: [{ id: "sample-1", title: fullProductTitle, productCode: "TO-LAMP-1", thumbnailUrl: "https://example.com/lamp.jpg" }] };
    api.request.mockImplementation(async (path: string, options?: RequestInit) => {
      if (path.startsWith("/admin/suppliers/toonies/categories?")) return { data: { items: [row], meta: { page: 1, pageSize: 20, total: 1, hasNext: false } } };
      if (path === "/admin/catalog/supplier-category-mappings/categories") return { data: [{ id: "root-lighting", name: "Lighting", parentId: null }, { id: "child-pendants", name: "Pendant lights", parentId: "root-lighting" }] };
      if (path.includes("/toonies/categories/toonies-category-1") && options?.method === "PATCH") return { data: row };
      return { data: { supplier: { access: "available" }, catalogue: {}, mappings: {}, syncRuns: [] } };
    });
    render(<TooniesPage />);
    fireEvent.click(await screen.findByRole("tab", { name: "Category mapping" }));
    expect(await screen.findByRole("list", { name: "Toonies category mappings" })).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.getByText("1 discovered category")).toBeTruthy();
    expect(screen.getByPlaceholderText("Search ID, name, or path")).toBeTruthy();
    expect(screen.getByText("Name unavailable from Toonies API")).toBeTruthy();
    expect(screen.getByText("1032353")).toBeTruthy();
    expect(screen.getByText(fullProductTitle)).toBeTruthy();
    expect(screen.getByText("TO-LAMP-1")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: `Preview image for ${fullProductTitle}` }));
    expect(screen.getByRole("dialog", { name: fullProductTitle })).toBeTruthy();
    expect(screen.getByRole("img", { name: fullProductTitle })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close image preview" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    const root = screen.getByLabelText("Root for category 1032353") as HTMLSelectElement;
    fireEvent.change(root, { target: { value: "root-lighting" } });
    const child = await screen.findByLabelText("Child for category 1032353") as HTMLSelectElement;
    fireEvent.change(child, { target: { value: "child-pendants" } });
    fireEvent.change(screen.getByLabelText("Status for category 1032353"), { target: { value: "mapped" } });
    fireEvent.click(screen.getByRole("button", { name: "Save mapping" }));
    await waitFor(() => expect(api.request).toHaveBeenCalledWith("/admin/suppliers/toonies/categories/toonies-category-1", expect.objectContaining({ method: "PATCH" })));
    const saveCall = api.request.mock.calls.find((call: any[]) => call[0].includes("/toonies/categories/toonies-category-1") && call[1]?.method === "PATCH");
    expect(JSON.parse(saveCall?.[1]?.body as string)).toEqual({ rootCategoryId: "root-lighting", childCategoryId: "child-pendants", status: "mapped" });
    expect(screen.getAllByText("Excluded").length).toBe(2);
  });

  it("uses plural discovered-category grammar from the filtered total", async () => {
    api.request.mockImplementation(async (path: string) => {
      if (path.startsWith("/admin/suppliers/toonies/categories?")) return { data: { items: [], meta: { page: 1, pageSize: 20, total: 2, hasNext: false } } };
      if (path === "/admin/catalog/supplier-category-mappings/categories") return { data: [] };
      return { data: { supplier: { access: "available" }, catalogue: {}, mappings: {}, syncRuns: [] } };
    });
    render(<TooniesPage />);
    fireEvent.click(await screen.findByRole("tab", { name: "Category mapping" }));
    expect(await screen.findByText("2 discovered categories")).toBeTruthy();
  });

  it("shows the dedicated Shipping tab with empty, non-invented form defaults", async () => {
    api.request.mockImplementation(async (path: string) => path.endsWith("/shipping") ? { data: [] } : { data: { supplier: { access: "available" }, catalogue: {}, mappings: {}, syncRuns: [] } });
    render(<TooniesPage />);
    fireEvent.click(await screen.findByRole("tab", { name: "Shipping" }));
    expect(await screen.findByText("No shipping rules")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Add rule" }));
    expect((screen.getByLabelText("Shipping country code") as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText("Amount EUR") as HTMLInputElement).value).toBe("");
  });

  it("creates and edits shipping rules with the complete manager payload", async () => {
    const rule = { id: "shipping-rule-1", countryCode: "DE", destinationZoneId: null, minWeightKg: "0", maxWeightKg: "0.5", amountEur: "8.50", minDeliveryDays: 2, maxDeliveryDays: 5, active: true };
    api.request.mockImplementation(async (path: string, options?: RequestInit) => {
      if (path.endsWith("/shipping") && options?.method === "POST") return { data: { id: "created-rule" } };
      if (path.includes("/shipping/") && options?.method === "PATCH") return { data: { id: "shipping-rule-1" } };
      if (path.endsWith("/shipping")) return { data: [rule] };
      return { data: { supplier: { access: "available" }, catalogue: {}, mappings: {}, syncRuns: [] } };
    });
    render(<TooniesPage />);
    fireEvent.click(await screen.findByRole("tab", { name: "Shipping" }));
    fireEvent.click(await screen.findByRole("button", { name: "Add rule" }));
    fireEvent.change(screen.getByLabelText("Shipping country code"), { target: { value: "DE" } });
    fireEvent.change(screen.getByLabelText("Amount EUR"), { target: { value: "8.50" } });
    fireEvent.change(screen.getByLabelText("Maximum kg (optional)"), { target: { value: "0.5" } });
    fireEvent.click(screen.getByRole("button", { name: "Save rule" }));
    await waitFor(() => expect(api.request).toHaveBeenCalledWith("/admin/suppliers/toonies/shipping", expect.objectContaining({
      method: "POST",
      body: expect.stringContaining('"countryCode":"DE"'),
    })));
    const createCall = api.request.mock.calls.find((call: any[]) => call[0].endsWith("/shipping") && call[1]?.method === "POST");
    if (!createCall) throw new Error("shipping create request was not sent");
    expect(JSON.parse(createCall[1].body as string)).toMatchObject({
       countryCode: "DE", destinationZoneId: null, minWeightKg: 0, maxWeightKg: 0.5, amountEur: 8.5, minDeliveryDays: null, maxDeliveryDays: null, temporary: true, active: true,
    });
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("Amount EUR"), { target: { value: "9.50" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(api.request).toHaveBeenCalledWith("/admin/suppliers/toonies/shipping/shipping-rule-1", expect.objectContaining({
      method: "PATCH",
      body: expect.stringContaining('"amountEur":9.5'),
    })));
  });

  it("renders a clear shipping loading error", async () => {
    api.request.mockImplementation(async (path: string) => {
      if (path.endsWith("/shipping")) throw new Error("Shipping rules unavailable.");
      return { data: { supplier: { access: "available" }, catalogue: {}, mappings: {}, syncRuns: [] } };
    });
    render(<TooniesPage />);
    fireEvent.click(await screen.findByRole("tab", { name: "Shipping" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Shipping rules unavailable.");
  });

  it("shows the formula price separately when a review has no manual override", async () => {
    const review = {
      id: "review-formula-only",
      variantId: "variant-1",
      productName: "Formula product",
      variantName: "Blue",
      skuCode: "FORMULA-1",
      previousCostEur: 1.5,
      proposedCostEur: 10,
      previousPriceEur: 3,
      formulaPriceEur: 17,
      manualOverrideEur: null,
      manualOverrideSource: null,
      proposedPriceEur: 17,
      increasePercent: 566.7,
      pricingRuleName: "Toonies cost 5-15",
      pricingMinCostEur: 5,
      pricingMaxCostEur: 15,
      thresholdPercent: 20,
      detectedAt: "2026-01-01T00:00:00.000Z",
    };
    api.request.mockImplementation(async (path: string) => {
      if (path.endsWith("/pricing/reviews")) return { data: [review] };
      if (path.endsWith("/pricing")) return { data: [] };
      if (path.endsWith("/overview")) return { data: { supplier: { access: "available" }, catalogue: {}, mappings: {}, syncRuns: [] } };
      return { data: [] };
    });

    render(<TooniesPage />);
    fireEvent.click(await screen.findByRole("tab", { name: "Pricing" }));
    const card = (await screen.findByRole("heading", { name: /Formula product/ })).closest("article");
    expect(card).not.toBeNull();
    expect(within(card as HTMLElement).getByText("Formula price")).toBeTruthy();
    expect(within(card as HTMLElement).getAllByText("EUR 17.00")).toHaveLength(2);
    expect(within(card as HTMLElement).getByText("Final proposed price")).toBeTruthy();
    expect(within(card as HTMLElement).getByText("Pricing band")).toBeTruthy();
    expect(within(card as HTMLElement).getByText("Toonies cost 5-15")).toBeTruthy();
    expect(within(card as HTMLElement).queryByText("Manual selling-price override active")).toBeNull();
  });

  it("identifies a manual override while keeping formula and pricing-band values separate", async () => {
    const review = {
      id: "review-manual-override",
      variantId: "variant-2",
      productName: "Override product",
      variantName: "Red",
      skuCode: "OVERRIDE-1",
      previousCostEur: 1.5,
      proposedCostEur: 10,
      previousPriceEur: 77,
      formulaPriceEur: 17,
      manualOverrideEur: 77,
      manualOverrideSource: "variant",
      proposedPriceEur: 77,
      increasePercent: 566.7,
      pricingRuleName: "Toonies cost 5-15",
      pricingMinCostEur: 5,
      pricingMaxCostEur: 15,
      thresholdPercent: 20,
      detectedAt: "2026-01-01T00:00:00.000Z",
    };
    api.request.mockImplementation(async (path: string) => {
      if (path.endsWith("/pricing/reviews")) return { data: [review] };
      if (path.endsWith("/pricing")) return { data: [] };
      if (path.endsWith("/overview")) return { data: { supplier: { access: "available" }, catalogue: {}, mappings: {}, syncRuns: [] } };
      return { data: [] };
    });

    render(<TooniesPage />);
    fireEvent.click(await screen.findByRole("tab", { name: "Pricing" }));

    const card = (await screen.findByRole("heading", { name: /Override product/ })).closest("article");
    expect(card).not.toBeNull();
    const reviewCard = within(card as HTMLElement);
    expect(reviewCard.getByText("Manual selling-price override active")).toBeTruthy();
    expect(reviewCard.getByText("Formula price")).toBeTruthy();
    expect(reviewCard.getByText("Manual price: EUR 77.00")).toBeTruthy();
    expect(reviewCard.getByText("Override source: Catalogue variant")).toBeTruthy();
    expect(reviewCard.getByText("Final proposed price")).toBeTruthy();
    expect(reviewCard.getByText("Pricing band")).toBeTruthy();
    expect(reviewCard.getByText("Toonies cost 5-15")).toBeTruthy();
    expect(reviewCard.getByText("5–15 EUR · threshold 20%")).toBeTruthy();
  });
});