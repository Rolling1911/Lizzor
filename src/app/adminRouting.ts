export function canonicalAdminPath(pathname: string): string | null {
  if (!/^\/admin(?:\/|$)/i.test(pathname)) return null;
  return pathname.toLowerCase();
}