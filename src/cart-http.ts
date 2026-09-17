import { fromHttp, HttpError, ProtocolError, type Command } from './cart-protocol';
const MAX_RESPONSE_BYTES = 512 * 1024;

/** All requests are same-origin. Timeout covers body reading, not just response headers. */
export function createCartHttp(checkId: string, fetcher: typeof fetch = fetch, timeoutMs = 12000) {
  const url = `/api/checks/${encodeURIComponent(checkId)}/cart`;
  async function request(method: 'GET' | 'POST', signal: AbortSignal, body?: Command): Promise<unknown> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, timeoutMs);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let responseStatus: number | undefined;
    try {
      const response = await fetcher(url, {
        method, body: body ? JSON.stringify(body) : undefined,
        credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error',
        headers: body ? { Accept: 'application/json', 'Content-Type': 'application/json' }
          : { Accept: 'application/json' },
        signal: controller.signal,
      });
      responseStatus = response.status;
      const length = Number(response.headers.get('content-length') ?? '0');
      if (length > MAX_RESPONSE_BYTES) throw new ProtocolError();
      reader = response.body?.getReader();
      if (!reader) throw response.ok ? new ProtocolError() : fromHttp(response.status, null);
      const decoder = new TextDecoder('utf-8', { fatal: true });
      let total = 0, text = '';
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        total += next.value.byteLength; // Byte count, NOT money.
        if (total > MAX_RESPONSE_BYTES) throw new ProtocolError();
        text += decoder.decode(next.value, { stream: true });
      }
      text += decoder.decode();
      let value: unknown;
      try { value = JSON.parse(text); }
      catch { throw response.ok ? new ProtocolError() : fromHttp(response.status, null); }
      if (!response.ok) throw fromHttp(response.status, value);
      if (!response.headers.get('content-type')?.toLowerCase().includes('application/json')) {
        throw new ProtocolError();
      }
      return value;
    } catch (error: unknown) {
      if (responseStatus !== undefined && (responseStatus < 200 || responseStatus >= 300)) {
        // An invalid/oversized error body must not hide an already-known 401/403/404.
        if (error instanceof HttpError) throw error;
        throw fromHttp(responseStatus, null);
      }
      throw error;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      try { await reader?.cancel(); } catch { /* Already closed or aborted. */ }
    }
  }
  return {
    snapshot: (signal: AbortSignal) => request('GET', signal),
    post: (command: Command, signal: AbortSignal) => request('POST', signal, command),
  };
}
