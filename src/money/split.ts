/** Para: kuruş cinsinden bigint. Bu modül veritabanına erişmez. */
export const MAX_MINOR = 9_223_372_036_854_775_807n;
export const MAX_SPLIT_COUNT = 100; // Kaynak tüketimini sınırlayan ürün politikası.
export const BPS_DENOMINATOR = 10_000n;
export const MAX_TIP_BPS = 10_000; // %100 üst sınır; %5/%10/%15 zorunlu değil.

export class MoneyError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = 'MoneyError';
  }
}

export function assertMinor(value: bigint): void {
  if (typeof value !== 'bigint') throw new MoneyError('MINOR_MUST_BE_BIGINT');
  if (value < 0n || value > MAX_MINOR) throw new MoneyError('MINOR_OUT_OF_RANGE');
}

export function assertTipBps(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_TIP_BPS) {
    throw new MoneyError('INVALID_TIP_BPS');
  }
}

export function splitEqual(totalMinor: bigint, count: number): bigint[] {
  assertMinor(totalMinor);
  if (!Number.isSafeInteger(count) || count < 1 || count > MAX_SPLIT_COUNT) {
    throw new MoneyError('INVALID_SPLIT_COUNT');
  }

  const divisor = BigInt(count);
  const quotient = totalMinor / divisor;
  const remainder = totalMinor % divisor;

  return Array.from({ length: count }, (_, index) =>
    quotient + (BigInt(index) < remainder ? 1n : 0n),
  );
}

/** Pozitif tutarlarda half-up: yarım kuruş ve üstü bir sonraki kuruşa. */
export function tipFor(baseMinor: bigint, tipBps: number): bigint {
  assertMinor(baseMinor);
  assertTipBps(tipBps);
  const tipMinor =
    (baseMinor * BigInt(tipBps) + BPS_DENOMINATOR / 2n) / BPS_DENOMINATOR;
  assertMinor(tipMinor);
  return tipMinor;
}
