import { daasRuntime } from '../../../../../lib/daas/runtime';
import { receiveWebhook } from '../../../../../src/daas/webhook';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;
export async function POST(request: Request, context: {
    params: Promise<{
        accountId: string;
    }>;
}) {
    try {
        const deps = daasRuntime();
        const { accountId } = await context.params;
        return await receiveWebhook(request, accountId, { repo: deps.repo, providers: deps.providers,
            log: code => deps.log({ code }) });
    }
    catch {
        return Response.json({ error: 'TEMPORARILY_UNAVAILABLE' }, { status: 503, headers: { 'Cache-Control': 'no-store', 'Retry-After': '15' } });
    }
}
