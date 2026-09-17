import { ApiError } from './errors';
import { PG_BIGINT_MAX, type CartInput } from './contracts';

export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new ApiError(400, 'INVALID_BODY', 'JSON nesnesi bekleniyor.');
  return value as Record<string, unknown>;
}
export function uuid(value: unknown, field = 'id'): string {
  if (typeof value !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) ||
      /^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(value)) {
    throw new ApiError(400, 'INVALID_UUID', `${field} geçerli bir UUID olmalı.`);
  }
  return value.toLowerCase();
}
export function integerString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^(0|[1-9]\d{0,18})$/.test(value) || BigInt(value) > PG_BIGINT_MAX)
    throw new ApiError(400, 'INVALID_INTEGER_STRING', `${field} BIGINT aralığında tam sayı metni olmalı.`);
  return value;
}
export function cartInput(value: unknown): CartInput {
  const input = record(value);
  const allowed = ['operationId', 'productId', 'delta', 'expectedRevision'];
  if (Object.keys(input).some(key => !allowed.includes(key)) || Object.keys(input).length !== 4)
    throw new ApiError(400, 'UNEXPECTED_FIELDS', 'Yalnızca operationId, productId, delta ve expectedRevision gönderin.');
  if (typeof input.delta !== 'number' || !Number.isSafeInteger(input.delta) ||
      input.delta === 0 || input.delta < -999 || input.delta > 999)
    throw new ApiError(400, 'INVALID_DELTA', 'delta, sıfır olmayan -999…999 aralığında tam sayı olmalı.');
  return {
    operationId: uuid(input.operationId, 'operationId'),
    productId: uuid(input.productId, 'productId'),
    delta: input.delta,
    expectedRevision: integerString(input.expectedRevision, 'expectedRevision'),
  };
}
/** Bodyless order requests still carry a stable key and a reviewed cart revision. */
export function orderPreconditions(headers: Headers): {
  operationId: string;
  expectedRevision: string;
} {
  const key = headers.get('idempotency-key');
  const etag = headers.get('if-match');
  if (!key || !etag)
    throw new ApiError(428, 'PRECONDITION_REQUIRED', 'Idempotency-Key ve If-Match başlıkları gerekli.');
  const match = /^"(0|[1-9]\d{0,18})"$/.exec(etag);
  if (!match)
    throw new ApiError(400, 'INVALID_IF_MATCH', 'If-Match, örneğin "12" biçiminde tek bir güçlü revizyon etiketi olmalı.');
  return {
    operationId: uuid(key, 'Idempotency-Key'),
    expectedRevision: integerString(match[1], 'If-Match'),
  };
}
