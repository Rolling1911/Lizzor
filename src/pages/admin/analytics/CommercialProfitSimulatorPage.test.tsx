// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
const { apiRequestMock } = vi.hoisted(() => ({ apiRequestMock: vi.fn() }));
vi.mock("../../../auth/api", () => ({ apiRequest: apiRequestMock }));

import CommercialProfitSimulatorPage from "./CommercialProfitSimulatorPage";

const pricingBands = [
  { id: "1", name: "Toonies cost 0-5", ruleType: "markup_percent", minCostEur: "0", maxCostEur: "5", value: "100", roundingMode: "none", priority: 1 },
  { id: "2", name: "Toonies cost 5-15", ruleType: "markup_percent", minCostEur: "5", maxCostEur: "15", value: "70", roundingMode: "none", priority: 2 },
  { id: "3", name: "Toonies cost 15-30", ruleType: "markup_percent", minCostEur: "15", maxCostEur: "30", value: "50", roundingMode: "none", priority: 3 },
  { id: "4", name: "Toonies cost 30-75", ruleType: "markup_percent", minCostEur: "30", maxCostEur: "75", value: "35", roundingMode: "none", priority: 4 },
  { id: "5", name: "Toonies cost 75+", ruleType: "markup_percent", minCostEur: "75", maxCostEur: null, value: "25", roundingMode: "none", priority: 5 },
];

describe("CommercialProfitSimulatorPage", () => {
  const fetchSpy = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchSpy);
    apiRequestMock.mockResolvedValue({ data: pricingBands });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("renders a live multi-product simulation with explicit assumptions", () => {
    render(<CommercialProfitSimulatorPage />);
    expect(screen.getByRole("heading", { name: "Commercial profit simulator" })).toBeTruthy();
    expect(screen.getByDisplayValue("Merino Everyday Tee")).toBeTruthy();
    expect(screen.getByDisplayValue("Ribbed Studio Trouser")).toBeTruthy();
    expect(screen.getByLabelText("VAT rate")).toBeTruthy();
    expect(screen.getByText("Contribution profit")).toBeTruthy();
    expect(screen.getByText("Customer merchandise revenue")).toBeTruthy();
    expect(screen.getByText("Payment processing")).toBeTruthy();
    expect(screen.getByText("Profit per order")).toBeTruthy();
    expect(screen.getByText("No persistence by design")).toBeTruthy();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("switches between single and multi-product modes without losing drafts", () => {
    render(<CommercialProfitSimulatorPage />);
    fireEvent.click(screen.getByRole("button", { name: "Single product" }));
    expect(screen.queryByDisplayValue("Ribbed Studio Trouser")).toBeNull();
    expect(screen.queryByRole("button", { name: /Add merchandise line/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Multi-product" }));
    expect(screen.getByDisplayValue("Ribbed Studio Trouser")).toBeTruthy();
  });

  it("applies quick supplier-cost scenarios while preserving editable inputs", () => {
    render(<CommercialProfitSimulatorPage />);
    const quickPanel = screen.getByRole("heading", { name: "Supplier unit cost" }).closest("section");
    fireEvent.click(within(quickPanel as HTMLElement).getByRole("button", { name: "€100" }));
    expect(screen.getByLabelText("Merino Everyday Tee supplier cost")).toHaveProperty("value", "100.00");
    fireEvent.change(screen.getByLabelText("Merino Everyday Tee supplier cost"), { target: { value: "75.25" } });
    expect(screen.getByLabelText("Merino Everyday Tee supplier cost")).toHaveProperty("value", "75.25");
  });

  it("supports editable VAT and health assumptions and reveals formulas", () => {
    render(<CommercialProfitSimulatorPage />);
    fireEvent.change(screen.getByLabelText("VAT rate"), { target: { value: "19" } });
    expect(screen.getByLabelText("VAT rate")).toHaveProperty("value", "19");
    expect(screen.getByText("Health thresholds")).toBeTruthy();
    expect(screen.getByText("Healthy from")).toBeTruthy();
    expect(screen.getByText("Warning below")).toBeTruthy();
    expect(screen.getByText("Loss at or below")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Explain this result/ }));
    expect(screen.getByText(/VAT-inclusive revenue × VAT rate/)).toBeTruthy();
  });

  it("saves temporary scenarios and compares them without network or storage", () => {
    const storageSpy = vi.spyOn(Storage.prototype, "setItem");
    render(<CommercialProfitSimulatorPage />);
    fireEvent.change(screen.getByLabelText("Scenario name"), { target: { value: "Higher freight" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByText("Saved “Higher freight” to this session.")).toBeTruthy();
    expect(screen.getByText("Side-by-side")).toBeTruthy();
    expect(screen.getAllByText("Higher freight").length).toBeGreaterThan(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(apiRequestMock).toHaveBeenCalledWith("/admin/commercial-profit/pricing-bands");
    expect(storageSpy).not.toHaveBeenCalled();
    storageSpy.mockRestore();
  });

  it("shows an optional pricing-band reference only when populated", () => {
    render(<CommercialProfitSimulatorPage />);
    const band = screen.getByLabelText("Merino Everyday Tee pricing band reference");
    fireEvent.change(band, { target: { value: "" } });
    expect(screen.queryByText("TEE-MER-001")).toBeNull();
    fireEvent.change(band, { target: { value: "70% band" } });
    expect(screen.getByText("70% band")).toBeTruthy();
  });

  it("has scoped responsive contracts for stacked mobile output and contained wide data", () => {
    const css = readFileSync(resolve(process.cwd(), "src/styles.css"), "utf8");
    expect(css).toContain("@media (max-width: 900px) { .commercial-layout { grid-template-columns:1fr;");
    expect(css).toContain(".commercial-lines { border:1px solid var(--sim-line); border-radius:7px; overflow:auto;");
    expect(css).toContain(".commercial-table-wrap { overflow-x:auto;");
    expect(css).toContain(".commercial-strategy-matrix-wrap");
    expect(css).toContain("@media (max-width: 620px)");
  });

  it("loads live read-only bands and renders the complete seven-cost strategy matrix", async () => {
    render(<CommercialProfitSimulatorPage />);
    expect(await screen.findByRole("heading", { name: "Pricing strategy comparison" })).toBeTruthy();
    expect(screen.getByLabelText("Target contribution margin (simulation only)")).toHaveProperty("value", "25");
    expect(screen.getByLabelText("Minimum contribution profit (simulation only)")).toHaveProperty("value", "2.00");
    const matrix = document.querySelector(".commercial-strategy-matrix") as HTMLTableElement;
    expect(within(matrix).getAllByRole("row")).toHaveLength(8);
    expect(within(matrix).getAllByText("Toonies cost 75+")).toHaveLength(2);
    expect(screen.getByText("Production bands are read-only.")).toBeTruthy();
  });

  it("recalculates targets immediately and keeps retail .99 as a separate preview", async () => {
    render(<CommercialProfitSimulatorPage />);
    await screen.findByText("Required commercial price");
    const required = document.querySelector(".commercial-required-price strong")?.textContent;
    fireEvent.change(screen.getByLabelText("Target contribution margin (simulation only)"), { target: { value: "50" } });
    await waitFor(() => expect(document.querySelector(".commercial-required-price strong")?.textContent).not.toBe(required));
    fireEvent.click(screen.getByText("Preview retail rounding"));
    expect(screen.getByText(/Retail preview:/)).toBeTruthy();
    expect(screen.getByText(/exact commercial price remains primary/)).toBeTruthy();
  });

  it("fails closed when live bands or strategy targets are invalid", async () => {
    apiRequestMock.mockRejectedValueOnce(new Error("Read failed"));
    const { unmount } = render(<CommercialProfitSimulatorPage />);
    expect(await screen.findByText("Pricing bands unavailable")).toBeTruthy();
    expect(screen.queryByText("Required commercial price")).toBeNull();
    unmount();

    apiRequestMock.mockResolvedValueOnce({ data: pricingBands });
    render(<CommercialProfitSimulatorPage />);
    await screen.findByText("Required commercial price");
    fireEvent.change(screen.getByLabelText("Target contribution margin (simulation only)"), { target: { value: "100" } });
    expect(await screen.findByText("Comparison unavailable")).toBeTruthy();
    expect(screen.queryByText("Required commercial price")).toBeNull();
  });
});