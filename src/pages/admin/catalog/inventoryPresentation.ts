export interface InventoryPresentationInput {
  active: boolean;
  status: "inactive" | "out" | "low" | "in_stock";
  available: number;
}

export function inventoryPresentation(item: InventoryPresentationInput | undefined): string {
  if (!item) return "No inventory record";
  if (!item.active || item.status === "inactive") {
    return item.available <= 0 ? "Out of stock · Inventory inactive" : "Inventory inactive";
  }
  return item.available <= 0 ? "Out of stock" : "In stock";
}