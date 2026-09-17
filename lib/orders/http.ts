import 'server-only';
import { NextResponse } from 'next/server';
import { ApiError } from './errors';
import { bigintJson } from './money';

export function jsonResponse(value: unknown, status: number, requestId: string): NextResponse {
  return new NextResponse(bigintJson(value), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'private, no-store, max-age=0',
      'Vary': 'Cookie, Origin',
      'X-Content-Type-Options': 'nosniff',
      'X-Request-Id': requestId,
    },
  });
}
export function failure(error: unknown, requestId: string): NextResponse {
  const safe = error instanceof ApiError
    ? error
    : new ApiError(500, 'INTERNAL_ERROR', 'İşlem tamamlanamadı.');
  // Token, cookie, telefon, ham payload veya SQL detaylarını loglama.
  if (safe.status >= 500)
    console.error(JSON.stringify({ event: 'order_api_error', requestId, code: safe.code }));
  const response = jsonResponse({
    error: { code: safe.code, message: safe.message, ...safe.details }, requestId,
  }, safe.status, requestId);
  if (safe.status === 503) response.headers.set('Retry-After', '1');
  return response;
}
