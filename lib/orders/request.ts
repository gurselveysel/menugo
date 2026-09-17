import { ApiError } from './errors';
import type { Scope } from './contracts';
import { record, uuid } from './validation';

/** Exact origin allowlist + server-owned tenant mapping. No wildcard / forwarded-host trust. */
export function branchScope(request: Request, serializedMap: string | undefined): Scope {
  if (!serializedMap) throw new ApiError(500, 'BRANCH_MAP_MISSING', 'Sunucu yapılandırması eksik.');
  let map: Record<string, unknown>;
  try { map = record(JSON.parse(serializedMap)); }
  catch { throw new ApiError(500, 'BRANCH_MAP_INVALID', 'Sunucu yapılandırması geçersiz.'); }
  const origin = new URL(request.url).origin;
  if (!Object.hasOwn(map, origin))
    throw new ApiError(421, 'UNMAPPED_HOST', 'Bu adres bir sipariş şubesine bağlı değil.');
  if (request.headers.get('origin') !== origin ||
      ['cross-site', 'same-site'].includes(request.headers.get('sec-fetch-site') ?? ''))
    throw new ApiError(403, 'ORIGIN_REJECTED', 'İstek kaynağı doğrulanamadı.');
  try {
    const scope = record(map[origin]);
    return { businessId: uuid(scope.businessId), branchId: uuid(scope.branchId) };
  } catch {
    throw new ApiError(500, 'BRANCH_MAP_INVALID', 'Şube yapılandırması geçersiz.');
  }
}

export async function boundedText(request: Request, limit = 2048): Promise<string> {
  if (request.headers.get('content-encoding') && request.headers.get('content-encoding') !== 'identity')
    throw new ApiError(415, 'CONTENT_ENCODING_UNSUPPORTED', 'Sıkıştırılmış istek gövdesi desteklenmiyor.');
  const claimed = request.headers.get('content-length');
  if (claimed !== null && (!/^\d+$/.test(claimed) || BigInt(claimed) > BigInt(limit)))
    throw new ApiError(413, 'BODY_TOO_LARGE', 'İstek gövdesi çok büyük.');
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new ApiError(413, 'BODY_TOO_LARGE', 'İstek gövdesi çok büyük.');
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new ApiError(400, 'INVALID_UTF8', 'Geçersiz metin kodlaması.'); }
}
export async function jsonBody(request: Request): Promise<unknown> {
  const contentType = request.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
  if (contentType !== 'application/json')
    throw new ApiError(415, 'JSON_REQUIRED', 'Content-Type: application/json gerekli.');
  const text = await boundedText(request);
  try { return JSON.parse(text) as unknown; }
  catch { throw new ApiError(400, 'INVALID_JSON', 'Geçerli bir JSON gövdesi gönderin.'); }
}
export async function emptyBody(request: Request): Promise<void> {
  if ((await boundedText(request)).trim())
    throw new ApiError(400, 'ORDER_BODY_NOT_ALLOWED', 'Sipariş isteğinde gövde gönderilmemeli.');
}
