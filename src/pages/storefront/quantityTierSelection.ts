export interface QuantityTierRange {
  minQuantity: number;
  maxQuantity: number | null;
}

export function quantityForTier(tier: QuantityTierRange, available: number): number | null {
  return tier.minQuantity <= available ? tier.minQuantity : null;
}

export function isQuantityInTier(quantity: number, tier: QuantityTierRange): boolean {
  return quantity >= tier.minQuantity && (tier.maxQuantity === null || quantity <= tier.maxQuantity);
}