ALTER TABLE "return_items" DROP CONSTRAINT "return_items_return_request_id_return_requests_id_fk";
--> statement-breakpoint
ALTER TABLE "return_items" DROP CONSTRAINT "return_items_order_item_id_order_items_id_fk";
--> statement-breakpoint
ALTER TABLE "variant_attribute_values" DROP CONSTRAINT "variant_attribute_values_attribute_value_id_attribute_values_id_fk";
--> statement-breakpoint
DROP INDEX "cart_items_product_variant_unique";--> statement-breakpoint
ALTER TABLE "return_items" ADD COLUMN "order_id" uuid;--> statement-breakpoint
ALTER TABLE "variant_attribute_values" ADD COLUMN "attribute_id" uuid;--> statement-breakpoint
UPDATE "return_items" AS ri
SET "order_id" = rr."order_id"
FROM "return_requests" AS rr
WHERE rr."id" = ri."return_request_id";--> statement-breakpoint
UPDATE "variant_attribute_values" AS vav
SET "attribute_id" = av."attribute_id"
FROM "attribute_values" AS av
WHERE av."id" = vav."attribute_value_id";--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "return_items" WHERE "order_id" IS NULL) THEN
    RAISE EXCEPTION 'Migration blocked: return_items contains orphaned return_request_id values';
  END IF;
  IF EXISTS (SELECT 1 FROM "variant_attribute_values" WHERE "attribute_id" IS NULL) THEN
    RAISE EXCEPTION 'Migration blocked: variant_attribute_values contains orphaned attribute_value_id values';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM "cart_items" ci
    JOIN "product_variants" pv ON pv."id" = ci."variant_id"
    WHERE ci."variant_id" IS NOT NULL AND pv."product_id" <> ci."product_id"
  ) THEN
    RAISE EXCEPTION 'Migration blocked: cart_items contains a variant from another product';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM "order_items" oi
    JOIN "product_variants" pv ON pv."id" = oi."variant_id"
    WHERE oi."variant_id" IS NOT NULL AND pv."product_id" <> oi."product_id"
  ) THEN
    RAISE EXCEPTION 'Migration blocked: order_items contains a variant from another product';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM "product_media" pm
    JOIN "product_variants" pv ON pv."id" = pm."variant_id"
    WHERE pm."variant_id" IS NOT NULL AND pv."product_id" <> pm."product_id"
  ) THEN
    RAISE EXCEPTION 'Migration blocked: product_media contains a variant from another product';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM "cart_items"
    WHERE "variant_id" IS NULL
    GROUP BY "cart_id", "product_id"
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Migration blocked: duplicate product-only cart lines must be consolidated';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM "variant_attribute_values"
    GROUP BY "variant_id", "attribute_id"
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Migration blocked: a variant has multiple values for one attribute';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM "return_items" ri
    JOIN "order_items" oi ON oi."id" = ri."order_item_id"
    WHERE oi."order_id" <> ri."order_id"
  ) THEN
    RAISE EXCEPTION 'Migration blocked: return_items contains an item from another order';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM "return_items" ri
    JOIN "order_items" oi ON oi."id" = ri."order_item_id"
    GROUP BY ri."order_item_id", oi."quantity"
    HAVING SUM(ri."quantity") > oi."quantity"
  ) THEN
    RAISE EXCEPTION 'Migration blocked: returned quantity exceeds purchased quantity';
  END IF;
END;
$$;--> statement-breakpoint
ALTER TABLE "return_items" ALTER COLUMN "order_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "variant_attribute_values" ALTER COLUMN "attribute_id" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "attribute_values_id_attribute_unique" ON "attribute_values" USING btree ("id","attribute_id");--> statement-breakpoint
CREATE UNIQUE INDEX "order_items_id_order_unique" ON "order_items" USING btree ("id","order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "product_variants_id_product_unique" ON "product_variants" USING btree ("id","product_id");--> statement-breakpoint
CREATE UNIQUE INDEX "return_requests_id_order_unique" ON "return_requests" USING btree ("id","order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "cart_items_variant_unique" ON "cart_items" USING btree ("cart_id","variant_id") WHERE "cart_items"."variant_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "cart_items_product_only_unique" ON "cart_items" USING btree ("cart_id","product_id") WHERE "cart_items"."variant_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "variant_attribute_values_variant_attribute_unique" ON "variant_attribute_values" USING btree ("variant_id","attribute_id");--> statement-breakpoint
ALTER TABLE "cart_items" ADD CONSTRAINT "cart_items_variant_product_fk" FOREIGN KEY ("variant_id","product_id") REFERENCES "public"."product_variants"("id","product_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_variant_product_fk" FOREIGN KEY ("variant_id","product_id") REFERENCES "public"."product_variants"("id","product_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_media" ADD CONSTRAINT "product_media_variant_product_fk" FOREIGN KEY ("variant_id","product_id") REFERENCES "public"."product_variants"("id","product_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_items" ADD CONSTRAINT "return_items_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_items" ADD CONSTRAINT "return_items_request_order_fk" FOREIGN KEY ("return_request_id","order_id") REFERENCES "public"."return_requests"("id","order_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_items" ADD CONSTRAINT "return_items_item_order_fk" FOREIGN KEY ("order_item_id","order_id") REFERENCES "public"."order_items"("id","order_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variant_attribute_values" ADD CONSTRAINT "variant_attribute_values_attribute_id_product_attributes_id_fk" FOREIGN KEY ("attribute_id") REFERENCES "public"."product_attributes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variant_attribute_values" ADD CONSTRAINT "variant_attribute_values_value_attribute_fk" FOREIGN KEY ("attribute_value_id","attribute_id") REFERENCES "public"."attribute_values"("id","attribute_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE OR REPLACE FUNCTION enforce_return_item_quantity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  purchased_quantity integer;
  previously_returned bigint;
BEGIN
  SELECT quantity
    INTO purchased_quantity
    FROM order_items
    WHERE id = NEW.order_item_id AND order_id = NEW.order_id
    FOR UPDATE;

  IF purchased_quantity IS NULL THEN
    RAISE EXCEPTION 'Return item must reference an item from the same order'
      USING ERRCODE = '23514';
  END IF;

  SELECT COALESCE(SUM(quantity), 0)
    INTO previously_returned
    FROM return_items
    WHERE order_item_id = NEW.order_item_id
      AND id <> NEW.id;

  IF previously_returned + NEW.quantity > purchased_quantity THEN
    RAISE EXCEPTION 'Returned quantity exceeds purchased quantity'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER return_items_quantity_guard
BEFORE INSERT OR UPDATE OF quantity, order_item_id, order_id
ON return_items
FOR EACH ROW
EXECUTE FUNCTION enforce_return_item_quantity();