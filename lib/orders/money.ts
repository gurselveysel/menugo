import { ApiError } from './errors';
import { integerString, record, uuid } from './validation';
import type { CartResult, OrderResult } from './contracts';

export function minor(value: unknown): bigint {
  return BigInt(integerString(value, 'minor'));
}
export function bigintJson(value: unknown): string {
  return JSON.stringify(value, (_key, current: unknown) =>
    typeof current === 'bigint' ? current.toString() : current);
}
export function formatTry(value: bigint): string {
  if (value < 0n) throw new RangeError('Negative money');
  const major = (value / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${major},${(value % 100n).toString().padStart(2, '0')} ₺`;
}
function quantity(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > 999)
    throw new Error('Invalid quantity');
  return value;
}
function name(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 250)
    throw new Error('Invalid product name');
  return value;
}
function base(raw: unknown, checkId: string, operationId: string) {
  const data = record(raw);
  if (data.checkId !== checkId || data.operationId !== operationId || data.currency !== 'TRY' ||
      !Array.isArray(data.lines) || data.lines.length > 100)
    throw new Error('Unexpected RPC result');
  return data;
}

export function cartResult(raw: unknown, checkId: string, operationId: string): CartResult {
  try {
    const data = base(raw, checkId, operationId);
    const lines = (data.lines as unknown[]).map(value => {
      const row = record(value);
      const line = {
        cartLineId: uuid(row.cartLineId), productId: uuid(row.productId),
        productName: name(row.productName), quantity: quantity(row.quantity),
        unitPriceMinor: minor(row.unitPriceMinor), lineTotalMinor: minor(row.lineTotalMinor),
      };
      if (line.lineTotalMinor !== line.unitPriceMinor * BigInt(line.quantity))
        throw new Error('Line amount mismatch');
      return line;
    });
    const totalMinor = minor(data.totalMinor);
    if (lines.reduce((total, line) => total + line.lineTotalMinor, 0n) !== totalMinor)
      throw new Error('Cart amount mismatch');
    return { checkId, operationId, currency: 'TRY', revision: minor(data.revision), totalMinor, lines };
  } catch {
    throw new ApiError(500, 'INVALID_RPC_RESULT', 'Sunucu yanıtı doğrulanamadı.');
  }
}

export function orderResult(raw: unknown, checkId: string, operationId: string): OrderResult {
  try {
    const data = base(raw, checkId, operationId);
    if (data.status !== 'submitted' || (data.lines as unknown[]).length === 0)
      throw new Error('Unexpected order status');
    const lines = (data.lines as unknown[]).map(value => {
      const row = record(value);
      const line = {
        orderItemId: uuid(row.orderItemId), productId: uuid(row.productId),
        productName: name(row.productName), quantity: quantity(row.quantity),
        unitPriceMinor: minor(row.unitPriceMinor), discountMinor: minor(row.discountMinor),
        grossMinor: minor(row.grossMinor), netMinor: minor(row.netMinor),
      };
      if (line.grossMinor !== line.unitPriceMinor * BigInt(line.quantity) ||
          line.netMinor !== line.grossMinor - line.discountMinor)
        throw new Error('Order line mismatch');
      return line;
    });
    const chargeCount = lines.reduce((total, line) => total + line.quantity, 0);
    const totalMinor = minor(data.totalMinor);
    if (data.chargeCount !== chargeCount || chargeCount > 500 ||
        lines.reduce((total, line) => total + line.netMinor, 0n) !== totalMinor)
      throw new Error('Order total mismatch');
    return { checkId, operationId, orderId: uuid(data.orderId), revision: minor(data.revision),
      status: 'submitted', currency: 'TRY', totalMinor, chargeCount, lines };
  } catch {
    throw new ApiError(500, 'INVALID_RPC_RESULT', 'Sunucu yanıtı doğrulanamadı.');
  }
}
