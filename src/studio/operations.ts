/** Deterministic operations core. No AI inference, database or catalogue mutation. */
export const MAX_MINOR = 9_223_372_036_854_775_807n;
const MAX_QUANTITY = 1_000_000_000_000n;
export class StudioError extends Error {
  constructor(public readonly code: string) { super(code); this.name = 'StudioError'; }
}
export function integer(value: unknown, max = MAX_MINOR, allowZero = true): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,18})$/.test(value)) throw new StudioError('INTEGER_STRING_REQUIRED');
  const result = BigInt(value);
  if (result > max || (!allowZero && result === 0n)) throw new StudioError('AMOUNT_OUT_OF_RANGE');
  return result;
}
export function decimalToScaled(value: string, places = 2): bigint {
  if (!Number.isSafeInteger(places) || places < 0 || places > 6) throw new StudioError('INVALID_SCALE');
  if (typeof value !== 'string' || value.length > 32 || !/^(0|[1-9][0-9]*)([.,][0-9]+)?$/.test(value)) throw new StudioError('AMBIGUOUS_DECIMAL');
  const [whole, fraction = ''] = value.replace(',', '.').split('.');
  if (fraction.length > places) throw new StudioError('PRECISION_LOSS');
  const result = BigInt(whole!) * 10n ** BigInt(places) + BigInt(fraction.padEnd(places, '0') || '0');
  if (result > MAX_MINOR) throw new StudioError('AMOUNT_OUT_OF_RANGE');
  return result;
}
export type Unit = 'g' | 'ml' | 'piece';
export interface Ingredient {
  id: string;
  unit: Unit;
  packQuantity: string;
  packCostMinor: string;
  recipeQuantity: string;
  edibleYieldBps: number;
}
function gcd(a: bigint, b: bigint): bigint { while (b !== 0n) [a, b] = [b, a % b]; return a; }
function halfUp(n: bigint, d: bigint): bigint { return (2n * n + d) / (2n * d); }
/** Input quantities are already normalized: grams, millilitres or whole pieces.
 * Package price and recipe price must use the SAME approved tax basis.
 * Rational sums are rounded once, at the entire recipe boundary, not per ingredient.
 */
export function costRecipe(lines: readonly Ingredient[], portions: number, overheadMinor = '0') {
  if (!Array.isArray(lines) || lines.length < 1 || lines.length > 100 || !Number.isSafeInteger(portions) || portions < 1 || portions > 1000) throw new StudioError('INVALID_RECIPE');
  let numerator = integer(overheadMinor), denominator = 1n;
  const ids = new Set<string>();
  for (const line of lines) {
    if (!line || typeof line.id !== 'string' || !line.id.trim() || line.id.length > 100 || ids.has(line.id)) throw new StudioError('INVALID_INGREDIENT_ID');
    ids.add(line.id);
    if (!['g', 'ml', 'piece'].includes(line.unit)) throw new StudioError('UNIT_NOT_NORMALIZED');
    const pack = integer(line.packQuantity, MAX_QUANTITY, false), used = integer(line.recipeQuantity, MAX_QUANTITY, false), cost = integer(line.packCostMinor);
    if (!Number.isSafeInteger(line.edibleYieldBps) || line.edibleYieldBps < 1 || line.edibleYieldBps > 10000) throw new StudioError('INVALID_YIELD');
    const n = cost * used * 10000n, d = pack * BigInt(line.edibleYieldBps), common = gcd(denominator, d);
    numerator = numerator * (d / common) + n * (denominator / common);
    denominator = denominator * (d / common);
    const reduce = gcd(numerator, denominator); numerator /= reduce; denominator /= reduce;
  }
  const total = halfUp(numerator, denominator);
  if (total > MAX_MINOR) throw new StudioError('AMOUNT_OUT_OF_RANGE');
  const count = BigInt(portions), quotient = total / count, remainder = total % count;
  const allocation = Array.from({length: portions}, (_, i) => (quotient + (BigInt(i) < remainder ? 1n : 0n)).toString());
  return {totalMinor: total.toString(), portionCostsMinor: allocation, rounding: 'recipe-half-up-then-remainder-first', currency: 'TRY'} as const;
}
export interface InvoiceLine {name: string; netMinor: string | null; taxMinor: string | null; grossMinor: string | null}
/** Pure reconciliation of declared amounts. Does not infer tax rates or create accounting entries. */
export function reconcileInvoice(lines: readonly InvoiceLine[], statedTotalMinor: string | null, adjustmentsMinor = '0') {
  if (!Array.isArray(lines) || lines.length < 1 || lines.length > 200) throw new StudioError('INVALID_INVOICE');
  const issues: string[] = [];
  let sum = integer(adjustmentsMinor);
  lines.forEach((line, i) => {
    if (!line || typeof line.name !== 'string' || !line.name.trim() || line.name.length > 200) throw new StudioError('INVALID_INVOICE_LINE');
    if (line.netMinor === null || line.taxMinor === null || line.grossMinor === null) { issues.push(`LINE_${i + 1}_INCOMPLETE`); return; }
    const net = integer(line.netMinor), tax = integer(line.taxMinor), gross = integer(line.grossMinor);
    if (net + tax !== gross) issues.push(`LINE_${i + 1}_MISMATCH`);
    sum += gross; if (sum > MAX_MINOR) throw new StudioError('AMOUNT_OUT_OF_RANGE');
  });
  if (statedTotalMinor === null) issues.push('INVOICE_TOTAL_MISSING');
  else if (integer(statedTotalMinor) !== sum) issues.push('INVOICE_TOTAL_MISMATCH');
  return {consistent: issues.length === 0, computedTotalMinor: issues.some(x => x.endsWith('_INCOMPLETE')) ? null : sum.toString(), statedTotalMinor, issues, requiresHumanReview: true};
}
export interface ServiceDay {date: string; open: boolean; complete: boolean; stockout: boolean; units: string}
function day(value: string): number {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new StudioError('INVALID_DATE');
  const d = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(d.getTime()) || d.toISOString().slice(0, 10) !== value) throw new StudioError('INVALID_DATE');
  return d.getUTCDay();
}
/** Descriptive same-weekday estimate, not causal AI forecasting. Missing/closed/stockout days are NOT zero demand. */
export function productionEstimate(history: readonly ServiceDay[], targetDate: string) {
  const weekday = day(targetDate);
  if (!Array.isArray(history) || history.length > 366) throw new StudioError('INVALID_HISTORY');
  const used = new Set<string>(), matching: bigint[] = [];
  for (const row of history) {
    const w = day(row.date), units = integer(row.units, MAX_QUANTITY);
    if (used.has(row.date)) throw new StudioError('DUPLICATE_SERVICE_DAY'); used.add(row.date);
    if (row.date >= targetDate) throw new StudioError('FUTURE_HISTORY');
    if (typeof row.open !== 'boolean' || typeof row.complete !== 'boolean' || typeof row.stockout !== 'boolean') throw new StudioError('INVALID_HISTORY');
    const age = (Date.parse(targetDate) - Date.parse(row.date)) / 86400000;
    if (row.open && row.complete && !row.stockout && age <= 56 && w === weekday) matching.push(units);
  }
  if (matching.length < 4) return {status: 'insufficient_data' as const, samples: matching.length, required: 4};
  matching.sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
  const n = matching.length, middle = n % 2 ? matching[(n - 1) / 2]! : (matching[n / 2 - 1]! + matching[n / 2]! + 1n) / 2n;
  return {status: 'estimate' as const, targetDate, samples: n, suggestedUnits: middle.toString(), lowerUnits: matching[Math.floor((n - 1) / 4)]!.toString(), upperUnits: matching[Math.ceil(3 * (n - 1) / 4)]!.toString(), method: 'observed-same-weekday-median', automaticPurchase: false};
}
