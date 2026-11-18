import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import ExcelJS from "exceljs";
import type { ProductInput } from "./validation.js";

export interface ImportVariant {
  sku: string;
  barcode: string | null;
  title: string;
  costPrice: number | null;
  basePrice: number | null;
  weight: number | null;
  minimumOrderQuantity?: number;
  active: boolean;
  optionValues: Array<{ attribute: string; value: string }>;
}

export interface ImportProduct {
  sourceRows: number[];
  name: string;
  slug: string;
  parentSku: string;
  barcode: string | null;
  brandName: string | null;
  categoryName: string;
  shortDescription: string | null;
  description: string;
  status: "draft" | "active" | "inactive" | "archived";
  costPrice: number;
  basePrice: number;
  vatRate: number;
  weight: number;
  minimumOrderQuantity?: number;
  width: number | null;
  height: number | null;
  length: number | null;
  featured: boolean;
  newArrival: boolean;
  options: Array<{ name: string; values: string[] }>;
  variants: ImportVariant[];
}

export interface ImportError {
  row: number;
  field: string;
  message: string;
}

interface PreviewRecord {
  createdAt: number;
  products: ImportProduct[];
  errors: ImportError[];
  unresolvedBrands: string[];
  unresolvedCategories: string[];
}

const previews = new Map<string, PreviewRecord>();
const maxImportRows = 5_000;

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function headerKey(value: unknown): string {
  return clean(value).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}

function firstValue(row: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = clean(row[key]);
    if (value) return value;
  }
  return "";
}

function optionalNumber(value: string, row: number, field: string, errors: ImportError[]): number | null {
  if (!value) return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    errors.push({ row, field, message: "Must be a non-negative number." });
    return null;
  }
  return number;
}

function requiredNumber(value: string, row: number, field: string, errors: ImportError[]): number {
  const number = optionalNumber(value, row, field, errors);
  if (number === null) errors.push({ row, field, message: "A value is required." });
  return number ?? 0;
}

function booleanValue(value: string, defaultValue = false): boolean {
  if (!value) return defaultValue;
  return ["true", "1", "yes", "y", "on", "active"].includes(value.toLowerCase());
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 280);
}

function rowToProduct(row: Record<string, unknown>, rowNumber: number, errors: ImportError[]): ImportProduct {
  const name = firstValue(row, ["product_name", "name"]);
  const parentSku = firstValue(row, ["parent_sku", "sku"]);
  const rawStatus = firstValue(row, ["status"]) || "draft";
  const status = ["draft", "active", "inactive", "archived"].includes(rawStatus) ? rawStatus as ImportProduct["status"] : "draft";
  if (!name) errors.push({ row: rowNumber, field: "product_name", message: "Product name is required." });
  if (!parentSku) errors.push({ row: rowNumber, field: "parent_sku", message: "Parent SKU is required." });
  if (!firstValue(row, ["category", "category_name", "category_path"])) errors.push({ row: rowNumber, field: "category", message: "Category is required and must match an existing category." });
  if (rawStatus !== status) errors.push({ row: rowNumber, field: "status", message: "Status must be draft, active, inactive, or archived." });

  const optionValues = new Map<string, Set<string>>();
  for (const [key, raw] of Object.entries(row)) {
    if (!key.startsWith("option_")) continue;
    const value = clean(raw);
    if (!value) continue;
    const attribute = key.slice("option_".length).replace(/_/g, " ").trim();
    if (!attribute) continue;
    const values = optionValues.get(attribute) ?? new Set<string>();
    values.add(value);
    optionValues.set(attribute, values);
  }
  const variantSku = firstValue(row, ["variant_sku", "variant_parent_sku"]);
  const variants: ImportVariant[] = [];
  if (variantSku) {
    variants.push({
      sku: variantSku,
      barcode: firstValue(row, ["variant_barcode"]) || null,
      title: firstValue(row, ["variant_title"]) || variantSku,
      costPrice: optionalNumber(firstValue(row, ["variant_cost_price"]), rowNumber, "variant_cost_price", errors),
      basePrice: optionalNumber(firstValue(row, ["variant_base_price"]), rowNumber, "variant_base_price", errors),
      weight: optionalNumber(firstValue(row, ["variant_weight"]), rowNumber, "variant_weight", errors),
      active: booleanValue(firstValue(row, ["variant_active"]), true),
      optionValues: [...optionValues].map(([attribute, values]) => ({ attribute, value: [...values][0]! })),
    });
  }

  return {
    sourceRows: [rowNumber],
    name,
    slug: firstValue(row, ["slug"]) || slug(name),
    parentSku,
    barcode: firstValue(row, ["barcode"]) || null,
    brandName: firstValue(row, ["brand", "brand_name"]) || null,
    categoryName: firstValue(row, ["category", "category_name", "category_path"]),
    shortDescription: firstValue(row, ["short_description"]) || null,
    description: firstValue(row, ["description", "full_description"]) || name,
    status,
    costPrice: requiredNumber(firstValue(row, ["cost_price"]), rowNumber, "cost_price", errors),
    basePrice: requiredNumber(firstValue(row, ["base_price", "selling_price"]), rowNumber, "base_price", errors),
    vatRate: requiredNumber(firstValue(row, ["vat_rate", "vat"]), rowNumber, "vat_rate", errors),
    weight: requiredNumber(firstValue(row, ["weight"]), rowNumber, "weight", errors),
    width: optionalNumber(firstValue(row, ["width"]), rowNumber, "width", errors),
    height: optionalNumber(firstValue(row, ["height"]), rowNumber, "height", errors),
    length: optionalNumber(firstValue(row, ["length"]), rowNumber, "length", errors),
    featured: booleanValue(firstValue(row, ["featured"])),
    newArrival: booleanValue(firstValue(row, ["new_arrival", "newarrival"])),
    options: [...optionValues].map(([name, values]) => ({ name, values: [...values] })),
    variants,
  };
}

function mergeProduct(target: ImportProduct, source: ImportProduct, rowNumber: number, errors: ImportError[]): void {
  target.sourceRows.push(rowNumber);
  if (source.name && source.name !== target.name) errors.push({ row: rowNumber, field: "product_name", message: "Repeated parent SKU has conflicting product names." });
  if (source.categoryName && source.categoryName !== target.categoryName) errors.push({ row: rowNumber, field: "category", message: "Repeated parent SKU has conflicting categories." });
  if (source.brandName && source.brandName !== target.brandName) errors.push({ row: rowNumber, field: "brand", message: "Repeated parent SKU has conflicting brands." });
  target.variants.push(...source.variants);
  for (const option of source.options) {
    const existing = target.options.find((item) => item.name.toLowerCase() === option.name.toLowerCase());
    if (!existing) target.options.push({ name: option.name, values: [...option.values] });
    else existing.values = [...new Set([...existing.values, ...option.values])];
  }
}

function cellValue(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const record = value as { result?: unknown; text?: unknown; richText?: Array<{ text?: string }> };
  if (record.result !== undefined) return record.result;
  if (record.text !== undefined) return record.text;
  if (record.richText) return record.richText.map((part) => part.text ?? "").join("");
  return value;
}

export async function parseCatalogFile(buffer: Buffer, filename: string): Promise<{ products: ImportProduct[]; errors: ImportError[] }> {
  const extension = filename.toLowerCase().split(".").pop();
  if (!["csv", "xlsx"].includes(extension ?? "")) throw new Error("Only CSV and XLSX files are supported.");
  const workbook = new ExcelJS.Workbook();
  if (extension === "csv") await workbook.csv.read(Readable.from([buffer]));
  else await workbook.xlsx.load(Buffer.from(buffer) as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  const sheet = workbook.worksheets[0];
  if (!sheet) throw new Error("The import file does not contain a worksheet.");
  const headerRow = sheet.getRow(1);
  const headers = Array.from({ length: headerRow.cellCount }, (_, index) => headerKey(cellValue(headerRow.getCell(index + 1).value)));
  const rawRows: Array<Record<string, unknown>> = [];
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const record: Record<string, unknown> = {};
    headers.forEach((header, index) => {
      if (header) record[header] = cellValue(row.getCell(index + 1).value);
    });
    if (Object.values(record).some((value) => clean(value))) rawRows.push(record);
  });
  if (rawRows.length > maxImportRows) throw new Error(`Import files are limited to ${maxImportRows.toLocaleString()} data rows.`);
  const errors: ImportError[] = [];
  const products = new Map<string, ImportProduct>();
  rawRows.forEach((rawRow, index) => {
    const row: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(rawRow)) row[headerKey(key)] = value;
    const rowNumber = index + 2;
    const product = rowToProduct(row, rowNumber, errors);
    if (!product.parentSku) return;
    const existing = products.get(product.parentSku.toLowerCase());
    if (existing) mergeProduct(existing, product, rowNumber, errors);
    else products.set(product.parentSku.toLowerCase(), product);
  });
  const seenVariantSkus = new Set<string>();
  for (const product of products.values()) {
    for (const variant of product.variants) {
      const key = variant.sku.toLowerCase();
      if (seenVariantSkus.has(key)) errors.push({ row: product.sourceRows[0]!, field: "variant_sku", message: `Variant SKU ${variant.sku} is repeated in the import.` });
      seenVariantSkus.add(key);
    }
  }
  return { products: [...products.values()], errors };
}

export function storePreview(record: Omit<PreviewRecord, "createdAt">): string {
  const id = randomUUID();
  previews.set(id, { ...record, createdAt: Date.now() });
  return id;
}

export function getPreview(id: string): PreviewRecord | undefined {
  const record = previews.get(id);
  if (!record) return undefined;
  if (Date.now() - record.createdAt > 15 * 60 * 1000) {
    previews.delete(id);
    return undefined;
  }
  return record;
}

export function removePreview(id: string): void {
  previews.delete(id);
}

export function previewSummary(products: ImportProduct[]): Array<Pick<ImportProduct, "sourceRows" | "name" | "parentSku" | "brandName" | "categoryName" | "variants">> {
  return products.map(({ sourceRows, name, parentSku, brandName, categoryName, variants }) => ({ sourceRows, name, parentSku, brandName, categoryName, variants }));
}

export type ImportableProduct = ImportProduct & { categoryId: string; brandId: string | null };

export function toProductInput(product: ImportableProduct): ProductInput {
  return {
    name: product.name,
    slug: product.slug,
    seoTitle: null,
    seoDescription: null,
    parentSku: product.parentSku,
    barcode: product.barcode,
    brandId: product.brandId,
    categoryId: product.categoryId,
    shortDescription: product.shortDescription,
    description: product.description,
    status: product.status,
    costPrice: product.costPrice,
    basePrice: product.basePrice,
    vatRate: product.vatRate,
    taxMode: "inclusive",
    weight: product.weight,
    minimumOrderQuantity: product.minimumOrderQuantity ?? 1,
    width: product.width,
    height: product.height,
    length: product.length,
    featured: product.featured,
    newArrival: product.newArrival,
    homepageWholesale: false,
    options: product.options,
    variants: product.variants.map((variant) => ({ ...variant, minimumOrderQuantity: variant.minimumOrderQuantity ?? 1 })),
  };
}