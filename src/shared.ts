export const MAX_I64 = 9_223_372_036_854_775_807n;
export class DomainError extends Error {
  constructor(readonly code: string, cause?: unknown) {
    super(code, cause === undefined ? undefined : { cause });
    this.name = 'DomainError';
  }
}
export function fail(code: string): never { throw new DomainError(code); }
export function minor(value: bigint, positive = false): bigint {
  if (typeof value !== 'bigint' || value < (positive ? 1n : 0n) || value > MAX_I64)
    fail('INVALID_MINOR');
  return value;
}
export function bps(value: bigint): bigint {
  if (typeof value !== 'bigint' || value < 0n || value > 10000n) fail('INVALID_BPS');
  return value;
}
export function earned(minorValue: bigint, rateBps: bigint): bigint {
  return minor(minor(minorValue) * bps(rateBps) / 10000n); // floor, no over-awarding
}
export function uuid(value: string): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value))
    fail('INVALID_UUID');
  return value.toLowerCase();
}
export function stableKey(value: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9:_-]{1,160}$/.test(value)) fail('INVALID_SOURCE_KEY');
  return value;
}
export function json(value: unknown): string {
  return JSON.stringify(value, (_, v: unknown) => typeof v === 'bigint' ? v.toString() : v);
}
