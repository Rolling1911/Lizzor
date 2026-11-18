import { closeDatabase, getDatabasePool } from "./client.js";

const DEMO = "DEMO-";
const svg = (label: string, color: string) => `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 900"><rect width="1200" height="900" fill="${color}"/><circle cx="930" cy="180" r="240" fill="#ffffff" opacity=".14"/><circle cx="930" cy="180" r="145" fill="none" stroke="#fff" stroke-width="2" opacity=".35"/><text x="70" y="720" fill="#fff" font-family="Arial,sans-serif" font-size="54" font-weight="700">${label}</text><text x="73" y="780" fill="#fff" opacity=".7" font-family="Arial,sans-serif" font-size="20" letter-spacing="5">LIZZOR DEMO CATALOG</text></svg>`)}`;

type ProductSpec = {
  name: string; slug: string; sku: string; brand: string; category: string; short: string; description: string;
  price: number; cost: number; weight: number; featured?: boolean; newArrival?: boolean; image: string;
  variants?: Array<{ title: string; sku: string; price: number; cost: number; stock: number; option: string }>;
  stock?: number; lowStock?: number;
};

const categories = [
  ["DEMO-Electronics", "demo-electronics", "Smart tools and everyday tech for modern businesses.", 1, "/catalog-media/category-electronics.png"],
  ["DEMO-Home & Kitchen", "demo-home-kitchen", "Useful objects with a considered finish.", 2, "/catalog-media/category-home-kitchen.png"],
  ["DEMO-Beauty & Personal Care", "demo-beauty-care", "Practical self-care essentials for guest and retail spaces.", 3, "/catalog-media/category-beauty.png"],
  ["DEMO-Travel & Accessories", "demo-travel-accessories", "Reliable companions for the road.", 4, "/catalog-media/category-travel.png"],
  ["DEMO-Office Essentials", "demo-office-essentials", "Simple, dependable tools for productive teams.", 5, "/catalog-media/category-office.png"],
] as const;

const brands = [
  ["DEMO-Northline", "demo-northline", "Functional goods with a quiet, durable character."],
  ["DEMO-Aster & Co.", "demo-aster-co", "Thoughtful essentials for everyday rituals."],
  ["DEMO-Fieldhouse", "demo-fieldhouse", "Made for movement, travel, and flexible work."],
  ["DEMO-Common Form", "demo-common-form", "Clean forms for well-run spaces."],
] as const;

const products: ProductSpec[] = [
  { name: "DEMO-Arc USB-C Desk Hub", slug: "demo-arc-usbc-desk-hub", sku: "DEMO-ELEC-001", brand: "DEMO-Northline", category: "DEMO-Electronics", short: "A compact six-port hub for organized workstations.", description: "The Arc USB-C Desk Hub brings charging, display, and data connections into a single brushed enclosure. Designed for shared desks, meeting rooms, and mobile teams.", price: 34, cost: 16, weight: .28, featured: true, newArrival: true, image: svg("ARC DESK HUB", "#173f3a"), stock: 42 },
  { name: "DEMO-Tempo Wireless Presenter", slug: "demo-tempo-wireless-presenter", sku: "DEMO-ELEC-002", brand: "DEMO-Common Form", category: "DEMO-Electronics", short: "A presentation remote with tactile controls and USB-C charging.", description: "Tempo keeps presentations moving with a comfortable silhouette, clear feedback, and a dependable wireless range. It ships with a compact receiver and travel sleeve.", price: 22, cost: 9, weight: .12, image: svg("TEMPO PRESENTER", "#334b62"), stock: 18 },
  { name: "DEMO-Lumen Portable Speaker", slug: "demo-lumen-portable-speaker", sku: "DEMO-ELEC-003", brand: "DEMO-Fieldhouse", category: "DEMO-Electronics", short: "Warm, balanced sound in a shelf-friendly portable format.", description: "Lumen is a compact Bluetooth speaker for reception desks, boutique retail, and hospitality spaces. Its fabric-wrapped body and simple controls keep the experience understated.", price: 48, cost: 23, weight: .62, image: svg("LUMEN SPEAKER", "#76564b"), variants: [{ title: "Sand", sku: "DEMO-ELEC-003-SAND", price: 48, cost: 23, stock: 12, option: "Sand" }, { title: "Ink", sku: "DEMO-ELEC-003-INK", price: 48, cost: 23, stock: 0, option: "Ink" }] },
  { name: "DEMO-Slate Pour-Over Set", slug: "demo-slate-pour-over-set", sku: "DEMO-HOME-001", brand: "DEMO-Aster & Co.", category: "DEMO-Home & Kitchen", short: "A calm, complete coffee ritual for kitchens and guest spaces.", description: "Slate pairs a durable ceramic dripper with a matching server and measuring scoop. It is easy to merchandise as a set and built for repeat daily use.", price: 29, cost: 13, weight: .86, featured: true, image: svg("SLATE POUR-OVER", "#53624e"), variants: [{ title: "Graphite", sku: "DEMO-HOME-001-GRAPHITE", price: 29, cost: 13, stock: 24, option: "Graphite" }, { title: "Clay", sku: "DEMO-HOME-001-CLAY", price: 31, cost: 14, stock: 9, option: "Clay" }] },
  { name: "DEMO-Stack Linen Storage Bins", slug: "demo-stack-linen-storage-bins", sku: "DEMO-HOME-002", brand: "DEMO-Common Form", category: "DEMO-Home & Kitchen", short: "Fold-flat fabric bins that bring order to open shelving.", description: "Stack bins are sized for wardrobes, studios, and back-of-house organization. Reinforced handles make them easy to move while the neutral weave works across interiors.", price: 18, cost: 7, weight: .44, newArrival: true, image: svg("STACK BINS", "#a77d5e"), stock: 4, lowStock: 4 },
  { name: "DEMO-Ceramic Soap Tray", slug: "demo-ceramic-soap-tray", sku: "DEMO-HOME-003", brand: "DEMO-Aster & Co.", category: "DEMO-Home & Kitchen", short: "A small ridged tray for cleaner counters and vanities.", description: "The Ceramic Soap Tray keeps bars dry with a raised drainage pattern and a softly rounded edge. A thoughtful add-on for hospitality, gift, and home ranges.", price: 9, cost: 3.5, weight: .22, image: svg("SOAP TRAY", "#b6aa91"), stock: 27 },
  { name: "DEMO-Cedar Hand Care Duo", slug: "demo-cedar-hand-care-duo", sku: "DEMO-BEAUTY-001", brand: "DEMO-Aster & Co.", category: "DEMO-Beauty & Personal Care", short: "A gentle wash and lotion pairing with a warm cedar profile.", description: "Cedar is a simple two-piece hand care set for guest bathrooms, welcome hampers, and everyday retail. The balanced formula leaves hands clean and comfortable without an overpowering scent.", price: 16, cost: 6, weight: .48, featured: true, image: svg("CEDAR HAND CARE", "#8c684e"), stock: 31 },
  { name: "DEMO-Cloud Travel Towel", slug: "demo-cloud-travel-towel", sku: "DEMO-TRAVEL-001", brand: "DEMO-Fieldhouse", category: "DEMO-Travel & Accessories", short: "A quick-dry towel that packs down small.", description: "Cloud is made for gyms, beach bags, and travel kits. The lightweight weave dries quickly, folds into its own pouch, and stays soft through frequent washing.", price: 14, cost: 5, weight: .19, newArrival: true, image: svg("CLOUD TOWEL", "#4e7080"), variants: [{ title: "Small", sku: "DEMO-TRAVEL-001-SM", price: 14, cost: 5, stock: 16, option: "Small" }, { title: "Large", sku: "DEMO-TRAVEL-001-LG", price: 19, cost: 7, stock: 21, option: "Large" }] },
  { name: "DEMO-Transit Packing Cube Set", slug: "demo-transit-packing-cubes", sku: "DEMO-TRAVEL-002", brand: "DEMO-Fieldhouse", category: "DEMO-Travel & Accessories", short: "Three lightweight cubes for calmer packing and storage.", description: "Transit separates essentials without adding bulk. The set includes three graduated zip cubes with breathable panels and easy-grab pulls.", price: 26, cost: 11, weight: .36, image: svg("TRANSIT CUBES", "#42565a"), stock: 15 },
  { name: "DEMO-Grid Hardcover Notebook", slug: "demo-grid-hardcover-notebook", sku: "DEMO-OFFICE-001", brand: "DEMO-Northline", category: "DEMO-Office Essentials", short: "A durable grid notebook for plans, notes, and meeting capture.", description: "Grid has a lay-flat binding, numbered pages, and a hard cover that stands up to daily commuting. It is sized for desk drawers, welcome packs, and team stationery.", price: 12, cost: 4, weight: .31, featured: true, image: svg("GRID NOTEBOOK", "#252e32"), stock: 63 },
  { name: "DEMO-Form Desk Organizer", slug: "demo-form-desk-organizer", sku: "DEMO-OFFICE-002", brand: "DEMO-Common Form", category: "DEMO-Office Essentials", short: "A modular tray for the small tools that clutter a desk.", description: "Form combines a pen channel, catch-all tray, and cable notch in a single weighted organizer. The clean geometry works equally well in offices, studios, and reception areas.", price: 21, cost: 8, weight: .58, image: svg("FORM ORGANIZER", "#66756d"), variants: [{ title: "Ivory", sku: "DEMO-OFFICE-002-IVORY", price: 21, cost: 8, stock: 7, option: "Ivory" }, { title: "Moss", sku: "DEMO-OFFICE-002-MOSS", price: 21, cost: 8, stock: 11, option: "Moss" }] },
  { name: "DEMO-Loop Cable Clips", slug: "demo-loop-cable-clips", sku: "DEMO-OFFICE-003", brand: "DEMO-Northline", category: "DEMO-Office Essentials", short: "A five-piece set for keeping charging cables within reach.", description: "Loop clips use a reusable adhesive base and flexible silicone channel to keep cables tidy. A small, useful item for desks, bedside tables, and retail bundles.", price: 7, cost: 2, weight: .06, newArrival: true, image: svg("LOOP CLIPS", "#879a64"), stock: 38 },
];

async function removeDemo(client: { query: (sql: string, values?: unknown[]) => Promise<unknown> }) {
  await client.query(`DELETE FROM products WHERE parent_sku LIKE 'DEMO-%'`);
  await client.query(`DELETE FROM brands WHERE name LIKE 'DEMO-%'`);
  await client.query(`DELETE FROM categories WHERE name LIKE 'DEMO-%'`);
  await client.query(`DELETE FROM warehouses WHERE code LIKE 'DEMO-%'`);
}

async function seed(): Promise<void> {
  const pool = getDatabasePool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await removeDemo(client);
    const categoryIds = new Map<string, string>();
    for (const [name, slug, description, sortOrder, imageUrl] of categories) {
      const row = (await client.query<{ id: string }>(
        `INSERT INTO categories (name,slug,description,image_url,sort_order,active) VALUES ($1,$2,$3,$4,$5,true) RETURNING id`,
        [name, slug, description, imageUrl, sortOrder],
      )).rows[0]!;
      categoryIds.set(name, row.id);
    }
    const brandIds = new Map<string, string>();
    for (const [name, slug, description] of brands) {
      const row = (await client.query<{ id: string }>(
        `INSERT INTO brands (name,slug,description,active) VALUES ($1,$2,$3,true) RETURNING id`,
        [name, slug, description],
      )).rows[0]!;
      brandIds.set(name, row.id);
    }
    const warehouseId = (await client.query<{ id: string }>(
      `INSERT INTO warehouses (name,code,country_code,active) VALUES ('DEMO Visual QA Warehouse','DEMO-VQA','CY',true) RETURNING id`,
    )).rows[0]!.id;
    let variantCount = 0;
    for (const product of products) {
      const productId = (await client.query<{ id: string }>(
        `INSERT INTO products (name,slug,parent_sku,brand_id,category_id,short_description,description,status,cost_price,base_price,vat_rate,weight,width,height,length,featured,new_arrival,published_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'active',$8,$9,19,$10,20,12,8,$11,$12,now()) RETURNING id`,
        [product.name, product.slug, product.sku, brandIds.get(product.brand), categoryIds.get(product.category), product.short, product.description, product.cost, product.price, product.weight, product.featured ?? false, product.newArrival ?? false],
      )).rows[0]!.id;
      await client.query(`INSERT INTO product_media (product_id,type,url,alt_text,is_primary,sort_order) VALUES ($1,'image',$2,$3,true,0)`, [productId, product.image, `${product.name} demo image`]);
      const tiers = [[1, 9, product.price], [10, 24, Number((product.price * .9).toFixed(2))], [25, 49, Number((product.price * .82).toFixed(2))], [50, null, Number((product.price * .74).toFixed(2))]] as const;
      if (product.variants?.length) {
        for (const variant of product.variants) {
          const variantId = (await client.query<{ id: string }>(
            `INSERT INTO product_variants (product_id,sku,title,cost_price,base_price,weight,active) VALUES ($1,$2,$3,$4,$5,$6,true) RETURNING id`,
            [productId, variant.sku, variant.title, variant.cost, variant.price, product.weight],
          )).rows[0]!.id;
          await client.query(`INSERT INTO product_media (product_id,variant_id,type,url,alt_text,is_primary,sort_order) VALUES ($1,$2,'image',$3,$4,false,1)`, [productId, variantId, product.image, `${product.name} ${variant.title} demo image`]);
          await client.query(`INSERT INTO inventory (warehouse_id,variant_id,quantity_on_hand,low_stock_threshold) VALUES ($1,$2,$3,5)`, [warehouseId, variantId, variant.stock]);
          for (const [minQuantity, maxQuantity, unitPrice] of tiers) await client.query(`INSERT INTO price_tiers (variant_id,min_quantity,max_quantity,unit_price,active) VALUES ($1,$2,$3,$4,true)`, [variantId, minQuantity, maxQuantity, variant.price === product.price ? unitPrice : Number((variant.price * (unitPrice / product.price)).toFixed(2))]);
          variantCount++;
        }
      } else {
        await client.query(`INSERT INTO inventory (warehouse_id,product_id,quantity_on_hand,low_stock_threshold) VALUES ($1,$2,$3,$4)`, [warehouseId, productId, product.stock ?? 20, product.lowStock ?? 5]);
        for (const [minQuantity, maxQuantity, unitPrice] of tiers) await client.query(`INSERT INTO price_tiers (product_id,min_quantity,max_quantity,unit_price,active) VALUES ($1,$2,$3,$4,true)`, [productId, minQuantity, maxQuantity, unitPrice]);
      }
    }
    await client.query("COMMIT");
    console.info(`Demo catalog seeded: ${categories.length} categories, ${brands.length} brands, ${products.length} products, ${variantCount} variants.`);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

if (process.env.SEED_DEMO === "true") {
  seed().catch((error: unknown) => {
    console.error("Demo catalog seed failed.", error);
    process.exitCode = 1;
  }).finally(closeDatabase);
} else {
  getDatabasePool().query("select 1").then(() => {
    console.info("Seed completed: no business data is defined for the default seed.");
  }).catch((error: unknown) => {
    console.error("Database seed failed.", error);
    process.exitCode = 1;
  }).finally(closeDatabase);
}