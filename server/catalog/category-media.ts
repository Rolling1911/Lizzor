export const bundledCategoryImages: Readonly<Record<string, string>> = {
  "demo-electronics": "/catalog-media/category-electronics.png",
  "demo-home-kitchen": "/catalog-media/category-home-kitchen.png",
  "demo-beauty-care": "/catalog-media/category-beauty.png",
  "demo-travel-accessories": "/catalog-media/category-travel.png",
  "demo-office-essentials": "/catalog-media/category-office.png",
};

export function resolveCategoryImageUrl(slug: string, imageUrl: unknown): string | null {
  if (typeof imageUrl === "string" && imageUrl.trim()) return imageUrl;
  return bundledCategoryImages[slug] ?? null;
}