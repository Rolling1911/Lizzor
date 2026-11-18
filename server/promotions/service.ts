import { getDatabasePool } from "../db/client.js";
import { AppError } from "../middleware/error-handler.js";

export type PromotionLine = {
  key: string;
  productId: string;
  categoryId?: string | null;
  brandId?: string | null;
  lineTotal: number;
  quantity: number;
};

export type PromotionResult = {
  lines: Record<string, { discount: number; promotionId?: string; promotionName?: string; allocations: Array<{ promotionId: string; promotionName: string; amount: number }> }>;
  promotions: Array<{ id: string; name: string; discountAmount: number; freeShipping: boolean; coupon: boolean }>;
  discountTotal: number;
  shippingDiscount: number;
  appliedCouponCode: string | null;
  couponError: string | null;
};

type Campaign = {
  id: string; name: string; promotionType: string; discountType: "percentage" | "fixed" | null;
  discountValue: number | null; minimumOrderValue: number | null; freeShipping: boolean;
  automatic: boolean; couponCode: string | null; usageLimit: number | null;
  usageLimitPerCustomer: number | null; usageCount: number; allowStacking: boolean; priority: number;
  productIds: string[]; categoryIds: string[]; brandIds: string[];
};

function activeWhere(now = "now()") {
  return `c.active = true AND c.archived_at IS NULL AND c.start_at <= ${now} AND (c.end_at IS NULL OR c.end_at >= ${now})`;
}

function round(value: number) {
  return Number(Math.max(0, value).toFixed(2));
}

function normalizeCode(value: string | null | undefined) {
  return value?.trim().toUpperCase() || null;
}

type CustomerIdentity = { userId?: string; guestSessionId?: string };

async function campaignsForLines(client: any, lines: PromotionLine[], couponCode: string | null, identity: CustomerIdentity = {}) {
  const result = await client.query(
    `SELECT c.id, c.name, c.promotion_type AS "promotionType", c.discount_type AS "discountType",
            c.discount_value AS "discountValue", c.minimum_order_value AS "minimumOrderValue",
            c.free_shipping AS "freeShipping", c.automatic, c.coupon_code AS "couponCode",
            c.usage_limit AS "usageLimit", c.usage_limit_per_customer AS "usageLimitPerCustomer",
             c.usage_count AS "usageCount",
            c.allow_stacking AS "allowStacking", c.priority,
            COALESCE((SELECT json_agg(pp.product_id) FROM promotion_products pp WHERE pp.campaign_id=c.id),'[]') AS "productIds",
            COALESCE((SELECT json_agg(pc.category_id) FROM promotion_categories pc WHERE pc.campaign_id=c.id),'[]') AS "categoryIds",
            COALESCE((SELECT json_agg(pb.brand_id) FROM promotion_brands pb WHERE pb.campaign_id=c.id),'[]') AS "brandIds"
       FROM promotion_campaigns c
      WHERE ${activeWhere()} AND (c.automatic = true OR upper(c.coupon_code) = $1)
      ORDER BY c.priority DESC, c.created_at ASC, c.id ASC`,
    [couponCode],
  );
  const total = round(lines.reduce((sum, line) => sum + line.lineTotal, 0));
  const campaignIds = result.rows.map((row: { id: string }) => row.id);
  const usageRows = campaignIds.length ? await client.query(
    `SELECT campaign_id AS "campaignId", count(*)::int AS total,
            count(*) FILTER (WHERE ($2::uuid IS NOT NULL AND user_id=$2::uuid) OR ($3::varchar IS NOT NULL AND guest_session_id=$3::varchar))::int AS customer_total
       FROM promotion_usages
      WHERE campaign_id=ANY($1::uuid[])
      GROUP BY campaign_id`,
    [campaignIds, identity.userId ?? null, identity.guestSessionId ?? null],
  ) : { rows: [] };
  const usageByCampaign = new Map<string, { total: number; customer_total: number }>(
    usageRows.rows.map((row: { campaignId: string; total: number; customer_total: number }) => [row.campaignId, row]),
  );
  const eligible = (campaign: Campaign, line: PromotionLine) => {
    if (campaign.minimumOrderValue !== null && total < campaign.minimumOrderValue) return false;
    if (campaign.promotionType === "product") return lines.some((item) => item.productId === line.productId && item.key === line.key);
    return true;
  };
  const usable: Campaign[] = [];
  for (const raw of result.rows) {
    const campaign = {
      ...raw,
      discountValue: raw.discountValue === null ? null : Number(raw.discountValue),
      minimumOrderValue: raw.minimumOrderValue === null ? null : Number(raw.minimumOrderValue),
      usageLimit: raw.usageLimit === null ? null : Number(raw.usageLimit),
      usageLimitPerCustomer: raw.usageLimitPerCustomer === null ? null : Number(raw.usageLimitPerCustomer),
       usageCount: Number(raw.usageCount),
      priority: Number(raw.priority),
      productIds: raw.productIds ?? [],
      categoryIds: raw.categoryIds ?? [],
      brandIds: raw.brandIds ?? [],
    } as Campaign;
    const selected = campaign.couponCode ? normalizeCode(campaign.couponCode) === couponCode : campaign.automatic;
    if (!selected) continue;
    const used = usageByCampaign.get(campaign.id) ?? { total: 0, customer_total: 0 };
    if (campaign.usageLimit !== null && campaign.usageCount >= campaign.usageLimit) continue;
    if (campaign.usageLimitPerCustomer !== null && (!identity.userId && !identity.guestSessionId || Number(used.customer_total) >= campaign.usageLimitPerCustomer)) continue;
    if (campaign.promotionType !== "order" && !lines.some((line) => eligible(campaign, line) && campaignMatches(campaign, line))) continue;
    usable.push(campaign);
  }
  return { usable, total };
}

function campaignMatches(campaign: Campaign, line: PromotionLine) {
  if (campaign.promotionType === "order") return true;
  if (campaign.promotionType === "product") return campaign.productIds.includes(line.productId);
  if (campaign.promotionType === "category") return Boolean(line.categoryId && campaign.categoryIds.includes(line.categoryId));
  if (campaign.promotionType === "brand") return Boolean(line.brandId && campaign.brandIds.includes(line.brandId));
  return false;
}

export async function evaluatePromotions(lines: PromotionLine[], couponCode?: string | null, identity: CustomerIdentity = {}, client: any = getDatabasePool()): Promise<PromotionResult> {
  const normalized = normalizeCode(couponCode);
  const { usable, total } = await campaignsForLines(client, lines, normalized, identity);
  const automatic = usable.filter((campaign) => campaign.automatic && !campaign.couponCode);
  const coupon = normalized ? usable.find((campaign) => normalizeCode(campaign.couponCode) === normalized) : undefined;
  const chosen: Campaign[] = [];
  if (automatic[0]) chosen.push(automatic[0]);
  if (coupon && (chosen.length === 0 || chosen[0]!.allowStacking || coupon.allowStacking)) chosen.push(coupon);
  const discounts: PromotionResult["lines"] = {};
  const promotions: PromotionResult["promotions"] = [];
  let discountTotal = 0;
  let shippingDiscount = 0;
  for (const campaign of chosen) {
    const matching = lines.filter((line) => campaignMatches(campaign, line));
    if (campaign.minimumOrderValue !== null && total < campaign.minimumOrderValue) continue;
    if (campaign.freeShipping) shippingDiscount = 1;
    let amount = 0;
    if (campaign.discountType === "percentage" && campaign.discountValue !== null) {
      for (const line of matching) {
        const current = discounts[line.key]?.discount ?? 0;
        const discount = round(Math.min(line.lineTotal - current, line.lineTotal * campaign.discountValue / 100));
        const allocations = [...(discounts[line.key]?.allocations ?? []), { promotionId: campaign.id, promotionName: campaign.name, amount: discount }];
        discounts[line.key] = { discount: round(current + discount), promotionId: campaign.id, promotionName: campaign.name, allocations };
        amount += discount;
      }
    } else if (campaign.discountType === "fixed" && campaign.discountValue !== null) {
      const eligibleTotal = matching.reduce((sum, line) => sum + line.lineTotal, 0);
      if (eligibleTotal > 0) for (const line of matching) {
        const current = discounts[line.key]?.discount ?? 0;
        const discount = round(Math.min(line.lineTotal - current, campaign.discountValue * line.lineTotal / eligibleTotal));
        const allocations = [...(discounts[line.key]?.allocations ?? []), { promotionId: campaign.id, promotionName: campaign.name, amount: discount }];
        discounts[line.key] = { discount: round(current + discount), promotionId: campaign.id, promotionName: campaign.name, allocations };
        amount += discount;
      }
    }
    amount = round(Math.min(amount, total));
    promotions.push({ id: campaign.id, name: campaign.name, discountAmount: amount, freeShipping: campaign.freeShipping, coupon: Boolean(campaign.couponCode) });
  }
  discountTotal = round(Object.values(discounts).reduce((sum, line) => sum + line.discount, 0));
  if (discountTotal > total) throw new AppError(500, "PROMOTION_TOTAL_INVALID", "The promotion total could not be reconciled.");
  return { lines: discounts, promotions, discountTotal, shippingDiscount, appliedCouponCode: normalized, couponError: normalized && !coupon ? "Invalid, expired, inactive, or ineligible coupon code." : null };
}

export async function validateCoupon(code: string, lines: PromotionLine[], identity: CustomerIdentity = {}) {
  const normalized = normalizeCode(code);
  if (!normalized) throw new AppError(400, "COUPON_REQUIRED", "Enter a coupon code.");
  const result = await evaluatePromotions(lines, normalized, identity);
  if (!result.promotions.some((item) => item.coupon)) throw new AppError(422, "COUPON_INVALID", result.couponError ?? "This coupon cannot be applied.");
  return result;
}

export async function releasePromotionUsages(client: any, orderId: string): Promise<number> {
  const usages = (await client.query(
    `SELECT pu.id,pu.campaign_id AS "campaignId"
       FROM promotion_usages pu JOIN promotion_campaigns pc ON pc.id=pu.campaign_id
      WHERE pu.order_id=$1 FOR UPDATE OF pu,pc`,
    [orderId],
  )).rows;
  for (const usage of usages) {
    const decremented = await client.query(
      "UPDATE promotion_campaigns SET usage_count=usage_count-1,updated_at=now() WHERE id=$1 AND usage_count > 0",
      [usage.campaignId],
    );
    if (!decremented.rowCount) throw new AppError(409, "PROMOTION_USAGE_RELEASE_FAILED", "A promotion usage could not be released safely.");
  }
  if (usages.length) await client.query("DELETE FROM promotion_usages WHERE order_id=$1", [orderId]);
  return usages.length;
}

export function promotionStatus(row: { active: boolean; archivedAt: Date | null; startAt: Date; endAt: Date | null }) {
  if (row.archivedAt || !row.active) return "disabled";
  const now = Date.now();
  if (row.startAt.getTime() > now) return "scheduled";
  if (row.endAt && row.endAt.getTime() < now) return "expired";
  return "active";
}