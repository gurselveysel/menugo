/** Same-origin, explicitly initiated and bounded AI requests. Never auto-retry. */
const legacyPath = /^\/api\/llm\/(status|settings|disconnect|test|ask|free-status|free-save|free-remove)$/;
const companyPath = /^\/api\/platform\/ai\/(context|status|free-status|free-save|free-remove|test)$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Validate a relative URL without consulting or changing the current origin. */
export function llmRequestPath(path: string): { path: string; inference: boolean } {
  if (typeof path !== 'string' || path.length > 700 || !path.startsWith('/api/') || /[\\\x00-\x20#]/.test(path)) {
    throw new Error('INVALID_LLM_REQUEST');
  }
  const u = new URL(path, 'https://relative-only.invalid');
  if (u.origin !== 'https://relative-only.invalid') throw new Error('INVALID_LLM_REQUEST');
  if (legacyPath.test(u.pathname)) {
    if (u.search) throw new Error('INVALID_LLM_REQUEST');
  } else if (companyPath.test(u.pathname)) {
    const keys = [...u.searchParams.keys()];
    if (u.pathname.endsWith('/context')) {
      if (keys.length) throw new Error('INVALID_LLM_REQUEST');
    } else {
      if (keys.length !== 2 || !keys.includes('businessId') || !keys.includes('branchId') ||
          !uuid.test(u.searchParams.get('businessId') ?? '') || !uuid.test(u.searchParams.get('branchId') ?? '')) {
        throw new Error('INVALID_LLM_REQUEST');
      }
    }
  } else {
    throw new Error('INVALID_LLM_REQUEST');
  }
  // Reject normalization such as traversals rather than silently rewriting them.
  if (u.pathname + u.search !== path) throw new Error('INVALID_LLM_REQUEST');
  return { path, inference: u.pathname.endsWith('/test') || u.pathname.endsWith('/ask') };
}

export async function llmApi<T = any>(path: string, data?: unknown): Promise<T> {
  const request = llmRequestPath(path);
  let response: Response;
  try {
    response = await fetch(request.path, {
      method: data === undefined ? 'GET' : 'POST',
      headers: data === undefined ? {} : { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
      body: data === undefined ? undefined : JSON.stringify(data),
      signal: AbortSignal.timeout(request.inference ? 75000 : 15000),
    });
  } catch {
    throw new Error(request.inference ? 'LLM_RESULT_UNKNOWN' : 'LLM_CONNECTION_UNAVAILABLE');
  }
  try {
    const value = await response.json();
    if (!response.ok) throw new Error(/^[A-Z0-9_]{1,80}$/.test(value?.error?.code) ? value.error.code : 'LLM_CONNECTION_UNAVAILABLE');
    return value as T;
  } catch (e) {
    if (e instanceof Error && /^[A-Z0-9_]{1,80}$/.test(e.message)) throw e;
    throw new Error(request.inference ? 'LLM_RESULT_UNKNOWN' : 'LLM_CONNECTION_UNAVAILABLE');
  }
}
