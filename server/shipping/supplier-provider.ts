export type SupplierShippingQuote = {
  ruleId: string;
  provider: string;
  amountEur: number;
  minDeliveryDays: number | null;
  maxDeliveryDays: number | null;
  source: "temporary_supplier_rule";
};

export interface SupplierShippingProvider {
  readonly name: string;
  quote(input: { supplierId: string; countryCode: string; weightKg: number; client: { query: (text: string, values?: unknown[]) => Promise<{ rows: any[] }> } }): Promise<SupplierShippingQuote | null>;
}

/**
 * Supplier shipping is deliberately resolved through a registry rather than
 * calling a supplier service from checkout.  The checkout transaction owns
 * the client passed to a provider, so a quote can never observe rules outside
 * the order's transaction.
 */
const providers = new Map<string, SupplierShippingProvider>();

export function registerSupplierShippingProvider(provider: SupplierShippingProvider): void {
  providers.set(provider.name, provider);
}

export function getSupplierShippingProvider(name: string): SupplierShippingProvider {
  const provider = providers.get(name);
  if (!provider) throw new Error(`Supplier shipping provider is not registered: ${name}`);
  return provider;
}

export class TooniesTemporaryShippingProvider implements SupplierShippingProvider {
  readonly name = "toonies_temporary";

  async quote(input: {
    supplierId: string;
    countryCode: string;
    weightKg: number;
    client: { query: (text: string, values?: unknown[]) => Promise<{ rows: any[] }> };
  }): Promise<SupplierShippingQuote | null> {
    if (!Number.isFinite(input.weightKg) || input.weightKg <= 0) return null;
    const rows = (await input.client.query(
      `SELECT r.id,r.amount_eur AS "amountEur",r.min_delivery_days AS "minDeliveryDays",r.max_delivery_days AS "maxDeliveryDays"
         FROM supplier_shipping_rules r
        WHERE r.supplier_id=$1 AND r.active=true AND r.temporary=true
          AND (
            r.country_code=$2
            OR EXISTS (
              SELECT 1 FROM shipping_zones z
              JOIN shipping_zone_countries zc ON zc.zone_id=z.id
              WHERE z.id=r.destination_zone_id AND z.active=true AND zc.country_code=$2
            )
          )
          AND r.min_weight_kg <= $3
          AND (r.max_weight_kg IS NULL OR $3 < r.max_weight_kg)
          AND (r.expires_at IS NULL OR r.expires_at>now())
        ORDER BY r.destination_zone_id NULLS LAST,r.min_weight_kg DESC
         LIMIT 2
        FOR SHARE OF r`,
      [input.supplierId, input.countryCode.trim().toUpperCase(), input.weightKg],
    )).rows;
    // Rule overlap is rejected at write time, but membership edits can change
    // effective destination sets after a rule was saved. Never pick an
    // arbitrary precedence if that makes checkout ambiguous.
    if (rows.length !== 1) return null;
    const row = rows[0];
    return {
      ruleId: row.id,
      provider: this.name,
      amountEur: Number(row.amountEur),
      minDeliveryDays: row.minDeliveryDays === null ? null : Number(row.minDeliveryDays),
      maxDeliveryDays: row.maxDeliveryDays === null ? null : Number(row.maxDeliveryDays),
       source: "temporary_supplier_rule",
    };
  }
}

export const tooniesTemporaryShippingProvider = new TooniesTemporaryShippingProvider();
registerSupplierShippingProvider(tooniesTemporaryShippingProvider);