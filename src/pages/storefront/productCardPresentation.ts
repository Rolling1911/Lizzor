type ProductCardPricingContext = {
  promotion?: { name?: string } | null;
  nextTier?: { minQuantity: number; unitPrice: number } | null;
};

export function selectSellableProducts<T extends { availability: string }>(products: T[]): T[] {
  return products.filter((product) => product.availability !== "out_of_stock");
}

export function productCardTierMessages(
  product: ProductCardPricingContext,
  formatMoney: (value: number) => string,
): string[] {
  const messages: string[] = [];
  const promotionName = product.promotion?.name?.trim();

  if (promotionName) messages.push(promotionName);
  if (product.nextTier) {
    messages.push(`From ${product.nextTier.minQuantity} units · ${formatMoney(product.nextTier.unitPrice)} each`);
  }

  return messages;
}