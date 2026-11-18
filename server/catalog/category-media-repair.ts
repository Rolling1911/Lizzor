import { getDatabasePool } from "../db/client.js";
import { bundledCategoryImages } from "./category-media.js";

export async function repairBundledCategoryMediaReferences(): Promise<number> {
  const entries = Object.entries(bundledCategoryImages);
  const result = await getDatabasePool().query(
    `UPDATE categories AS c
     SET image_url = media.image_url, updated_at = now()
     FROM unnest($1::text[], $2::text[]) AS media(slug, image_url)
     WHERE c.slug = media.slug
       AND (c.image_url IS NULL OR btrim(c.image_url) = '')`,
    [entries.map(([slug]) => slug), entries.map(([, imageUrl]) => imageUrl)],
  );
  return result.rowCount ?? 0;
}