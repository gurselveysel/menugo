import { requireUserClient } from '@/lib/supabase/route-client';
import { branchScope, jsonBody } from '@/lib/orders/request';
import { cartInput, uuid } from '@/lib/orders/validation';
import { cartResult } from '@/lib/orders/money';
import { fromDatabaseError } from '@/lib/orders/errors';
import { failure, jsonResponse } from '@/lib/orders/http';
import type { CheckRouteContext } from '@/lib/orders/contracts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request, context: CheckRouteContext) {
  const requestId = crypto.randomUUID();
  try {
    // No catalog/check reads or mutations before authenticated session verification.
    const supabase = await requireUserClient();
    const scope = branchScope(request, process.env.MENUGO_BRANCH_ORIGINS);
    const checkId = uuid((await context.params).checkId, 'checkId');
    const input = cartInput(await jsonBody(request));

    // ONE transaction. lock_check is called INSIDE cart_mutate.
    const { data, error } = await supabase.schema('ops').rpc('cart_mutate_choice', {
      p_business_id: scope.businessId,
      p_branch_id: scope.branchId,
      p_check_id: checkId,
      p_operation_id: input.operationId,
      p_product_id: input.productId,
      p_delta: input.delta,p_option:input.option??null,
      p_expected_revision: input.expectedRevision,
    });
    if (error) throw fromDatabaseError(error);

    // RPC wire strings -> TypeScript bigint -> JSON strings, without Number conversion.
    const result = cartResult(data, checkId, input.operationId);
    return jsonResponse(result, 200, requestId);
  } catch (error: unknown) {
    return failure(error, requestId);
  }
}

export async function GET(request:Request,context:CheckRouteContext){const api=await import('@/lib/api');try{
 api.origin(request);const {s}=await api.actor();const id=uuid((await context.params).checkId,'checkId');
 return api.json(await api.rpc(s,'get_cart_snapshot',{...api.scope,p_check_id:id}));
}catch(error){return api.failed(error);}}
