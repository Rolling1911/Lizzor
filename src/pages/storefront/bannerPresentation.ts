export function responsiveBannerSources(
  desktopUrl: string | null | undefined,
  mobileUrl: string | null | undefined,
  fallback: string,
): { desktopUrl: string; mobileUrl: string } {
  return {
    desktopUrl: desktopUrl || fallback,
    mobileUrl: mobileUrl || fallback,
  };
}