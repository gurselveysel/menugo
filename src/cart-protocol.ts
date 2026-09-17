/** JSON money is an integer string; no client-side price arithmetic is performed. */
export const PG_BIGINT_MAX = 9223372036854775807n;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export type Scope = Readonly<{
  businessId: string; branchId: string; checkId: string; userId: string;
}>;
export type Command = Readonly<{
  operationId: string; productId: string; delta: number; expectedRevision: string;
}>;
export type CartLine = Readonly<{
  cartLineId: string; productId: string; productName: string; quantity: number;
  unitPriceMinor: bigint; lineTotalMinor: bigint;
}>;
export type CartSnapshot = Readonly<{
  businessId: string; branchId: string; checkId: string; viewerUserId: string;
  channelId: string; revision: bigint; currency: 'TRY'; totalMinor: bigint;
  status: 'open' | 'checkout' | 'closed' | 'cancelled'; canMutate: boolean;
  lines: readonly CartLine[];
}>;
export type Receipt = Readonly<{ operationId: string; revision: bigint }>;
export class ProtocolError extends Error {
  constructor() { super('INVALID_SERVER_RESPONSE'); this.name = 'ProtocolError'; }
}
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly currentRevision?: bigint,
  ) { super(code); this.name = 'HttpError'; }
}
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ProtocolError();
  return value as Record<string, unknown>;
}
export function uuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw new ProtocolError();
  return value.toLowerCase();
}
export function integer(value: unknown): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9]\d{0,18})$/.test(value)) throw new ProtocolError();
  const result = BigInt(value);
  if (result > PG_BIGINT_MAX) throw new ProtocolError();
  return result;
}
export function scopeOf(scope: Scope): Scope {
  return Object.freeze({ businessId: uuid(scope.businessId), branchId: uuid(scope.branchId),
    checkId: uuid(scope.checkId), userId: uuid(scope.userId) });
}
export function readCommand(raw: unknown): Command {
  const v = object(raw);
  if (Object.keys(v).length !== 4 || typeof v.delta !== 'number' ||
      !Number.isSafeInteger(v.delta) || v.delta === 0 || Math.abs(v.delta) > 999) {
    throw new ProtocolError();
  }
  return Object.freeze({ operationId: uuid(v.operationId), productId: uuid(v.productId),
    delta: v.delta, expectedRevision: integer(v.expectedRevision).toString() });
}
export function readSnapshot(raw: unknown, scope: Scope): CartSnapshot {
  const v = object(raw);
  if (uuid(v.businessId) !== scope.businessId || uuid(v.branchId) !== scope.branchId ||
      uuid(v.checkId) !== scope.checkId || uuid(v.viewerUserId) !== scope.userId ||
      v.currency !== 'TRY' || typeof v.canMutate !== 'boolean' ||
      !['open', 'checkout', 'closed', 'cancelled'].includes(String(v.status)) ||
      !Array.isArray(v.lines) || v.lines.length > 100) throw new ProtocolError();
  const ids = new Set<string>();
  const lines = v.lines.map(rawLine => {
    const row = object(rawLine), id = uuid(row.cartLineId);
    if (ids.has(id) || typeof row.productName !== 'string' || !row.productName.trim() ||
        row.productName.length > 250 || typeof row.quantity !== 'number' ||
        !Number.isSafeInteger(row.quantity) || row.quantity < 1 || row.quantity > 999) {
      throw new ProtocolError();
    }
    ids.add(id);
    return Object.freeze({ cartLineId: id, productId: uuid(row.productId),
      productName: row.productName, quantity: row.quantity,
      unitPriceMinor: integer(row.unitPriceMinor), lineTotalMinor: integer(row.lineTotalMinor) });
  });
  // Do not recompute lineTotalMinor or totalMinor, even to populate the UI.
  return Object.freeze({ businessId: scope.businessId, branchId: scope.branchId,
    checkId: scope.checkId, viewerUserId: scope.userId, channelId: uuid(v.channelId),
    revision: integer(v.revision), currency: 'TRY', totalMinor: integer(v.totalMinor),
    status: v.status as CartSnapshot['status'], canMutate: v.canMutate, lines: Object.freeze(lines) });
}
export function readReceipt(raw: unknown, scope: Scope, command: Command): Receipt {
  const v = object(raw), revision = integer(v.revision);
  if (uuid(v.checkId) !== scope.checkId || uuid(v.operationId) !== command.operationId ||
      revision <= BigInt(command.expectedRevision)) throw new ProtocolError();
  // POST may contain an old cached cart. We only use its commit receipt/revision.
  return Object.freeze({ operationId: command.operationId, revision });
}
export function signalRevision(payload: unknown): bigint | null {
  try {
    const value = object(payload);
    return Object.keys(value).length === 1 ? integer(value.revision) : null;
  } catch { return null; }
}
export function fromHttp(status: number, body: unknown): HttpError {
  let code = 'HTTP_ERROR', revision: bigint | undefined;
  try {
    const e = object(object(body).error);
    if (typeof e.code === 'string' && /^[A-Z_]{1,80}$/.test(e.code)) code = e.code;
    if (e.currentRevision !== undefined) revision = integer(e.currentRevision);
  } catch { /* Never display arbitrary HTML, SQL detail or provider messages. */ }
  return new HttpError(status, code, revision);
}
/** These errors are returned before commit by Sprint 1's atomic RPC contract. */
export const ROLLED_BACK_CODES = new Set([
  'REVISION_CONFLICT', 'STALE_CHECK_REVISION', 'PRICE_CHANGED', 'CHECK_NOT_OPEN',
  'ORDERING_DISABLED', 'TABLE_INACTIVE', 'PRODUCT_NOT_ORDERABLE',
  'OPTIONS_NOT_SUPPORTED', 'INVALID_CATALOG_PRICE', 'CART_LINE_NOT_FOUND', 'PRODUCT_NOT_FOUND',
  'CART_EMPTY', 'QUANTITY_OUT_OF_RANGE', 'CART_LIMIT_EXCEEDED', 'AMOUNT_LIMIT_EXCEEDED',
]);
export const ACCESS_HTTP = new Set([401, 403, 404]);
