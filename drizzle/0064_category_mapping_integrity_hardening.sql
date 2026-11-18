-- Additive hardening for databases that already applied 0063.
-- This migration only replaces guards/functions and never creates catalog
-- entities or removes data. It is intentionally safe after either the
-- original 0063 or the current fresh-install version of 0063.

DO $depth_check$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('catalog-category-supplier-integrity'));
  IF EXISTS (
    SELECT 1
      FROM categories child
      JOIN categories parent ON parent.id=child.parent_id
     WHERE parent.parent_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'cannot install category taxonomy hardening: existing hierarchy exceeds depth 2' USING ERRCODE='23514';
  END IF;
END;
$depth_check$;
--> statement-breakpoint
DO $mapping_check$
DECLARE
  invalid_mapping uuid;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('catalog-category-supplier-integrity'));
  SELECT id INTO invalid_mapping
    FROM supplier_category_mappings
   WHERE child_category_id IS NOT NULL AND root_category_id IS NULL
   LIMIT 1;
  IF invalid_mapping IS NOT NULL THEN
    RAISE EXCEPTION 'cannot install mapping hardening: mapping % has a child target but no root target', invalid_mapping USING ERRCODE='23514';
  END IF;

  SELECT m.id INTO invalid_mapping
    FROM supplier_category_mappings m
    LEFT JOIN categories root ON root.id=m.root_category_id
   WHERE m.root_category_id IS NOT NULL
     AND (root.id IS NULL OR root.parent_id IS NOT NULL OR NOT root.active)
   LIMIT 1;
  IF invalid_mapping IS NOT NULL THEN
    RAISE EXCEPTION 'cannot install mapping hardening: mapping % has an invalid or inactive root target', invalid_mapping USING ERRCODE='23514';
  END IF;

  SELECT m.id INTO invalid_mapping
    FROM supplier_category_mappings m
    LEFT JOIN categories child ON child.id=m.child_category_id
   WHERE m.child_category_id IS NOT NULL
     AND (child.id IS NULL OR NOT child.active OR child.parent_id IS DISTINCT FROM m.root_category_id)
   LIMIT 1;
  IF invalid_mapping IS NOT NULL THEN
    RAISE EXCEPTION 'cannot install mapping hardening: mapping % has an invalid or inactive child target', invalid_mapping USING ERRCODE='23514';
  END IF;

  SELECT id INTO invalid_mapping
    FROM supplier_category_mappings
   WHERE status='mapped' AND root_category_id IS NULL
   LIMIT 1;
  IF invalid_mapping IS NOT NULL THEN
    RAISE EXCEPTION 'cannot install mapping hardening: mapped mapping % has no root target', invalid_mapping USING ERRCODE='23514';
  END IF;

  SELECT id INTO invalid_mapping
    FROM supplier_category_mappings
   WHERE publication_enabled=true AND compliance_excluded=true
   LIMIT 1;
  IF invalid_mapping IS NOT NULL THEN
    RAISE EXCEPTION 'cannot install mapping hardening: published mapping % remains compliance-excluded', invalid_mapping USING ERRCODE='23514';
  END IF;

  SELECT m.id INTO invalid_mapping
    FROM supplier_category_mappings m
    LEFT JOIN suppliers s ON s.id=m.supplier_id
    LEFT JOIN categories root ON root.id=m.root_category_id
    LEFT JOIN categories child ON child.id=m.child_category_id
   WHERE m.publication_enabled=true
     AND (
       s.id IS NULL OR NOT s.active OR NOT s.publication_enabled
       OR m.status <> 'mapped'
       OR root.id IS NULL OR root.parent_id IS NOT NULL OR NOT root.active
       OR (m.child_category_id IS NOT NULL AND (child.id IS NULL OR child.parent_id IS DISTINCT FROM root.id OR NOT child.active))
     )
   LIMIT 1;
  IF invalid_mapping IS NOT NULL THEN
    RAISE EXCEPTION 'cannot install mapping hardening: published mapping % has an invalid supplier, status, or category target', invalid_mapping USING ERRCODE='23514';
  END IF;
END;
$mapping_check$;
--> statement-breakpoint

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
CREATE TRIGGER categories_depth_guard
  BEFORE INSERT OR UPDATE OF parent_id, active ON categories
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
    SELECT active, publication_enabled INTO supplier_active, supplier_publication_enabled
      FROM suppliers WHERE id=NEW.supplier_id;
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
  BEFORE INSERT OR UPDATE OF supplier_id, root_category_id, child_category_id, status, publication_enabled, compliance_excluded
  ON supplier_category_mappings
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