export interface Category {
  id: string;
  parentId: string | null;
  name: string;
  slug: string;
  canonicalKey?: string | null;
  description: string | null;
  seoTitle?: string | null;
  seoDescription?: string | null;
  imageUrl: string | null;
  sortOrder: number;
  active: boolean;
  productCount: number;
  /** Count assigned directly to this node, supplied by the catalog API. */
  directProductCount?: number;
  /** Count assigned to this node or any descendant, supplied by the catalog API. */
  descendantProductCount?: number;
  childCount: number;
  protectedDependencyCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface Brand {
  id: string;
  name: string;
  slug: string;
  logoUrl: string | null;
  description: string | null;
  seoTitle?: string | null;
  seoDescription?: string | null;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ProductVariant {
  id?: string;
  sku: string;
  barcode: string | null;
  title: string;
  costPrice: number | null;
  basePrice: number | null;
  weight: number | null;
  minimumOrderQuantity: number;
  active: boolean;
  optionValues: Array<{ attribute: string; value: string }>;
}

export interface ProductMedia {
  id: string;
  variantId: string | null;
  type: "image" | "video";
  url: string;
  altText: string | null;
  isPrimary: boolean;
  sortOrder: number;
  createdAt: string;
}

export interface ProductSummary {
  id: string;
  name: string;
  slug: string;
  parentSku: string;
  barcode: string | null;
  brand: { id: string; name: string } | null;
  category: { id: string; name: string };
  status: "draft" | "active" | "inactive" | "archived";
  costPrice?: number;
  basePrice: number;
  vatRate: number;
  taxMode: "inclusive" | "exclusive";
  vatClassifiedAt?: string | null;
  isToonies?: boolean;
  weight: number;
  minimumOrderQuantity: number;
  featured: boolean;
  homepageWholesale: boolean;
  hasActiveWholesaleTier: boolean;
  newArrival: boolean;
  published: boolean;
  variantCount: number;
  thumbnailUrl: string | null;
  updatedAt: string;
}

export interface ProductDetail extends ProductSummary {
  shortDescription: string | null;
  description: string;
  seoTitle?: string | null;
  seoDescription?: string | null;
  dimensions: { width: number | null; height: number | null; length: number | null };
  variants: ProductVariant[];
  media: ProductMedia[];
}

export interface CatalogLookups {
  categories: Category[];
  brands: Brand[];
}

export function slugify(value: string): string {
  return value.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}