CREATE UNIQUE INDEX supplier_price_change_reviews_one_pending_variant_scope
  ON supplier_price_change_reviews(catalogue_item_id, catalogue_variant_id)
  WHERE status = 'pending' AND catalogue_variant_id IS NOT NULL;
--> statement-breakpoint

CREATE UNIQUE INDEX supplier_price_change_reviews_one_pending_item_scope
  ON supplier_price_change_reviews(catalogue_item_id)
  WHERE status = 'pending' AND catalogue_variant_id IS NULL;
--> statement-breakpoint

DROP INDEX supplier_price_change_reviews_one_pending_scope;
--> statement-breakpoint

ALTER INDEX supplier_price_change_reviews_one_pending_variant_scope
  RENAME TO supplier_price_change_reviews_one_pending_scope;