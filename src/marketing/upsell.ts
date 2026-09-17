/** Server-side deterministic recommendations. No LLM, random sort, or basket mutation. */
import { bps, fail, minor, uuid } from '../shared.js';

export interface CartItem {
  readonly businessId: string;
  readonly branchId: string;
  readonly productId: string; // public.menu_items.id, not the TIR source key
  readonly quantity: number;
}
export interface RecommendedProduct {
  readonly id: string;
  readonly name: string;
  readonly available: boolean;
  readonly priceApproved: boolean;
  readonly priceMinor: bigint | null;
  readonly stockScoreBps: bigint; // server-stock snapshot score: 0..10000
  readonly permitted: boolean; // server product/option/allergen eligibility filter
}
export interface UpsellRule {
  readonly id: string;
  readonly businessId: string;
  readonly branchId: string;
  readonly targetProductId: string;
  readonly activeNow: boolean; // active/time window evaluated ONCE by server SQL
  readonly weightBps: bigint;
  readonly confidenceBps: bigint;
  readonly marginScoreBps: bigint;
  readonly recommended: RecommendedProduct;
}
export interface Recommendation {
  readonly productId: string;
  readonly productName: string;
  readonly priceMinor: bigint;
  readonly ruleId: string;
  readonly score: bigint; // exact fixed-point numerator; only internal diagnostics
}
const lexical = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

export function getRecommendations(
  cartItems: readonly CartItem[],
  rules: readonly UpsellRule[],
): readonly Recommendation[] {
  if (cartItems.length > 500 || rules.length > 5000) fail('RECOMMENDATION_INPUT_LIMIT');
  if (cartItems.length === 0) return Object.freeze([]);
  const business = uuid(cartItems[0]!.businessId);
  const branch = uuid(cartItems[0]!.branchId);
  const present = new Set<string>();
  for (const item of cartItems) {
    if (uuid(item.businessId) !== business || uuid(item.branchId) !== branch)
      fail('CROSS_BRANCH_CART');
    if (!Number.isSafeInteger(item.quantity) || item.quantity < 1 || item.quantity > 999)
      fail('INVALID_QUANTITY');
    present.add(uuid(item.productId));
  }
  const best = new Map<string, Recommendation>();
  const seenRules = new Set<string>();
  const seenProducts = new Map<string, string>();
  for (const rule of rules) {
    // Foreign-tenant rules do not influence this branch's output.
    if (uuid(rule.businessId) !== business || uuid(rule.branchId) !== branch) continue;
    const ruleId = uuid(rule.id);
    if (seenRules.has(ruleId)) fail('DUPLICATE_RULE_ID');
    seenRules.add(ruleId);
    const target = uuid(rule.targetProductId);
    if (!rule.activeNow || !present.has(target)) continue;
    const p = rule.recommended;
    const productId = uuid(p.id);
    if (present.has(productId) || target === productId) continue;
    const price = p.priceMinor === null ? null : minor(p.priceMinor);
    if (typeof p.name !== 'string' || p.name.trim().length < 1 || p.name.length > 250)
      fail('INVALID_PRODUCT_NAME');
    // All joined rules for one product must use the same stock/price snapshot.
    const signature = `${p.name}\0${price}\0${bps(p.stockScoreBps)}\0${p.available}\0${p.priceApproved}\0${p.permitted}`;
    if (seenProducts.has(productId) && seenProducts.get(productId) !== signature)
      fail('INCONSISTENT_PRODUCT_SNAPSHOT');
    seenProducts.set(productId, signature);
    if (!p.available || !p.priceApproved || !p.permitted || price === null) continue;
    const score = bps(rule.weightBps) * (
      60n * bps(rule.confidenceBps) +
      30n * bps(rule.marginScoreBps) +
      10n * bps(p.stockScoreBps)
    );
    if (score === 0n) continue;
    const candidate = Object.freeze({
      productId, productName: p.name, priceMinor: price, ruleId, score,
    });
    const previous = best.get(productId);
    // Duplicate targets do not amplify one recommendation: keep maximum score.
    if (!previous || score > previous.score ||
      (score === previous.score && lexical(ruleId, previous.ruleId) < 0)) {
      best.set(productId, candidate);
    }
  }
  return Object.freeze([...best.values()].sort((a, b) =>
    a.score === b.score
      ? lexical(a.productId, b.productId)
      : a.score > b.score ? -1 : 1,
  ).slice(0, 2));
}

/** Public DTO: do not expose rule confidence/margin/weights to diners. */
export function recommendationDto(value: Recommendation) {
  return { productId: value.productId, productName: value.productName,
    priceMinor: value.priceMinor.toString() };
}
