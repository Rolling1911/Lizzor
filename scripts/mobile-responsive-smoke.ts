import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium, type Browser, type Page } from "playwright";

const baseURL = process.env.BROWSER_BASE_URL ?? "http://127.0.0.1:5000";
const screenshotDir = process.env.MOBILE_SCREENSHOT_DIR ?? "screenshots/mobile-regression";
const testIpSubnet = process.pid % 250;
const portraitWidths = [320, 375, 390, 430, 768, 1024, 1280, 1440];
const landscapeViewports = [
  { width: 844, height: 390, name: "landscape-home" },
  { width: 812, height: 375, name: "landscape-checkout" },
];
const customerRoutes = [
  "/",
  "/shop",
  "/categories",
  "/cart",
  "/checkout",
  "/login",
  "/register",
  "/start-a-business",
  "/account",
  "/account/companies",
  "/support",
  "/chat",
];
const referenceCategoryRoutes = [
  "/categories/electronics",
  "/categories/home-kitchen",
  "/categories/beauty-personal-care",
  "/categories/travel-luggage",
  "/categories/office-stationery",
];

type LayoutMetrics = {
  path: string;
  viewport: number;
  documentWidth: number;
  bodyWidth: number;
  overflowElements: Array<{ selector: string; left: number; right: number; width: number }>;
};

function chromiumPath() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  try {
    return execFileSync("which", ["chromium"], { encoding: "utf8" }).trim();
  } catch {
    return "/nix/store/qa9cnw4v5xkxyip6mb9kxqfq1z4x2dx1-chromium-138.0.7204.100/bin/chromium";
  }
}

async function waitForCustomerPage(page: Page, route: string) {
  await page.goto(route, { waitUntil: "networkidle" });
  await page.waitForTimeout(100);
}

async function layoutMetrics(page: Page): Promise<LayoutMetrics> {
  return page.evaluate(() => {
    const viewport = document.documentElement.clientWidth;
    const overflowElements = [...document.querySelectorAll("body *")].flatMap((element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      if (style.display === "none" || style.visibility === "hidden" || style.position === "fixed") return [];
      if (rect.left >= -1 && rect.right <= viewport + 1) return [];
      let ancestor = element.parentElement;
      while (ancestor && ancestor !== document.body) {
        const ancestorStyle = getComputedStyle(ancestor);
        const ancestorRect = ancestor.getBoundingClientRect();
        if (
          (ancestorStyle.overflowX === "auto" || ancestorStyle.overflowX === "scroll")
          && ancestorRect.left >= -1
          && ancestorRect.right <= viewport + 1
        ) return [];
        ancestor = ancestor.parentElement;
      }
      const className = typeof element.className === "string" ? element.className : "";
      return [{
        selector: `${element.tagName.toLowerCase()}${className ? `.${className.trim().split(/\s+/).join(".")}` : ""}`,
        left: Math.round(rect.left),
        right: Math.round(rect.right),
        width: Math.round(rect.width),
      }];
    }).slice(0, 8);

    return {
      path: location.pathname,
      viewport,
      documentWidth: document.documentElement.scrollWidth,
      bodyWidth: document.body.scrollWidth,
      overflowElements,
    };
  });
}

function assertNoPageOverflow(metrics: LayoutMetrics) {
  assert.ok(
    metrics.documentWidth <= metrics.viewport + 1,
    `${metrics.path} has document overflow at ${metrics.viewport}px: ${metrics.documentWidth}px`,
  );
  assert.ok(
    metrics.bodyWidth <= metrics.viewport + 1,
    `${metrics.path} has body overflow at ${metrics.viewport}px: ${metrics.bodyWidth}px`,
  );
  assert.deepEqual(
    metrics.overflowElements,
    [],
    `${metrics.path} has an element outside the viewport at ${metrics.viewport}px: ${JSON.stringify(metrics.overflowElements)}`,
  );
}

async function assertTwoColumnGrid(page: Page, selector: string, route: string, width: number) {
  const count = await page.locator(selector).count();
  if (!count) return;
  const columns = await page.locator(selector).first().evaluate((element) =>
    getComputedStyle(element).gridTemplateColumns.trim().split(/\s+/).filter(Boolean).length,
  );
  assert.equal(columns, 2, `${route} should keep ${selector} at two columns at ${width}px.`);
}

async function assertCompactUtilityBar(page: Page, width: number) {
  const benefits = page.locator(".utility-bar__benefits > span");
  assert.equal(await benefits.count(), 5, `The utility bar should keep all five benefit items in the DOM at ${width}px.`);
  assert.equal(
    await page.locator(".utility-bar__benefits").evaluate((element) => getComputedStyle(element).display),
    "none",
    `All utility benefit items must be hidden at ${width}px.`,
  );
  assert.deepEqual(
    await benefits.evaluateAll((items) => items.map((item) => {
      const rect = item.getBoundingClientRect();
      return { width: rect.width, height: rect.height };
    })),
    Array.from({ length: 5 }, () => ({ width: 0, height: 0 })),
    `Utility benefit items must have no layout bounds at ${width}px.`,
  );

  if (width <= 680) {
    assert.equal(await page.locator(".mobile-country-picker").isVisible(), true, `The mobile country control must remain visible at ${width}px.`);
    assert.equal(await page.locator(".mobile-storefront-cart").isVisible(), true, `The mobile cart control must remain visible at ${width}px.`);
    assert.equal(await page.locator(".mobile-storefront-search").isVisible(), true, `The mobile search must remain visible at ${width}px.`);
    assert.equal(await page.locator(".mobile-bottom-nav").isVisible(), true, `The mobile bottom navigation must remain visible at ${width}px.`);
    return;
  }

  const controls = page.locator(".utility-bar__controls");
  assert.equal(await controls.isVisible(), true, `Ship-to and language controls must remain visible at ${width}px.`);
  const controlRects = await controls.locator(".utility-control__trigger").evaluateAll((items) =>
    items.map((item) => {
      const rect = item.getBoundingClientRect();
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
    }),
  );
  assert.equal(controlRects.length, 2, `Both utility controls must render at ${width}px.`);
  for (const rect of controlRects) {
    assert.ok(rect.left >= -1 && rect.right <= width + 1, `A utility control is clipped at ${width}px.`);
  }
  assert.ok(controlRects[1].left >= controlRects[0].right - 1, `Utility controls overlap at ${width}px.`);
}

async function assertFooterLiveChat(page: Page, width: number) {
  const rejectConsent = page.getByRole("button", { name: "Reject non-essential" });
  if (await rejectConsent.isVisible().catch(() => false)) {
    await rejectConsent.click();
    await page.waitForTimeout(50);
  }
  const footer = page.locator("#storefront-footer");
  let liveChat = footer.locator("a.footer-desktop-only");
  if (width <= 680) {
    const supportTrigger = footer.getByRole("button", { name: "Support", exact: true });
    assert.equal(await supportTrigger.getAttribute("aria-expanded"), "false", `The mobile footer should start collapsed at ${width}px.`);
    await supportTrigger.click();
    liveChat = footer.locator("#footer-support").getByRole("link", { name: "Live Chat" });
  }
  assert.equal(await liveChat.count(), 1, `The footer must expose one Live Chat link at ${width}px.`);
  assert.equal(await liveChat.isVisible(), true, `The footer Live Chat link must be visible when Support is open at ${width}px.`);
  assert.equal(await liveChat.getAttribute("href"), "/chat", `The footer Live Chat link must use the existing chat route at ${width}px.`);
  assert.equal(await footer.getByText("Live stock visibility", { exact: true }).count(), 0, `The old stock visibility footer copy must be removed at ${width}px.`);
}

async function assertCompleteAppArtwork(page: Page, width: number) {
  const section = page.locator("#mobile-apps");
  const image = section.locator("img");
  assert.equal(await image.count(), 1, `The app banner must render one complete artwork image at ${width}px.`);
  assert.equal(await image.getAttribute("src"), "/lizzor-mobile-app-banner.png", `The managed app artwork must be shown at ${width}px.`);
  await image.waitFor({ state: "visible" });
  const geometry = await image.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { width: rect.width, height: rect.height, left: rect.left, right: rect.right, naturalWidth: element.naturalWidth, naturalHeight: element.naturalHeight };
  });
  assert.deepEqual([geometry.naturalWidth, geometry.naturalHeight], [1920, 480], `The complete uploaded artwork must load at ${width}px.`);
  assert.ok(geometry.width > 0 && geometry.height > 0, `The app banner must be visibly rendered at ${width}px.`);
  assert.ok(Math.abs(geometry.width / geometry.height - 4) < 0.05, `The app banner must preserve its 4:1 aspect ratio at ${width}px.`);
  assert.ok(geometry.left >= -1 && geometry.right <= width + 1, `The app banner must remain inside the ${width}px viewport.`);
  assert.equal(await section.locator(".home-app-promo__phones, .home-app-promo__copy, .home-app-promo__download").count(), 0, `The coded app-banner composition must be absent at ${width}px.`);
}

async function assertCouponLayout(page: Page, width: number) {
  const coupon = page.locator(".coupon-box");
  if (!(await coupon.count())) return;
  const dimensions = await coupon.evaluate((element) => {
    const input = element.querySelector("input")?.getBoundingClientRect();
    const button = element.querySelector("button")?.getBoundingClientRect();
    const box = element.getBoundingClientRect();
    return input && button ? {
      boxWidth: box.width,
      inputWidth: input.width,
      buttonWidth: button.width,
      inputHeight: input.height,
      buttonHeight: button.height,
      inputRight: input.right,
      buttonLeft: button.left,
      boxRight: box.right,
    } : null;
  });
  assert.ok(dimensions, `The coupon controls should render together at ${width}px.`);
  assert.ok(dimensions.inputWidth > dimensions.buttonWidth, `The coupon input should be wider than Apply at ${width}px.`);
  assert.ok(Math.abs(dimensions.inputHeight - dimensions.buttonHeight) <= 1, `Coupon controls should have equal heights at ${width}px.`);
  assert.ok(dimensions.inputRight <= dimensions.buttonLeft + 1, `Coupon controls overlap at ${width}px.`);
  assert.ok(dimensions.boxRight <= width + 1, `Coupon controls overflow at ${width}px.`);
}

async function assertCheckoutPhoneSelector(page: Page, width: number) {
  const control = page.locator(".commerce-phone-control");
  const trigger = page.locator(".commerce-phone-trigger");
  const countrySelect = page.getByLabel("Contact phone country calling code");
  const phoneInput = page.locator('.commerce-phone-control input[name="phone"]');

  assert.equal(await control.count(), 1, `Checkout should render one phone selector at ${width}px.`);
  assert.equal(await trigger.count(), 1, `Checkout should render one compact phone trigger at ${width}px.`);
  assert.equal(await countrySelect.count(), 1, `Checkout should expose one phone country dropdown at ${width}px.`);
  assert.equal(await phoneInput.count(), 1, `Checkout should render one contact phone input at ${width}px.`);

  const longCountryOption = await countrySelect.locator('option[value="BA"]').textContent();
  assert.match(longCountryOption ?? "", /\+387/, "The opened selector should include the full dialing code.");
  assert.match(longCountryOption ?? "", /Bosnia and Herzegovina/, "The opened selector should include the full country name.");
  await countrySelect.selectOption("BA");

  const triggerText = (await trigger.textContent())?.replace(/\s+/g, " ").trim() ?? "";
  assert.match(triggerText, /\+387/, `The closed selector should show the dial code at ${width}px.`);
  assert.doesNotMatch(triggerText, /Bosnia|Herzegovina/, `The closed selector should not show country names at ${width}px.`);

  const dimensions = await control.evaluate((element) => {
    const triggerElement = element.querySelector(".commerce-phone-trigger");
    const inputElement = element.querySelector("input");
    const selectElement = element.querySelector("select");
    if (!triggerElement || !inputElement || !selectElement) return null;
    const box = element.getBoundingClientRect();
    const triggerBox = triggerElement.getBoundingClientRect();
    const inputBox = inputElement.getBoundingClientRect();
    const selectBox = selectElement.getBoundingClientRect();
    return {
      boxLeft: box.left,
      boxRight: box.right,
      triggerLeft: triggerBox.left,
      triggerRight: triggerBox.right,
      triggerClientWidth: triggerElement.clientWidth,
      triggerScrollWidth: triggerElement.scrollWidth,
      inputLeft: inputBox.left,
      inputRight: inputBox.right,
      inputWidth: inputBox.width,
      selectLeft: selectBox.left,
      selectRight: selectBox.right,
    };
  });
  assert.ok(dimensions, `Checkout phone geometry should be measurable at ${width}px.`);
  assert.ok(dimensions.triggerScrollWidth <= dimensions.triggerClientWidth, `Phone trigger content clips at ${width}px.`);
  assert.ok(dimensions.triggerLeft >= dimensions.boxLeft - 1, `Phone trigger overflows left at ${width}px.`);
  assert.ok(dimensions.triggerRight <= dimensions.boxRight + 1, `Phone trigger overflows right at ${width}px.`);
  assert.ok(dimensions.selectLeft >= dimensions.triggerLeft - 1 && dimensions.selectRight <= dimensions.triggerRight + 1, `Phone dropdown overlay escapes its trigger at ${width}px.`);
  assert.ok(dimensions.triggerRight <= dimensions.inputLeft + 1, `Phone trigger overlaps the phone input at ${width}px.`);
  assert.ok(dimensions.inputRight <= dimensions.boxRight + 1, `Phone input overflows its control at ${width}px.`);
  assert.ok(dimensions.inputWidth >= 100, `Phone input should retain useful width at ${width}px.`);
}

async function assertUnavailableCategoryEmptyState(page: Page, route: string, width: number) {
  assert.equal(await page.locator(".category-hero__image").count(), 0, `${route} should not synthesize category media at ${width}px.`);
  const emptyState = page.locator(".catalog-results .storefront-state");
  assert.equal(await emptyState.count(), 1, `${route} should render one empty catalog state at ${width}px.`);
  assert.match((await emptyState.textContent()) ?? "", /No products matched that search/i, `${route} should explain that no products are available at ${width}px.`);
  assert.match((await page.locator(".catalog-heading__count").textContent()) ?? "", /^0 products$/i, `${route} should report zero public products at ${width}px.`);
  const dimensions = await emptyState.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { left: rect.left, right: rect.right, width: rect.width, height: rect.height };
  });
  assert.ok(dimensions.left >= -1 && dimensions.right <= width + 1, `${route} empty state should stay within the viewport at ${width}px.`);
  assert.ok(dimensions.width > 0 && dimensions.height > 0, `${route} empty state should remain visible at ${width}px.`);
}

async function assertMobileHomepageCategoryGrid(page: Page, width: number) {
  const layout = await page.locator(".storefront-home .home-category-grid--mobile").evaluate((grid) => {
    const cards = [...grid.querySelectorAll<HTMLElement>(".home-category-card:not(.home-category-card--all)")];
    const visibleCards = cards.filter((card) => getComputedStyle(card).display !== "none");
    const explore = grid.querySelector<HTMLElement>(".home-category-card--all");
    const gridRect = grid.getBoundingClientRect();
    const exploreRect = explore?.getBoundingClientRect();
    return {
      display: getComputedStyle(grid).display,
      columns: getComputedStyle(grid).gridTemplateColumns.split(" ").filter(Boolean).length,
      visibleCards: visibleCards.length,
      scrollWidth: grid.scrollWidth,
      clientWidth: grid.clientWidth,
      exploreWidth: exploreRect?.width ?? 0,
      gridWidth: gridRect.width,
    };
  });
  assert.equal(layout.display, "grid", `Homepage categories should use a grid at ${width}px.`);
  assert.equal(layout.columns, 2, `Homepage categories should use two columns at ${width}px.`);
  assert.equal(layout.visibleCards, 4, `Homepage categories should show four featured cards at ${width}px.`);
  assert.ok(Math.abs(layout.exploreWidth - layout.gridWidth) <= 2, `Explore categories should span both columns at ${width}px.`);
  assert.ok(layout.scrollWidth <= layout.clientWidth + 1, `Homepage categories should not scroll horizontally at ${width}px.`);
}

async function assertMobileCategoryAccordion(page: Page, width: number) {
  const triggers = page.locator(".category-accordion__trigger");
  assert.ok(await triggers.count() >= 2, `Categories should render at least two accordion rows at ${width}px.`);
  assert.equal(await triggers.first().getAttribute("aria-expanded"), "false", `Categories should start collapsed at ${width}px.`);
  await triggers.first().click();
  assert.equal(await triggers.first().getAttribute("aria-expanded"), "true", `The first category should expand at ${width}px.`);
  const firstPanelId = await triggers.first().getAttribute("aria-controls");
  assert.ok(firstPanelId, `The first category should reference its panel at ${width}px.`);
  assert.equal(await page.locator(`#${firstPanelId}`).getAttribute("hidden"), null, `The expanded category panel should be exposed at ${width}px.`);
  await triggers.nth(1).click();
  assert.equal(await triggers.first().getAttribute("aria-expanded"), "false", `Opening another category should close the first at ${width}px.`);
  assert.equal(await triggers.nth(1).getAttribute("aria-expanded"), "true", `The second category should expand at ${width}px.`);
  await triggers.nth(1).click();
  assert.equal(await triggers.nth(1).getAttribute("aria-expanded"), "false", `Tapping the open category should collapse it at ${width}px.`);
}

async function findFirstAddableProductRoute(page: Page) {
  await waitForCustomerPage(page, "/shop");
  const card = page.locator(".catalog-card").filter({
    has: page.locator('button[aria-label="Add to cart"]:enabled'),
  }).first();
  if (!(await card.count())) return null;
  return card.locator('a[href^="/products/"]').first().getAttribute("href");
}

async function assertProductAddSuccess(page: Page, route: string, width: number) {
  await waitForCustomerPage(page, route);
  const addButton = page.locator(".purchase-panel .purchase-button");
  assert.equal(await addButton.isEnabled(), true, `${route} should have an addable product fixture at ${width}px.`);
  const increaseButton = page.getByRole("button", { name: "Increase quantity" });
  if (await increaseButton.isEnabled().catch(() => false)) await increaseButton.click();
  const quantity = (await page.getByLabel("Selected quantity").textContent())?.trim() ?? "1";
  await addButton.click();
  const banner = page.locator(".cart-add-success");
  await banner.waitFor({ state: "visible" });
  const text = (await banner.textContent())?.replace(/\s+/g, " ").trim() ?? "";
  assert.match(text, /^Added to cart/, `The success banner should use concise customer copy at ${width}px.`);
  assert.match(text, new RegExp(`${quantity} ×`), `The success banner should snapshot the added quantity at ${width}px.`);
  assert.doesNotMatch(text, /\bDEMO[-\s]/i, `The success banner should not expose demo prefixes at ${width}px.`);
  assert.equal(await banner.getByRole("link", { name: /View cart/ }).count(), 1, `The success banner should include its cart action at ${width}px.`);
  const dimensions = await banner.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const bottomNav = document.querySelector(".mobile-bottom-nav")?.getBoundingClientRect();
    return {
      left: rect.left,
      right: rect.right,
      top: rect.top,
      bottom: rect.bottom,
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      bottomNavTop: bottomNav?.top ?? null,
      bottomNavBottom: bottomNav?.bottom ?? null,
    };
  });
  assert.ok(dimensions.left >= -1 && dimensions.right <= width + 1, `The success banner should stay within the viewport at ${width}px.`);
  assert.ok(dimensions.scrollWidth <= dimensions.clientWidth + 1, `The success banner should not overflow internally at ${width}px.`);
  if (dimensions.bottomNavTop !== null && dimensions.bottomNavBottom !== null) {
    const overlapsBottomNav = dimensions.top < dimensions.bottomNavBottom && dimensions.bottom > dimensions.bottomNavTop;
    assert.equal(overlapsBottomNav, false, `The success banner should not overlap the fixed bottom navigation at ${width}px.`);
  }
}

async function assertMobilePurchaseCTA(page: Page, route: string, width: number) {
  const stickyCTA = page.locator(".product-mobile-sticky");
  const count = await stickyCTA.count();
  assert.equal(count, 1, `${route} should render exactly one mobile purchase CTA at ${width}px.`);
  assert.equal(await stickyCTA.isVisible(), true, `${route} should show the mobile purchase CTA at ${width}px.`);
}

async function assertCompactQuantityControl(page: Page, route: string, width: number) {
  const quantity = page.locator(".quantity-control > div");
  assert.equal(await quantity.count(), 1, `${route} should render one quantity control at ${width}px.`);
  const dimensions = await quantity.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { width: rect.width, height: rect.height };
  });
  assert.ok(dimensions.width <= 140, `${route} quantity control should stay compact at ${width}px.`);
  assert.ok(dimensions.height >= 44, `${route} quantity controls should retain touch sizing at ${width}px.`);
}

async function findFirstProductRoute(page: Page) {
  await waitForCustomerPage(page, "/shop");
  const productLink = page.locator('a[href^="/products/"]').first();
  if (!(await productLink.count())) return null;
  return productLink.getAttribute("href");
}

async function runPortraitPass(browser: Browser) {
  const report: LayoutMetrics[] = [];
  let productRoute: string | null = null;

  for (const [viewportIndex, width] of portraitWidths.entries()) {
    const context = await browser.newContext({
      baseURL,
      viewport: { width, height: width === 768 ? 1024 : 844 },
      extraHTTPHeaders: { "x-forwarded-for": `198.51.${testIpSubnet}.${20 + viewportIndex}` },
    });
    const page = await context.newPage();
    const rateLimitedResponses: string[] = [];
    page.on("response", (response) => {
      if (response.status() === 429) rateLimitedResponses.push(response.url());
    });

    const routes = width === 390 ? customerRoutes : ["/", ...([375, 430].includes(width) ? ["/checkout"] : [])];
    for (const [routeIndex, route] of routes.entries()) {
      await page.setExtraHTTPHeaders({
        "x-forwarded-for": `198.51.${testIpSubnet}.${60 + viewportIndex * 20 + routeIndex}`,
      });
      await waitForCustomerPage(page, route);
      assert.deepEqual(rateLimitedResponses, [], `The mobile smoke test was rate limited while checking ${route}.`);
      const metrics = await layoutMetrics(page);
      assertNoPageOverflow(metrics);
      report.push(metrics);

      if (route === "/" && width <= 768) {
        await assertCompactUtilityBar(page, width);
        await assertFooterLiveChat(page, width);
        await assertCompleteAppArtwork(page, width);
      }
      if (route === "/" && width <= 720) {
        await assertMobileHomepageCategoryGrid(page, width);
      }
      if (route === "/categories" && width <= 720) {
        await assertMobileCategoryAccordion(page, width);
      }
      if (width <= 768 && (route === "/categories" || (route === "/" && width > 680))) {
        await assertTwoColumnGrid(page, ".home-category-grid, .category-strip, .category-directory", route, width);
      }
      if (route === "/" && width <= 768) {
        await assertTwoColumnGrid(page, ".home-product-grid", route, width);
      }
      if (route === "/cart" && width <= 768) {
        await assertCouponLayout(page, width);
      }
      if (route === "/checkout" && [375, 390, 430].includes(width)) {
        await assertCheckoutPhoneSelector(page, width);
      }
    }

    if ([375, 390, 430].includes(width)) {
      await page.route("**/api/v1/catalog/categories", (route) => route.fulfill({ json: { data: [] } }));
      await page.route("**/api/v1/catalog/brands", (route) => route.fulfill({ json: { data: [] } }));
      await page.route("**/api/v1/catalog/products?*", (route) => route.fulfill({
        json: { data: { items: [], meta: { page: 1, pageSize: 12, total: 0, hasNext: false } } },
      }));
      for (const [categoryIndex, route] of referenceCategoryRoutes.entries()) {
        await page.setExtraHTTPHeaders({
          "x-forwarded-for": `198.51.${testIpSubnet}.${100 + viewportIndex * 10 + categoryIndex}`,
        });
        await waitForCustomerPage(page, route);
        const metrics = await layoutMetrics(page);
        assertNoPageOverflow(metrics);
        await assertUnavailableCategoryEmptyState(page, route, width);
        report.push(metrics);
        if (width === 390) {
          await page.locator(".catalog-results .storefront-state").screenshot({
            path: `${screenshotDir}/category-empty-${route.split("/").at(-1)}-${width}.png`,
          });
        }
      }
      await page.unroute("**/api/v1/catalog/categories");
      await page.unroute("**/api/v1/catalog/brands");
      await page.unroute("**/api/v1/catalog/products?*");

      await page.setExtraHTTPHeaders({
        "x-forwarded-for": `198.51.${testIpSubnet}.${170 + viewportIndex}`,
      });
      const addableProductRoute = await findFirstAddableProductRoute(page);
      if (addableProductRoute) {
        await page.setExtraHTTPHeaders({
          "x-forwarded-for": `198.51.${testIpSubnet}.${180 + viewportIndex}`,
        });
        await assertProductAddSuccess(page, addableProductRoute, width);
        const metrics = await layoutMetrics(page);
        assertNoPageOverflow(metrics);
        report.push(metrics);
      }
    }

    if (width === 390) {
      await page.setExtraHTTPHeaders({ "x-forwarded-for": `198.51.${testIpSubnet}.220` });
      productRoute = await findFirstProductRoute(page);
    }
    if (productRoute && width === 390) {
      await page.setExtraHTTPHeaders({ "x-forwarded-for": `198.51.${testIpSubnet}.221` });
      await waitForCustomerPage(page, productRoute);
      const metrics = await layoutMetrics(page);
      assertNoPageOverflow(metrics);
      await assertCompactQuantityControl(page, productRoute, width);
      await assertMobilePurchaseCTA(page, productRoute, width);
      report.push(metrics);
    }

    if (width === 360 || width === 390 || width === 430 || width === 768) {
      await page.setExtraHTTPHeaders({ "x-forwarded-for": `198.51.${testIpSubnet}.${230 + viewportIndex}` });
      await waitForCustomerPage(page, "/");
      const rejectConsent = page.getByRole("button", { name: "Reject non-essential" });
      if (await rejectConsent.isVisible().catch(() => false)) {
        await rejectConsent.click();
        await page.waitForTimeout(50);
      }
      await page.screenshot({ path: `${screenshotDir}/home-${width}.png`, fullPage: true });
    }

    assert.deepEqual(rateLimitedResponses, [], `The mobile smoke test was rate limited at ${width}px.`);
    await context.close();
  }

  return { report, productRoute };
}

async function runDesktopCheckoutPass(browser: Browser) {
  const width = 1280;
  const context = await browser.newContext({
    baseURL,
    viewport: { width, height: 900 },
    extraHTTPHeaders: { "x-forwarded-for": `198.51.${testIpSubnet}.239` },
  });
  const page = await context.newPage();
  await waitForCustomerPage(page, "/checkout");
  const metrics = await layoutMetrics(page);
  assertNoPageOverflow(metrics);
  await assertCheckoutPhoneSelector(page, width);
  await context.close();
  return metrics;
}

async function runDesktopStorefrontVisualPass(browser: Browser) {
  const width = 1280;
  const context = await browser.newContext({
    baseURL,
    viewport: { width, height: 900 },
    extraHTTPHeaders: { "x-forwarded-for": `198.51.${testIpSubnet}.240` },
  });
  const page = await context.newPage();
  const report: LayoutMetrics[] = [];
  await page.route("**/api/v1/catalog/categories", (route) => route.fulfill({ json: { data: [] } }));
  await page.route("**/api/v1/catalog/brands", (route) => route.fulfill({ json: { data: [] } }));
  await page.route("**/api/v1/catalog/products?*", (route) => route.fulfill({
    json: { data: { items: [], meta: { page: 1, pageSize: 12, total: 0, hasNext: false } } },
  }));
  for (const [index, route] of referenceCategoryRoutes.entries()) {
    await page.setExtraHTTPHeaders({ "x-forwarded-for": `198.51.${testIpSubnet}.${241 + index}` });
    await waitForCustomerPage(page, route);
    const metrics = await layoutMetrics(page);
    assertNoPageOverflow(metrics);
    await assertUnavailableCategoryEmptyState(page, route, width);
    report.push(metrics);
  }
  await page.unroute("**/api/v1/catalog/categories");
  await page.unroute("**/api/v1/catalog/brands");
  await page.unroute("**/api/v1/catalog/products?*");
  await page.setExtraHTTPHeaders({ "x-forwarded-for": `198.51.${testIpSubnet}.246` });
  const addableProductRoute = await findFirstAddableProductRoute(page);
  if (addableProductRoute) {
    await page.setExtraHTTPHeaders({ "x-forwarded-for": `198.51.${testIpSubnet}.247` });
    await assertProductAddSuccess(page, addableProductRoute, width);
    const metrics = await layoutMetrics(page);
    assertNoPageOverflow(metrics);
    report.push(metrics);
  }
  await context.close();
  return report;
}

async function runLandscapePass(browser: Browser) {
  const report: LayoutMetrics[] = [];
  for (const [viewportIndex, viewport] of landscapeViewports.entries()) {
    const context = await browser.newContext({
      baseURL,
      viewport: { width: viewport.width, height: viewport.height },
      extraHTTPHeaders: { "x-forwarded-for": `198.51.${testIpSubnet}.${40 + viewportIndex}` },
    });
    const page = await context.newPage();
    const rateLimitedResponses: string[] = [];
    page.on("response", (response) => {
      if (response.status() === 429) rateLimitedResponses.push(response.url());
    });
    const route = viewport.name === "landscape-checkout" ? "/checkout" : "/";
    await waitForCustomerPage(page, route);
    assert.deepEqual(rateLimitedResponses, [], `The mobile smoke test was rate limited at ${viewport.width}x${viewport.height}.`);
    const metrics = await layoutMetrics(page);
    assertNoPageOverflow(metrics);
    report.push(metrics);
    await page.screenshot({
      path: `${screenshotDir}/${viewport.name}-${viewport.width}x${viewport.height}.png`,
      fullPage: true,
    });
    await context.close();
  }
  return report;
}

async function main() {
  await mkdir(screenshotDir, { recursive: true });
  const browser = await chromium.launch({
    executablePath: chromiumPath(),
    headless: true,
    args: ["--no-sandbox"],
  });

  try {
    const portrait = await runPortraitPass(browser);
    const landscape = await runLandscapePass(browser);
    const desktopCheckout = await runDesktopCheckoutPass(browser);
    const desktopStorefront = await runDesktopStorefrontVisualPass(browser);
    const report = [...portrait.report, ...landscape, desktopCheckout, ...desktopStorefront];
    await writeFile(`${screenshotDir}/overflow-report.json`, JSON.stringify(report, null, 2));
    console.log(
      `Mobile responsive smoke passed: ${report.length} route/view checks, ` +
      `${portrait.productRoute ? `product CTA verified at ${portrait.productRoute}` : "no published product fixture available"}, ` +
      `${report.length ? "overflow report and screenshots retained" : "no evidence generated"}.`,
    );
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});