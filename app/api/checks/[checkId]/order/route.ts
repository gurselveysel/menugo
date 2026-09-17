import { requireUserClient } from '@/lib/supabase/route-client';
import { branchScope, emptyBody } from '@/lib/orders/request';
import { orderPreconditions, uuid } from '@/lib/orders/validation';
import { orderResult } from '@/lib/orders/money';
import { fromDatabaseError } from '@/lib/orders/errors';
import { failure, jsonResponse } from '@/lib/orders/http';
import type { CheckRouteContext } from '@/lib/orders/contracts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request, context: CheckRouteContext) {
  const requestId = crypto.randomUUID();
  try {
    const supabase = await requireUserClient();
    const scope = branchScope(request, process.env.MENUGO_BRANCH_ORIGINS);
    const checkId = uuid((await context.params).checkId, 'checkId');
    const input = orderPreconditions(request.headers);
    await emptyBody(request);

    // draft -> order_items -> unit charges -> clear cart -> submitted -> cached result.
    // Any error rolls the entire RPC back, including cart deletion and idempotency.
    const { data, error } = await supabase.schema('ops').rpc('order_submit', {
      p_business_id: scope.businessId,
      p_branch_id: scope.branchId,
      p_check_id: checkId,
      p_operation_id: input.operationId,
      p_expected_revision: input.expectedRevision,
    });
    if (error) throw fromDatabaseError(error);

    const result = orderResult(data, checkId, input.operationId);
    // A replay returns the original submitted result and the same 201 status.
    return jsonResponse(result, 201, requestId);
  } catch (error: unknown) {
    return failure(error, requestId);
  }
}
