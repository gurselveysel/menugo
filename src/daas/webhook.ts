import { timingSafeEqual, createHash } from 'node:crypto';
import { DaasError, SignatureError, uuid, readEvent, type DaasRepository, type ProviderRegistry } from './contracts.js';
import { bounded } from './policy.js';
export async function rawBody(request: Request, limit = 65536): Promise<Uint8Array> {
    const declared = request.headers.get('content-length');
    if (declared !== null && (!/^\d+$/.test(declared) || BigInt(declared) > BigInt(limit)))
        throw new DaasError('BODY_TOO_LARGE');
    if (!request.body)
        return new Uint8Array();
    const reader = request.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    let aborted = false;
    const cancel = () => { aborted = true; void reader.cancel().catch(() => { }); };
    request.signal.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(cancel, 5000);
    if (request.signal.aborted)
        cancel();
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (aborted)
                throw new DaasError('BODY_TIMEOUT');
            if (done)
                break;
            size += value.length;
            if (size > limit)
                throw new DaasError('BODY_TOO_LARGE');
            chunks.push(value);
        }
        const bytes = new Uint8Array(size);
        let i = 0;
        for (const chunk of chunks) {
            bytes.set(chunk, i);
            i += chunk.length;
        }
        return bytes;
    }
    finally {
        clearTimeout(timer);
        request.signal.removeEventListener('abort', cancel);
        void reader.cancel().catch(() => { });
        reader.releaseLock();
    }
}
export function authorizedTick(request: Request, secret: string | undefined): boolean {
    if (!secret || secret.length < 32 || secret.length > 1024)
        return false;
    // Hash to equal length before constant-time comparison. No prefix/length leaks.
    const hash = (s: string) => createHash('sha256').update(s).digest();
    return timingSafeEqual(hash(request.headers.get('authorization') ?? ''), hash(`Bearer ${secret}`));
}
export async function receiveWebhook(request: Request, accountId: string, deps: {
    repo: DaasRepository;
    providers: ProviderRegistry;
    log: (code: string) => void;
}): Promise<Response> {
    try {
        if (request.method !== 'POST')
            return new Response(null, { status: 405, headers: { Allow: 'POST' } });
        const account = await deps.repo.getWebhookAccount(uuid(accountId));
        if (!account || !account.acceptWebhooks)
            return new Response(null, { status: 404 });
        const adapter = deps.providers.resolve(account);
        if (adapter.provider !== account.provider || adapter.environment !== account.environment)
            throw new DaasError('PROVIDER_BINDING_INVALID');
        const raw = await rawBody(request);
        // request.json() is deliberately NOT called before signature verification.
        const event = readEvent(await bounded(signal => adapter.verifyWebhook(account, raw, request.headers, signal)));
        const accepted = await deps.repo.acceptWebhook(account, event, createHash('sha256').update(raw).digest('hex'));
        const response = adapter.acknowledge(accepted.duplicate);
        response.headers.set('Cache-Control', 'no-store');
        return response;
    }
    catch (error: unknown) {
        const code = error instanceof DaasError && /^[A-Z0-9_]{1,80}$/.test(error.code) ? error.code : 'WEBHOOK_STORAGE_UNAVAILABLE';
        deps.log(code); // no raw body, secret, phone or external exception text
        const status = error instanceof SignatureError ? 401 :
            code === 'BODY_TOO_LARGE' ? 413 : code === 'BODY_TIMEOUT' ? 408 :
                code === 'EVENT_ID_REUSED' ? 409 : code.startsWith('INVALID_') ? 400 : 503;
        return Response.json({ error: status === 503 ? 'TEMPORARILY_UNAVAILABLE' : 'WEBHOOK_REJECTED' }, { status, headers: { 'Cache-Control': 'no-store' } });
    }
}
