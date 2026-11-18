const internalIdentifierPattern = /(?:\b\d{10,}\b|\b[0-9a-f]{12,}\b|\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b)/i;
const technicalSlugPattern = /^[a-z0-9]+(?:[-_][a-z0-9]+)+$/;
const categoryFallbackPattern = /^(?:category|catalog collection|uncategorized|unknown|unnamed|n\/a|null|undefined)$/i;

export function publicCategoryName(name: string): string | null {
  const normalized = name.trim().replace(/^DEMO[-\s]+/i, "").trim();
  if (
    !normalized
    || internalIdentifierPattern.test(normalized)
    || technicalSlugPattern.test(normalized)
    || categoryFallbackPattern.test(normalized)
  ) return null;
  return normalized;
}

export function publicCategories<T extends { name: string }>(categories: readonly T[]): Array<T & { publicName: string }> {
  return categories.flatMap((category) => {
    const publicName = publicCategoryName(category.name);
    return publicName ? [{ ...category, publicName }] : [];
  });
}

/** Return display-safe children without changing the server's category order. */
export function publicCategoryChildren<T extends { id: string; parentId?: string | null; name: string }>(
  categories: readonly T[],
  parentId: string,
): Array<T & { publicName: string }> {
  return publicCategories(categories.filter((category) => category.parentId === parentId));
}

export function publicProductName(name: string): string {
  const normalized = name.trim();
  if (/^payment product\s+\d{10,}(?:[-_][a-z0-9]+)+$/i.test(normalized) || internalIdentifierPattern.test(normalized)) return "Wholesale product";
  return normalized.replace(/^DEMO[-\s]+/i, "");
}

export function publicBrandName(name: string): string {
  return name.trim().replace(/^DEMO[-\s]+/i, "");
}

export function publicCategoryDescription(description?: string | null): string | null {
  if (!description) return null;
  const normalized = description.trim();
  return internalIdentifierPattern.test(normalized) ? null : normalized;
}