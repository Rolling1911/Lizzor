// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";

const { apiRequest } = vi.hoisted(() => ({ apiRequest: vi.fn() }));
vi.mock("../../../auth/api", () => ({ apiRequest }));
vi.mock("../../../auth/AuthContext", () => ({ useAuth: () => ({ permissions: ["analytics.margin"] }) }));
vi.mock("../../../components/ui/Icon", () => ({ Icon: () => <span aria-hidden="true" /> }));
vi.mock("../../../components/admin/AdminPrimitives", () => ({
  AdminPageHeader: ({ title, actions }: any) => <header><h1>{title}</h1>{actions}</header>,
  ChartContainer: ({ title, children }: any) => <section><h2>{title}</h2>{children}</section>,
  DateRangeSelector: ({ value, onChange, customStart, customEnd, onCustomStartChange, onCustomEndChange }: any) => <div>
    {["today", "7d", "30d", "custom"].map((key) => <button type="button" key={key} aria-pressed={value === key} onClick={() => onChange(key)}>{key}</button>)}
    {value === "custom" && <><input aria-label="Start date" type="date" value={customStart} onChange={(e) => onCustomStartChange(e.target.value)} /><input aria-label="End date" type="date" value={customEnd} onChange={(e) => onCustomEndChange(e.target.value)} /></>}
  </div>,
  EmptyState: ({ title, description }: any) => <div role="status"><h3>{title}</h3><p>{description}</p></div>,
  ErrorState: ({ description, onRetry }: any) => <div role="alert"><span>{description}</span><button onClick={onRetry}>Try again</button></div>,
  KpiCard: ({ label, value }: any) => <div><span>{label}</span><strong>{value}</strong></div>,
  LoadingState: ({ label }: any) => <div role="status">{label}</div>,
  Pagination: ({ page, onChange }: any) => <div><span>Page {page}</span><button onClick={() => onChange(page + 1)}>Next</button></div>,
  StatusBadge: ({ status }: any) => <span>{status}</span>,
}));

import { AnalyticsPage } from "./AnalyticsPages";

const empty = {
  overview: { metrics: { grossSales: { value: 0, change: null }, netProductSales: { value: 0 }, collected: { value: 0 }, orders: { value: 0, change: null }, aov: { value: 0 }, unitsSold: 0, discounts: 0, shipping: 0, vat: 0, newCustomers: 0, repeatCustomers: 0, accountCustomers: 0, returns: 0, returnedItems: 0 }, definitions: { grossSales: "", netProductSales: "" }, trend: [], statuses: [], profitability: { message: "" } },
  sales: { summary: { grossSales: 0, netSales: 0, collected: 0, refunds: 0, shipping: 0, vat: 0, orders: 0, aov: 0, discounts: 0 }, trend: [], countries: [] },
  orders: { statuses: [], paymentStatuses: [], fulfillmentStages: [], items: [], meta: { page: 1, hasNext: false } },
  products: { items: [], categories: [], brands: [], lowStock: [], noSales: [], note: "" },
  customers: { items: [], companies: [], privacy: "" },
  promotions: { items: [] },
  inventory: { items: [], movements: [] },
  margin: { summary: { revenue: 0, productCost: 0, productContribution: 0, contributionPercent: 0, currentStockValue: 0 }, definition: "", items: [] },
  fulfillment: { stages: [], couriers: [], timing: {}, note: "" },
  returns: { summary: { requests: 0, items: 0 }, statuses: [], reasons: [], products: [], note: "" },
} as const;

const wrap = (report: any) => <MemoryRouter><AnalyticsPage report={report} /></MemoryRouter>;

describe("admin analytics reports", () => {
  beforeEach(() => {
    apiRequest.mockReset();
    apiRequest.mockImplementation(async (path: string) => ({ data: empty[path.match(/analytics(?:\/([^?]+))?/)?.[1] as keyof typeof empty] ?? empty.overview }));
    vi.stubGlobal("fetch", vi.fn());
    vi.stubGlobal("URL", { ...URL, createObjectURL: vi.fn(() => "blob:report"), revokeObjectURL: vi.fn() });
  });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it.each(["overview", "sales", "orders", "products", "customers", "promotions", "inventory", "margin", "fulfillment", "returns"] as const)("renders %s empty response", async (report) => {
    render(wrap(report));
    await waitFor(() => expect(apiRequest).toHaveBeenCalled());
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("renders authoritative populated Sales totals and country subsection", async () => {
    apiRequest.mockResolvedValueOnce({ data: {
      ...empty.sales,
      summary: { ...empty.sales.summary, grossSales: 120, netSales: 100, collected: 110, refunds: 10, shipping: 8, vat: 20, orders: 2 },
      trend: [{ day: "2025-01-01", orders: 2, grossSales: 120, netSales: 100, discounts: 20 }],
      countries: [{ country: "Cyprus", orders: 2, collected: 110 }],
    } });
    render(wrap("sales"));
    expect(await screen.findByText("Cyprus")).toBeTruthy();
    expect(screen.getByText("Collected")).toBeTruthy();
    expect(screen.getByText("Refunds")).toBeTruthy();
    expect(screen.getByText("Shipping")).toBeTruthy();
  });

  it("uses the exact query contract and paginates only Orders", async () => {
    render(wrap("sales"));
    await waitFor(() => expect(apiRequest).toHaveBeenCalledWith("/admin/analytics/sales?range=30d", expect.anything()));
    expect(apiRequest.mock.calls[0][0]).not.toContain("page=");
    cleanup();
    render(wrap("orders"));
    await waitFor(() => expect(apiRequest).toHaveBeenCalledWith("/admin/analytics/orders?range=30d&page=1&pageSize=25", expect.anything()));
    expect(screen.getByText("Page 1")).toBeTruthy();
  });

  it("sends custom range values and retries errors", async () => {
    apiRequest.mockRejectedValueOnce(new Error("temporary failure")).mockResolvedValue({ data: empty.sales });
    render(wrap("sales"));
    expect(await screen.findByText("temporary failure")).toBeTruthy();
    fireEvent.click(screen.getByText("Try again"));
    await waitFor(() => expect(apiRequest).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByText("custom"));
    fireEvent.change(screen.getByLabelText("Start date"), { target: { value: "2025-01-01" } });
    fireEvent.change(screen.getByLabelText("End date"), { target: { value: "2025-01-31" } });
    await waitFor(() => expect(apiRequest.mock.calls.some(([path]) => path.includes("start=2025-01-01T00%3A00%3A00.000Z"))).toBe(true));
  });

  it("suppresses an older response after changing report", async () => {
    let resolveOld!: (value: any) => void;
    apiRequest.mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; })).mockResolvedValue({ data: empty.overview });
    const { rerender } = render(wrap("sales"));
    rerender(<MemoryRouter><AnalyticsPage report="overview" /></MemoryRouter>);
    resolveOld({ data: { ...empty.sales, note: "stale" } });
    await waitFor(() => expect(screen.queryByText("stale")).toBeNull());
  });

  it("renders route links, explicit empty states, and exports success/errors", async () => {
    render(wrap("sales"));
    await screen.findByText("No sales in this period");
    expect(document.querySelector('a[href="/admin/analytics/orders"]')).toBeTruthy();
    (fetch as any).mockResolvedValueOnce({ ok: true, blob: async () => new Blob(["a,b"]) });
    fireEvent.click(screen.getByRole("button", { name: /Export CSV/ }));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith(expect.stringContaining("/api/v1/admin/reports/export?report=sales&range=30d"), expect.objectContaining({ credentials: "include" })));
    (fetch as any).mockResolvedValueOnce({ ok: false, json: async () => ({ error: { message: "export denied" } }) });
    fireEvent.click(screen.getByRole("button", { name: /Export CSV/ }));
    expect(await screen.findByText("export denied")).toBeTruthy();
  });

  it("links Reports index Sales and Overview to their canonical routes", async () => {
    render(<MemoryRouter initialEntries={["/admin/reports"]}><AnalyticsPage report="sales" /></MemoryRouter>);
    await screen.findByText("No sales in this period");
    expect(document.querySelector('a[href="/admin/reports"]')?.textContent).toBe("Sales");
    expect(document.querySelector('a[href="/admin/reports/overview"]')?.textContent).toBe("Overview");
  });
});