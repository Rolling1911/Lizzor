import { z } from "zod";

const nullableText = (max: number) => z.string().trim().max(max).nullable().optional().transform((value) => value || null);
const nonNegativeNumber = z.coerce.number().finite().min(0);
const optionalNonNegativeNumber = z.coerce.number().finite().min(0).nullable().optional();

export const optionValueSchema = z.object({
  attribute: z.string().trim().min(1).max(100),
  value: z.string().trim().min(1).max(150),
});

export const variantInputSchema = z.object({
  id: z.string().uuid().optional(),
  sku: z.string().trim().min(1).max(100),
  barcode: nullableText(100),
  title: z.string().trim().min(1).max(200),
  costPrice: optionalNonNegativeNumber,
  basePrice: optionalNonNegativeNumber,
  weight: optionalNonNegativeNumber,
  minimumOrderQuantity: z.coerce.number().int().min(1).default(1),
  active: z.boolean().default(true),
  optionValues: z.array(optionValueSchema).max(20).default([]),
});

export const productInputSchema = z.object({
  name: z.string().trim().min(1).max(250),
  slug: z.string().trim().min(1).max(280).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Use lowercase letters, numbers, and hyphens for slugs."),
  seoTitle: nullableText(70),
  seoDescription: nullableText(170),
  parentSku: z.string().trim().min(1).max(100),
  barcode: nullableText(100),
  brandId: z.string().uuid().nullable().optional().transform((value) => value || null),
  categoryId: z.string().uuid(),
  shortDescription: nullableText(1000),
  description: z.string().trim().min(1),
  status: z.enum(["draft", "active", "inactive", "archived"]).default("draft"),
  costPrice: nonNegativeNumber,
  basePrice: nonNegativeNumber,
  vatRate: z.coerce.number().finite().min(0).max(100),
  taxMode: z.enum(["inclusive", "exclusive"]).default("inclusive"),
  weight: nonNegativeNumber,
  minimumOrderQuantity: z.coerce.number().int().min(1).default(1),
  width: optionalNonNegativeNumber,
  height: optionalNonNegativeNumber,
  length: optionalNonNegativeNumber,
  featured: z.boolean().default(false),
  newArrival: z.boolean().default(false),
  homepageWholesale: z.boolean().default(false),
  options: z.array(z.object({
    name: z.string().trim().min(1).max(100),
    values: z.array(z.string().trim().min(1).max(150)).min(1).max(100),
  })).max(20).default([]),
  variants: z.array(variantInputSchema).max(500).default([]),
});

export const categoryInputSchema = z.object({
  name: z.string().trim().min(1).max(150),
  slug: z.string().trim().min(1).max(180).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  canonicalKey: z.string().trim().min(1).max(220).regex(/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/).nullable().optional(),
  seoTitle: nullableText(70),
  seoDescription: nullableText(170),
  parentId: z.string().uuid().nullable().optional().transform((value) => value || null),
  description: nullableText(2000),
  imageUrl: nullableText(2000),
  sortOrder: z.coerce.number().int().min(0).max(1_000_000).default(0),
  active: z.boolean().default(true),
});

const mappingPatchFields = {
  rootCategoryId: z.string().uuid().nullable().optional(),
  childCategoryId: z.string().uuid().nullable().optional(),
  status: z.enum(["mapped", "unmapped", "ignored", "needs_review"]).optional(),
  publicationEnabled: z.boolean().optional(),
  complianceExcluded: z.boolean().optional(),
  reason: z.string().trim().max(1000).nullable().optional(),
};

export const supplierCategoryMappingUpdateSchema = z.object(mappingPatchFields).strict().refine(
  (value) => Object.keys(value).length > 0,
  "At least one mapping field is required.",
);

export const supplierCategoryMappingBulkSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(500),
  rootCategoryId: z.string().uuid().nullable().optional(),
  childCategoryId: z.string().uuid().nullable().optional(),
  status: z.enum(["mapped", "unmapped", "ignored", "needs_review"]).optional(),
  publicationEnabled: z.boolean().optional(),
  complianceExcluded: z.boolean().optional(),
  reason: z.string().trim().max(1000).nullable().optional(),
}).strict().refine(
  (value) => Object.keys(value).some((key) => key !== "ids"),
  "At least one mapping field is required.",
);

export const brandInputSchema = z.object({
  name: z.string().trim().min(1).max(150),
  slug: z.string().trim().min(1).max(180).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  seoTitle: nullableText(70),
  seoDescription: nullableText(170),
  logoUrl: nullableText(2000),
  description: nullableText(2000),
  active: z.boolean().default(true),
});

export const mediaInputSchema = z.object({
  productId: z.string().uuid(),
  variantId: z.string().uuid().nullable().optional().transform((value) => value || null),
  type: z.enum(["image", "video"]),
  url: z.string().trim().url().or(z.string().trim().regex(/^\/catalog-media\/[A-Za-z0-9._-]+$/)),
  altText: nullableText(500),
  isPrimary: z.boolean().default(false),
  sortOrder: z.coerce.number().int().min(0).max(1_000_000).default(0),
});

export const bulkActionSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(500),
  action: z.enum(["publish", "unpublish", "archive", "assign_category", "assign_brand", "feature", "unfeature", "new_arrival", "not_new_arrival"]),
  categoryId: z.string().uuid().optional(),
  brandId: z.string().uuid().nullable().optional(),
});

export type ProductInput = z.infer<typeof productInputSchema>;
export type CategoryInput = z.infer<typeof categoryInputSchema>;
export type BrandInput = z.infer<typeof brandInputSchema>;
export type VariantInput = z.infer<typeof variantInputSchema>;
export type SupplierCategoryMappingUpdate = z.infer<typeof supplierCategoryMappingUpdateSchema>;
export type SupplierCategoryMappingBulk = z.infer<typeof supplierCategoryMappingBulkSchema>;