DROP INDEX IF EXISTS toonies_settlements_order_unresolved_unique;
CREATE UNIQUE INDEX toonies_settlements_order_unresolved_unique ON toonies_settlements(order_id)
  WHERE state IN ('not_submitted','submitting','transmitted_unknown','reconciling','replay_pending','confirmed','manual_review');