ALTER TABLE financial_operation_reservations
  DROP CONSTRAINT financial_operation_reservations_order_id_fkey;
ALTER TABLE financial_operation_reservations
  ADD CONSTRAINT financial_operation_reservations_order_id_fkey
  FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE;