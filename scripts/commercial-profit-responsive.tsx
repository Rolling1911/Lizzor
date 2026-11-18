import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { chromium } from "playwright";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import CommercialProfitSimulatorPage from "../src/pages/admin/analytics/CommercialProfitSimulatorPage";
import type { PricingBandRule } from "../src/lib/pricingStrategy";

function chromiumPath() {
  return process.env.CHROMIUM_PATH || "/nix/store/qa9cnw4v5xkxyip6mb9kxqfq1z4x2dx1-chromium-138.0.7204.100/bin/chromium";
}

const css = await readFile("src/styles.css", "utf8");
const pricingBands: PricingBandRule[] = [
  { id: "1", name: "Toonies cost 0-5", ruleType: "markup_percent", minCostEur: "0", maxCostEur: "5", value: "100", roundingMode: "none", priority: 1 },
  { id: "2", name: "Toonies cost 5-15", ruleType: "markup_percent", minCostEur: "5", maxCostEur: "15", value: "70", roundingMode: "none", priority: 2 },
  { id: "3", name: "Toonies cost 15-30", ruleType: "markup_percent", minCostEur: "15", maxCostEur: "30", value: "50", roundingMode: "none", priority: 3 },
  { id: "4", name: "Toonies cost 30-75", ruleType: "markup_percent", minCostEur: "30", maxCostEur: "75", value: "35", roundingMode: "none", priority: 4 },
  { id: "5", name: "Toonies cost 75+", ruleType: "markup_percent", minCostEur: "75", maxCostEur: null, value: "25", roundingMode: "none", priority: 5 },
];
const markup = renderToStaticMarkup(<div className="admin-shell"><main className="admin-content"><CommercialProfitSimulatorPage initialPricingBands={pricingBands} /></main></div>);
const browser = await chromium.launch({ executablePath: chromiumPath(), headless: true });
try {
  await mkdir("screenshots/commercial-profit-simulator", { recursive: true });
  for (const width of [360, 390, 430, 768, 1280]) {
    const page = await browser.newPage({ viewport: { width, height: width < 700 ? 900 : 800 } });
    await page.setContent(`<style>${css}</style>${markup}`, { waitUntil: "domcontentloaded" });
    const geometry = await page.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      document: document.documentElement.scrollWidth,
      body: document.body.scrollWidth,
      layoutColumns: getComputedStyle(document.querySelector(".commercial-layout")!).gridTemplateColumns,
      matrixScrollContained: (() => {
        const matrix = document.querySelector(".commercial-strategy-matrix-wrap") as HTMLElement;
        return matrix.scrollWidth >= matrix.clientWidth && getComputedStyle(matrix).overflowX === "auto";
      })(),
    }));
    assert.ok(geometry.document <= geometry.viewport + 1, `Simulator document overflows at ${width}px: ${geometry.document}px`);
    assert.ok(geometry.body <= geometry.viewport + 1, `Simulator body overflows at ${width}px: ${geometry.body}px`);
    if (width <= 768) assert.equal(geometry.layoutColumns.trim().split(/\s+/).length, 1, `Simulator must stack at ${width}px`);
    assert.ok(geometry.matrixScrollContained, `Pricing strategy matrix must remain locally scrollable at ${width}px`);
    await page.screenshot({ path: `screenshots/commercial-profit-simulator/${width}.png`, fullPage: true });
    await page.close();
  }
  console.log("Commercial profit simulator responsive checks passed at 360, 390, 430, 768, and 1280px.");
} finally {
  await browser.close();
}