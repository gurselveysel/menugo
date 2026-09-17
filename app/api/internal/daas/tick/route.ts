import { daasRuntime } from '../../../../../lib/daas/runtime';
import { authorizedTick } from '../../../../../src/daas/webhook';
import { runTick } from '../../../../../src/daas/worker';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;
async function tick(request: Request) {
    if (!authorizedTick(request, process.env.MENUGO_DAAS_TICK_SECRET))
        return new Response(null, { status: 401, headers: { 'Cache-Control': 'no-store' } });
    try {
        // Budget limits new claims, not just batch size. Outer maxDuration is still bounded.
        return Response.json(await runTick(daasRuntime(), 12000, 6), { headers: { 'Cache-Control': 'no-store' } });
    }
    catch {
        return Response.json({ error: 'WORKER_UNAVAILABLE' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
    }
}
export const POST = tick;
// Optional GET only for a scheduler whose contract sends authenticated GET.
// Vercel Cron uses CRON_SECRET; map that value explicitly or use POST from another scheduler.
export const GET = tick;
