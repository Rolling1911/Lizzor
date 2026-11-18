import assert from "node:assert/strict";
import { responsiveBannerSources } from "./bannerPresentation";

const fallback = "/built-in-artwork.png";

assert.deepEqual(
  responsiveBannerSources("/managed-desktop.png", "/managed-mobile.png", fallback),
  { desktopUrl: "/managed-desktop.png", mobileUrl: "/managed-mobile.png" },
);
assert.deepEqual(
  responsiveBannerSources("/managed-desktop.png", null, fallback),
  { desktopUrl: "/managed-desktop.png", mobileUrl: fallback },
  "desktop artwork must not be substituted into the mobile viewport",
);
assert.deepEqual(
  responsiveBannerSources(null, "/managed-mobile.png", fallback),
  { desktopUrl: fallback, mobileUrl: "/managed-mobile.png" },
  "mobile artwork must not be substituted into the desktop viewport",
);
assert.deepEqual(
  responsiveBannerSources(null, null, fallback),
  { desktopUrl: fallback, mobileUrl: fallback },
);

console.info("Responsive banner presentation checks passed.");