-- Canonical category identity and the generic supplier taxonomy boundary.
-- This migration is intentionally additive: products remain attached to the
-- existing category UUIDs and no supplier/product rows are created.
DO $enum$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname='supplier_category_mapping_status') THEN
    CREATE TYPE "supplier_category_mapping_status" AS ENUM ('mapped', 'unmapped', 'ignored', 'needs_review');
  END IF;
END;
$enum$;
--> statement-breakpoint
ALTER TABLE "categories" ADD COLUMN IF NOT EXISTS "canonical_key" varchar(220);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "categories_canonical_key_unique" ON "categories" ("canonical_key");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "categories_canonical_key_normalized_unique" ON "categories" (lower("canonical_key"));
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "categories_slug_normalized_unique" ON "categories" (lower("slug"));
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "suppliers" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" varchar(200) NOT NULL,
  "slug" varchar(180) NOT NULL,
  "active" boolean DEFAULT true NOT NULL,
  "publication_enabled" boolean DEFAULT false NOT NULL,
  "compliance_excluded" boolean DEFAULT true NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "suppliers_name_unique" UNIQUE ("name"),
  CONSTRAINT "suppliers_slug_unique" UNIQUE ("slug")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "suppliers_active_idx" ON "suppliers" ("active");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "supplier_category_mappings" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "supplier_id" uuid NOT NULL REFERENCES "suppliers"("id") ON DELETE CASCADE,
  "external_category_id" varchar(255) NOT NULL,
  "external_category_name" varchar(500) NOT NULL,
  "external_category_path" text,
  "root_category_id" uuid REFERENCES "categories"("id") ON DELETE RESTRICT,
  "child_category_id" uuid REFERENCES "categories"("id") ON DELETE RESTRICT,
  "status" "supplier_category_mapping_status" DEFAULT 'unmapped' NOT NULL,
  "publication_enabled" boolean DEFAULT false NOT NULL,
  "compliance_excluded" boolean DEFAULT true NOT NULL,
  "metadata" jsonb,
  "last_mapped_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "last_mapped_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "supplier_category_mappings_supplier_external_unique" UNIQUE ("supplier_id", "external_category_id"),
  CONSTRAINT "supplier_category_mappings_publication_safety_check" CHECK ("publication_enabled" = false OR "compliance_excluded" = false)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "supplier_category_mappings_supplier_status_idx" ON "supplier_category_mappings" ("supplier_id", "status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "supplier_category_mappings_root_idx" ON "supplier_category_mappings" ("root_category_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "supplier_category_mappings_child_idx" ON "supplier_category_mappings" ("child_category_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "supplier_category_mapping_history" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "mapping_id" uuid NOT NULL REFERENCES "supplier_category_mappings"("id") ON DELETE CASCADE,
  "action" varchar(40) NOT NULL,
  "previous_snapshot" jsonb,
  "next_snapshot" jsonb,
  "actor_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "bulk_operation_id" uuid,
  "reason" text,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "supplier_category_mapping_history_mapping_idx" ON "supplier_category_mapping_history" ("mapping_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "supplier_category_mapping_history_actor_idx" ON "supplier_category_mapping_history" ("actor_user_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "supplier_category_mapping_history_bulk_idx" ON "supplier_category_mapping_history" ("bulk_operation_id");
--> statement-breakpoint
INSERT INTO "admin_permissions" ("permission_key", "description") VALUES
  ('supplier_category_mappings.view', 'View supplier category mappings'),
  ('supplier_category_mappings.manage', 'Create and manage supplier category mappings')
ON CONFLICT ("permission_key") DO NOTHING;
--> statement-breakpoint
INSERT INTO "admin_role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id"
FROM "admin_roles" r CROSS JOIN "admin_permissions" p
WHERE lower(r."name") = 'super admin'
  AND p."permission_key" IN ('supplier_category_mappings.view', 'supplier_category_mappings.manage')
ON CONFLICT ("role_id", "permission_id") DO NOTHING;
--> statement-breakpoint
-- Reconcile the development/demo roots in place. Existing product category IDs
-- are never replaced; their old URLs become permanent redirect history.
DO $taxonomy$
DECLARE
  root record;
  child record;
  root_id uuid;
  category_id uuid;
  root_order integer;
  child_order integer;
  root_data jsonb;
  collision record;
  old_slug text;
  child_data jsonb;
  taxonomy jsonb := $json$
  {
    "women":{"name":"Women","slug":"women","children":[["Clothing","women-clothing"],["Shoes","women-shoes"],["Bags","women-bags"],["Jewellery & Accessories","women-jewellery-accessories"],["Activewear","women-activewear"]]},
    "men":{"name":"Men","slug":"men","children":[["Clothing","men-clothing"],["Shoes","men-shoes"],["Bags & Accessories","men-bags-accessories"],["Activewear","men-activewear"]]},
    "kids-baby":{"name":"Kids & Baby","slug":"kids-baby","children":[["Girls","kids-baby-girls"],["Boys","kids-baby-boys"],["Baby Clothing","kids-baby-clothing"],["Baby Essentials","kids-baby-essentials"],["Maternity","kids-baby-maternity"]]},
    "home-kitchen":{"name":"Home & Kitchen","slug":"home-kitchen","children":[["Kitchen & Dining","home-kitchen-kitchen-dining"],["Storage & Organization","home-kitchen-storage-organization"],["Home Décor","home-kitchen-home-decor"],["Bedding & Textiles","home-kitchen-bedding-textiles"],["Cleaning","home-kitchen-cleaning"],["Bathroom","home-kitchen-bathroom"],["Lighting","home-kitchen-lighting"],["Garden & Outdoor","home-kitchen-garden-outdoor"],["Furniture","home-kitchen-furniture"]]},
    "electronics":{"name":"Electronics","slug":"electronics","children":[["Phone Accessories","electronics-phone-accessories"],["Cables & Chargers","electronics-cables-chargers"],["Audio & Earbuds","electronics-audio-earbuds"],["Smartwatches & Wearables","electronics-smartwatches-wearables"],["Power Banks","electronics-power-banks"],["Computer Accessories","electronics-computer-accessories"],["Smart Home","electronics-smart-home"],["Cameras & Security","electronics-cameras-security"],["Electronic Accessories","electronics-electronic-accessories"]]},
    "beauty-personal-care":{"name":"Beauty & Personal Care","slug":"beauty-personal-care","children":[["Skincare","beauty-personal-care-skincare"],["Hair Care","beauty-personal-care-hair-care"],["Makeup","beauty-personal-care-makeup"],["Personal Care","beauty-personal-care-personal-care"],["Fragrance","beauty-personal-care-fragrance"],["Beauty Tools","beauty-personal-care-beauty-tools"]]},
    "toys-games":{"name":"Toys & Games","slug":"toys-games","children":[["Educational Toys","toys-games-educational-toys"],["Games & Puzzles","toys-games-games-puzzles"],["Electronic Toys","toys-games-electronic-toys"],["Outdoor Toys","toys-games-outdoor-toys"],["Collectibles","toys-games-collectibles"]]},
    "sports-outdoors":{"name":"Sports & Outdoors","slug":"sports-outdoors","children":[["Fitness","sports-outdoors-fitness"],["Outdoor & Camping","sports-outdoors-outdoor-camping"],["Sports Equipment","sports-outdoors-sports-equipment"],["Cycling","sports-outdoors-cycling"],["Sports Accessories","sports-outdoors-sports-accessories"]]},
    "travel-luggage":{"name":"Travel & Luggage","slug":"travel-luggage","children":[["Suitcases","travel-luggage-suitcases"],["Travel Bags","travel-luggage-travel-bags"],["Backpacks","travel-luggage-backpacks"],["Travel Accessories","travel-luggage-travel-accessories"],["Organizers","travel-luggage-organizers"]]},
    "office-stationery":{"name":"Office & Stationery","slug":"office-stationery","children":[["Pens & Writing","office-stationery-pens-writing"],["Desk Accessories","office-stationery-desk-accessories"],["Office Supplies","office-stationery-office-supplies"],["Storage & Filing","office-stationery-storage-filing"],["School Supplies","office-stationery-school-supplies"]]},
    "pet-supplies":{"name":"Pet Supplies","slug":"pet-supplies","children":[["Dogs","pet-supplies-dogs"],["Cats","pet-supplies-cats"],["Feeding","pet-supplies-feeding"],["Grooming","pet-supplies-grooming"],["Toys","pet-supplies-toys"],["Beds & Accessories","pet-supplies-beds-accessories"]]},
    "automotive":{"name":"Automotive","slug":"automotive","children":[["Car Accessories","automotive-car-accessories"],["Car Cleaning","automotive-car-cleaning"],["Interior Accessories","automotive-interior-accessories"],["Electronics","automotive-electronics"],["Tools & Maintenance","automotive-tools-maintenance"]]},
    "tools-diy":{"name":"Tools & DIY","slug":"tools-diy","children":[["Hand Tools","tools-diy-hand-tools"],["Power Tool Accessories","tools-diy-power-tool-accessories"],["Hardware","tools-diy-hardware"],["Electrical","tools-diy-electrical"],["Home Improvement","tools-diy-home-improvement"]]},
    "health-wellness":{"name":"Health & Wellness","slug":"health-wellness","children":[["Personal Wellness","health-wellness-personal-wellness"],["Mobility & Daily Living","health-wellness-mobility-daily-living"],["Health Accessories","health-wellness-health-accessories"]]},
    "other":{"name":"Other","slug":"other","children":[["Uncategorized","other-uncategorized"]]}
  }
  $json$::jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('catalog-slug:category'));
  FOR collision IN SELECT * FROM (VALUES
    ('demo-electronics','electronics'),('demo-home-kitchen','home-kitchen'),
    ('demo-beauty-care','beauty-personal-care'),('demo-travel-accessories','travel-luggage'),
    ('demo-office-essentials','office-stationery')
  ) AS known(old_slug,target_slug) LOOP
    IF EXISTS (
      SELECT 1 FROM slug_redirects sr
       WHERE lower(sr.old_slug)=lower(collision.old_slug)
         AND NOT (
           sr.entity_type='category'
           AND sr.entity_id IS NOT DISTINCT FROM COALESCE(
             (SELECT old.id FROM categories old WHERE lower(old.slug)=lower(collision.old_slug) LIMIT 1),
             (SELECT target.id FROM categories target WHERE lower(target.slug)=lower(collision.target_slug) LIMIT 1)
           )
         )
    ) THEN
      RAISE EXCEPTION 'category redirect ownership collision for %', collision.old_slug USING ERRCODE='23505';
    END IF;
    IF EXISTS (
      SELECT 1 FROM categories target
       WHERE lower(target.slug)=collision.target_slug
         AND NOT EXISTS (SELECT 1 FROM categories old WHERE old.slug=collision.old_slug AND old.id=target.id)
    ) AND EXISTS (SELECT 1 FROM categories old WHERE old.slug=collision.old_slug) THEN
      RAISE EXCEPTION 'canonical category slug collision for %', collision.target_slug USING ERRCODE='23505';
    END IF;
  END LOOP;
  -- Known demo roots are renamed in place, retaining their UUID and products.
  root_id := NULL;
  UPDATE categories SET canonical_key='electronics', name='Electronics', slug='electronics', updated_at=now()
    WHERE slug='demo-electronics' RETURNING id INTO root_id;
  IF root_id IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM slug_redirects sr WHERE lower(sr.old_slug)=lower('demo-electronics')
      AND NOT (sr.entity_type='category' AND sr.entity_id IS NOT DISTINCT FROM root_id)) THEN
      RAISE EXCEPTION 'category redirect ownership collision for %', 'demo-electronics' USING ERRCODE='23505';
    END IF;
    INSERT INTO slug_redirects(entity_type,entity_id,old_slug) VALUES ('category',root_id,'demo-electronics') ON CONFLICT DO NOTHING;
  END IF;
  root_id := NULL;
  UPDATE categories SET canonical_key='home-kitchen', name='Home & Kitchen', slug='home-kitchen', updated_at=now()
    WHERE slug='demo-home-kitchen' RETURNING id INTO root_id;
  IF root_id IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM slug_redirects sr WHERE lower(sr.old_slug)=lower('demo-home-kitchen')
      AND NOT (sr.entity_type='category' AND sr.entity_id IS NOT DISTINCT FROM root_id)) THEN
      RAISE EXCEPTION 'category redirect ownership collision for %', 'demo-home-kitchen' USING ERRCODE='23505';
    END IF;
    INSERT INTO slug_redirects(entity_type,entity_id,old_slug) VALUES ('category',root_id,'demo-home-kitchen') ON CONFLICT DO NOTHING;
  END IF;
  root_id := NULL;
  UPDATE categories SET canonical_key='beauty-personal-care', name='Beauty & Personal Care', slug='beauty-personal-care', updated_at=now()
    WHERE slug='demo-beauty-care' RETURNING id INTO root_id;
  IF root_id IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM slug_redirects sr WHERE lower(sr.old_slug)=lower('demo-beauty-care')
      AND NOT (sr.entity_type='category' AND sr.entity_id IS NOT DISTINCT FROM root_id)) THEN
      RAISE EXCEPTION 'category redirect ownership collision for %', 'demo-beauty-care' USING ERRCODE='23505';
    END IF;
    INSERT INTO slug_redirects(entity_type,entity_id,old_slug) VALUES ('category',root_id,'demo-beauty-care') ON CONFLICT DO NOTHING;
  END IF;
  root_id := NULL;
  UPDATE categories SET canonical_key='travel-luggage', name='Travel & Luggage', slug='travel-luggage', updated_at=now()
    WHERE slug='demo-travel-accessories' RETURNING id INTO root_id;
  IF root_id IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM slug_redirects sr WHERE lower(sr.old_slug)=lower('demo-travel-accessories')
      AND NOT (sr.entity_type='category' AND sr.entity_id IS NOT DISTINCT FROM root_id)) THEN
      RAISE EXCEPTION 'category redirect ownership collision for %', 'demo-travel-accessories' USING ERRCODE='23505';
    END IF;
    INSERT INTO slug_redirects(entity_type,entity_id,old_slug) VALUES ('category',root_id,'demo-travel-accessories') ON CONFLICT DO NOTHING;
  END IF;
  root_id := NULL;
  UPDATE categories SET canonical_key='office-stationery', name='Office & Stationery', slug='office-stationery', updated_at=now()
    WHERE slug='demo-office-essentials' RETURNING id INTO root_id;
  IF root_id IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM slug_redirects sr WHERE lower(sr.old_slug)=lower('demo-office-essentials')
      AND NOT (sr.entity_type='category' AND sr.entity_id IS NOT DISTINCT FROM root_id)) THEN
      RAISE EXCEPTION 'category redirect ownership collision for %', 'demo-office-essentials' USING ERRCODE='23505';
    END IF;
    INSERT INTO slug_redirects(entity_type,entity_id,old_slug) VALUES ('category',root_id,'demo-office-essentials') ON CONFLICT DO NOTHING;
  END IF;

  -- VALUES provides the contractual navigation order; jsonb object order is
  -- intentionally not used for display ordering.
  FOR root IN SELECT * FROM (VALUES
    (1,'women'),(2,'men'),(3,'kids-baby'),(4,'home-kitchen'),(5,'electronics'),
    (6,'beauty-personal-care'),(7,'toys-games'),(8,'sports-outdoors'),
    (9,'travel-luggage'),(10,'office-stationery'),(11,'pet-supplies'),
    (12,'automotive'),(13,'tools-diy'),(14,'health-wellness'),(15,'other')
  ) AS ordered(position,key) LOOP
    root_order := root.position;
    SELECT value INTO root_data FROM jsonb_each(taxonomy) WHERE key=root.key;
    root_id := NULL;
    SELECT id INTO root_id FROM categories WHERE canonical_key=root.key LIMIT 1;
    IF root_id IS NULL THEN
      SELECT id INTO root_id FROM categories
       WHERE parent_id IS NULL AND lower(name)=lower(root_data->>'name') LIMIT 1;
    END IF;
    IF root_id IS NULL THEN
      IF EXISTS (SELECT 1 FROM categories WHERE lower(slug)=lower(root_data->>'slug')) THEN
        RAISE EXCEPTION 'canonical category slug collision for %', root_data->>'slug' USING ERRCODE='23505';
      END IF;
      INSERT INTO categories(parent_id,name,slug,canonical_key,sort_order,active)
      VALUES(NULL,root_data->>'name',root_data->>'slug',root.key,root_order,true) RETURNING id INTO root_id;
    ELSE
      SELECT slug INTO old_slug FROM categories WHERE id=root_id;
      IF old_slug IS DISTINCT FROM root_data->>'slug' THEN
        IF EXISTS (SELECT 1 FROM slug_redirects sr WHERE lower(sr.old_slug)=lower(old_slug)
          AND NOT (sr.entity_type='category' AND sr.entity_id IS NOT DISTINCT FROM root_id)) THEN
          RAISE EXCEPTION 'category redirect ownership collision for %', old_slug USING ERRCODE='23505';
        END IF;
        INSERT INTO slug_redirects(entity_type,entity_id,old_slug) VALUES ('category',root_id,old_slug) ON CONFLICT DO NOTHING;
      END IF;
      UPDATE categories SET parent_id=NULL,name=root_data->>'name',slug=root_data->>'slug',canonical_key=root.key,sort_order=root_order,updated_at=now() WHERE id=root_id;
    END IF;
    FOR child IN SELECT value, ordinality FROM jsonb_array_elements(root_data->'children') WITH ORDINALITY AS children(value,ordinality) LOOP
      child_data := child.value;
      child_order := child.ordinality::integer;
      category_id := NULL;
      SELECT id INTO category_id FROM categories
       WHERE parent_id=root_id AND canonical_key=root.key || '.' || lower(regexp_replace(child_data->>0,'[^a-zA-Z0-9]+','-','g')) LIMIT 1;
      IF category_id IS NULL THEN
        SELECT id INTO category_id FROM categories
         WHERE parent_id=root_id AND lower(name)=lower(child_data->>0) LIMIT 1;
      END IF;
      IF category_id IS NULL THEN
        IF EXISTS (SELECT 1 FROM categories WHERE lower(slug)=lower(child_data->>1)) THEN
          RAISE EXCEPTION 'canonical category slug collision for %', child_data->>1 USING ERRCODE='23505';
        END IF;
        INSERT INTO categories(parent_id,name,slug,canonical_key,sort_order,active)
        VALUES(root_id,child_data->>0,child_data->>1,root.key || '.' || lower(regexp_replace(child_data->>0,'[^a-zA-Z0-9]+','-','g')),child_order,true);
      ELSE
        SELECT slug INTO old_slug FROM categories WHERE id=category_id;
        IF old_slug IS DISTINCT FROM child_data->>1 THEN
          IF EXISTS (SELECT 1 FROM slug_redirects sr WHERE lower(sr.old_slug)=lower(old_slug)
            AND NOT (sr.entity_type='category' AND sr.entity_id IS NOT DISTINCT FROM category_id)) THEN
            RAISE EXCEPTION 'category redirect ownership collision for %', old_slug USING ERRCODE='23505';
          END IF;
          INSERT INTO slug_redirects(entity_type,entity_id,old_slug) VALUES ('category',category_id,old_slug) ON CONFLICT DO NOTHING;
        END IF;
        UPDATE categories SET parent_id=root_id,name=child_data->>0,slug=child_data->>1,
          canonical_key=root.key || '.' || lower(regexp_replace(child_data->>0,'[^a-zA-Z0-9]+','-','g')),sort_order=child_order,updated_at=now()
          WHERE id=category_id;
      END IF;
    END LOOP;
  END LOOP;
END;
$taxonomy$;
--> statement-breakpoint
-- Refuse to install the hierarchy guard over data that is already deeper than
-- the supported root/child model.
DO $depth_check$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM categories child
      JOIN categories parent ON parent.id=child.parent_id
     WHERE parent.parent_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'cannot install category taxonomy: existing hierarchy exceeds depth 2' USING ERRCODE='23514';
  END IF;
END;
$depth_check$;
--> statement-breakpoint
-- Canonical/admin writes are intentionally limited to one root and one child.
CREATE OR REPLACE FUNCTION enforce_category_depth() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('catalog-category-supplier-integrity'));
  IF NEW.parent_id IS NOT NULL AND NEW.parent_id = NEW.id THEN
    RAISE EXCEPTION 'category cannot be its own parent' USING ERRCODE='23514';
  END IF;
  IF NEW.parent_id IS NOT NULL AND EXISTS (SELECT 1 FROM categories child WHERE child.parent_id=NEW.id) THEN
    RAISE EXCEPTION 'a category with children cannot be moved beneath another category' USING ERRCODE='23514';
  END IF;
  IF NEW.parent_id IS NOT NULL AND EXISTS (SELECT 1 FROM categories p WHERE p.id=NEW.parent_id AND p.parent_id IS NOT NULL) THEN
    RAISE EXCEPTION 'category hierarchy is limited to root and child categories' USING ERRCODE='23514';
  END IF;
  IF NEW.active AND NEW.parent_id IS NOT NULL AND EXISTS (SELECT 1 FROM categories p WHERE p.id=NEW.parent_id AND p.active=false) THEN
    RAISE EXCEPTION 'an active category requires an active parent category' USING ERRCODE='23514';
  END IF;
  IF NOT NEW.active AND EXISTS (SELECT 1 FROM categories child WHERE child.parent_id=NEW.id AND child.active=true) THEN
    RAISE EXCEPTION 'a category with active children cannot be deactivated' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS categories_depth_guard ON categories;
CREATE TRIGGER categories_depth_guard BEFORE INSERT OR UPDATE OF parent_id, active ON categories
FOR EACH ROW EXECUTE FUNCTION enforce_category_depth();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION enforce_category_mapping_references() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  mapping record;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('catalog-category-supplier-integrity'));
  IF TG_OP = 'UPDATE' AND (NEW.parent_id IS DISTINCT FROM OLD.parent_id OR NEW.active IS DISTINCT FROM OLD.active) THEN
    FOR mapping IN
      SELECT root_category_id, child_category_id
        FROM supplier_category_mappings
       WHERE root_category_id=OLD.id OR child_category_id=OLD.id
    LOOP
      IF NOT NEW.active THEN
        RAISE EXCEPTION 'a category targeted by a supplier mapping must remain active' USING ERRCODE='23514';
      END IF;
      IF mapping.root_category_id=OLD.id AND NEW.parent_id IS NOT NULL THEN
        RAISE EXCEPTION 'a mapped root category must remain a root' USING ERRCODE='23514';
      END IF;
      IF mapping.child_category_id=OLD.id AND mapping.root_category_id IS DISTINCT FROM NEW.parent_id THEN
        RAISE EXCEPTION 'a mapped child category must remain beneath its mapped root' USING ERRCODE='23514';
      END IF;
    END LOOP;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS categories_mapping_guard ON categories;
CREATE TRIGGER categories_mapping_guard
  BEFORE UPDATE OF parent_id, active ON categories
  FOR EACH ROW EXECUTE FUNCTION enforce_category_mapping_references();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION enforce_supplier_category_mapping_integrity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  root_parent uuid;
  child_parent uuid;
  root_active boolean;
  child_active boolean;
  supplier_active boolean;
  supplier_publication_enabled boolean;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('catalog-category-supplier-integrity'));
  IF NEW.child_category_id IS NOT NULL AND NEW.root_category_id IS NULL THEN
    RAISE EXCEPTION 'supplier mapping child requires a root category' USING ERRCODE='23514';
  END IF;
  IF NEW.root_category_id IS NOT NULL THEN
    SELECT parent_id, active INTO root_parent, root_active FROM categories WHERE id=NEW.root_category_id;
    IF NOT FOUND OR root_parent IS NOT NULL THEN
      RAISE EXCEPTION 'supplier mapping root must be a root category' USING ERRCODE='23514';
    END IF;
    IF NOT root_active THEN
      RAISE EXCEPTION 'supplier mapping root must be active' USING ERRCODE='23514';
    END IF;
  END IF;
  IF NEW.child_category_id IS NOT NULL THEN
    SELECT parent_id, active INTO child_parent, child_active FROM categories WHERE id=NEW.child_category_id;
    IF NOT FOUND OR child_parent IS DISTINCT FROM NEW.root_category_id THEN
      RAISE EXCEPTION 'supplier mapping child must belong to its root category' USING ERRCODE='23514';
    END IF;
    IF NOT child_active THEN
      RAISE EXCEPTION 'supplier mapping child must be active' USING ERRCODE='23514';
    END IF;
  END IF;
  IF NEW.status='mapped' AND NEW.root_category_id IS NULL THEN
    RAISE EXCEPTION 'mapped supplier category requires a root category' USING ERRCODE='23514';
  END IF;
  IF NEW.publication_enabled THEN
    SELECT active, publication_enabled INTO supplier_active, supplier_publication_enabled FROM suppliers WHERE id=NEW.supplier_id;
    IF NOT FOUND OR NOT supplier_active OR NOT supplier_publication_enabled THEN
      RAISE EXCEPTION 'published supplier mappings require an active publication-enabled supplier' USING ERRCODE='23514';
    END IF;
    IF NEW.status <> 'mapped' OR NEW.root_category_id IS NULL OR NEW.compliance_excluded THEN
      RAISE EXCEPTION 'published supplier mappings require mapped active compliant targets' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS supplier_category_mapping_integrity_guard ON supplier_category_mappings;
CREATE TRIGGER supplier_category_mapping_integrity_guard
  BEFORE INSERT OR UPDATE OF supplier_id, root_category_id, child_category_id, status, publication_enabled, compliance_excluded ON supplier_category_mappings
  FOR EACH ROW EXECUTE FUNCTION enforce_supplier_category_mapping_integrity();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION enforce_supplier_publication_mappings() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('catalog-category-supplier-integrity'));
  IF (NOT NEW.active OR NOT NEW.publication_enabled) AND EXISTS (
    SELECT 1 FROM supplier_category_mappings
     WHERE supplier_id=NEW.id AND publication_enabled=true
  ) THEN
    RAISE EXCEPTION 'a supplier with published mappings must remain active and publication-enabled' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS supplier_publication_mapping_guard ON suppliers;
CREATE TRIGGER supplier_publication_mapping_guard
  BEFORE UPDATE OF active, publication_enabled ON suppliers
  FOR EACH ROW EXECUTE FUNCTION enforce_supplier_publication_mappings();