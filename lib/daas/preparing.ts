import 'server-only';
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { rawBody } from '../../src/daas/webhook';
import { uuid, record, minor, DaasError } from '../../src/daas/contracts';
type Json = null | boolean | number | string | Json[] | {
    [key: string]: Json | undefined;
};
type RpcDB = {
    ops: {
        Tables: Record<string, never>;
        Views: Record<string, never>;
        Enums: Record<string, never>;
        CompositeTypes: Record<string, never>;
        Functions: {
            daas_start_preparing: {
                Args: {
                    p_business_id: string;
                    p_branch_id: string;
                    p_order_id: string;
                    p_operation_id: string;
                    p_expected_revision: string;
                };
                Returns: Json;
            };
        };
    };
};
const known409 = new Set(['REVISION_CONFLICT', 'IDEMPOTENCY_CONFLICT', 'ORDER_NOT_ACCEPTED', 'DELIVERY_PLAN_REQUIRED',
    'FULFILLMENT_AUTHORIZATION_EXPIRED', 'COURIER_DISABLED', 'ORDERING_DISABLED']);
export async function startPreparingRoute(request: Request, orderId: string) {
    const rid = crypto.randomUUID();
    const respond = (data: unknown, status: number) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store', 'X-Request-Id': rid } });
    try {
        const url = process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
        if (!url || !key)
            throw new DaasError('SUPABASE_NOT_CONFIGURED');
        const store = await cookies();
        const sb = createServerClient<RpcDB>(url, key, { cookies: { getAll: () => store.getAll(), setAll: values => {
                    for (const c of values)
                        store.set(c.name, c.value, c.options);
                } } });
        const { data: { user }, error: authError } = await sb.auth.getUser();
        if (authError && (authError.status === 429 || (authError.status ?? 0) >= 500 || authError.name === 'AuthRetryableFetchError'))
            return respond({ error: 'AUTH_UNAVAILABLE' }, 503);
        if (authError || !user)
            return respond({ error: 'UNAUTHENTICATED' }, 401);
        // Authorization identity never comes from JSON or an untrusted wildcard host.
        const origin = new URL(request.url).origin;
        const mapping = record(JSON.parse(process.env.MENUGO_BRANCH_ORIGINS ?? '{}'));
        const entry = mapping[origin];
        if (!entry || request.headers.get('origin') !== origin || request.headers.get('sec-fetch-site') === 'cross-site')
            return respond({ error: 'ORIGIN_NOT_ALLOWED' }, 403);
        const tenant = record(entry);
        if (request.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json')
            return respond({ error: 'INVALID_CONTENT_TYPE' }, 415);
        const body = record(JSON.parse(new TextDecoder().decode(await rawBody(request, 2048))));
        if (Object.keys(body).some(k => !['operationId', 'expectedRevision'].includes(k)))
            return respond({ error: 'INVALID_INPUT' }, 400);
        const { data, error } = await sb.schema('ops').rpc('daas_start_preparing', {
            p_business_id: uuid(tenant.businessId), p_branch_id: uuid(tenant.branchId), p_order_id: uuid(orderId),
            p_operation_id: uuid(body.operationId), p_expected_revision: minor(body.expectedRevision)
        });
        if (error) {
            if (known409.has(error.message))
                return respond({ error: error.message }, 409);
            if (error.code === 'PT404')
                return respond({ error: 'ORDER_NOT_FOUND' }, 404);
            if (error.code === 'PT401')
                return respond({ error: 'UNAUTHENTICATED' }, 401);
            return respond({ error: 'COMMAND_UNAVAILABLE' }, 503);
        }
        return respond(data, 202);
    }
    catch (error) {
        if (error instanceof SyntaxError || error instanceof DaasError && error.code.startsWith('INVALID_'))
            return respond({ error: 'INVALID_INPUT' }, 400);
        if (error instanceof DaasError && error.code === 'BODY_TOO_LARGE')
            return respond({ error: 'BODY_TOO_LARGE' }, 413);
        return respond({ error: 'COMMAND_UNAVAILABLE' }, 503);
    }
}
