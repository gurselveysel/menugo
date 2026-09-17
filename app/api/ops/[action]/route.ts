import {actor,rpc,json,failed,origin,scope,body,uuid,revision,Failure} from '@/lib/api';
import {getRecommendations,recommendationDto,type UpsellRule} from '@/src/marketing/upsell';
export const dynamic='force-dynamic';export const runtime='nodejs';
export async function GET(req:Request,ctx:{params:Promise<{action:string}>}){try{origin(req);const{s}=await actor();const{action}=await ctx.params;const id=new URL(req.url).searchParams.get('check');
 if(action==='console')return json(await rpc(s,'operator_snapshot',scope));
 if(action==='counter-info')return json(await rpc(s,'counter_info',{...scope,p_check_id:uuid(id)}));
 if(action==='wallet')return json(await rpc(s,'wallet_snapshot',scope));
 if(action==='payment-quote'){const u=new URL(req.url);const tip=Number(u.searchParams.get('tip')??'0');if(![0,500,1000,1500].includes(tip))throw new Failure('INVALID_TIP');return json(await rpc(s,'payment_quote',{...scope,p_check_id:uuid(id),p_share_id:uuid(u.searchParams.get('share')),p_tip_bps:tip}));}
 if(action==='checkout')return json(await rpc(s,'checkout_snapshot',{...scope,p_check_id:uuid(id)}));
 if(action==='recommendations'){const checkId=uuid(id);const cart=await rpc(s,'get_cart_snapshot',{...scope,p_check_id:checkId});const rules=await rpc(s,'upsell_input',{...scope,p_check_id:checkId});
 const typed=(rules as any[]).map(r=>({...r,weightBps:BigInt(r.weightBps),confidenceBps:BigInt(r.confidenceBps),marginScoreBps:BigInt(r.marginScoreBps),recommended:{...r.recommended,priceMinor:r.recommended.priceMinor===null?null:BigInt(r.recommended.priceMinor),stockScoreBps:BigInt(r.recommended.stockScoreBps)}})) as UpsellRule[];
 return json(getRecommendations(cart.lines.map((x:any)=>({businessId:scope.p_business_id,branchId:scope.p_branch_id,productId:x.productId,quantity:x.quantity})),typed).map(recommendationDto));}
 throw new Failure('NOT_FOUND',404);
}catch(e){return failed(e);}}
export async function POST(req:Request,ctx:{params:Promise<{action:string}>}){try{origin(req);const{s}=await actor();const{action}=await ctx.params;const data=await body(req);
 if(['save-product','dine-in','cancel-split','close-empty'].includes(action))return json(await rpc(s,'manage_pilot',{...scope,p_action:action,p_payload:data}));
 if(action==='counter-close'){if(typeof data.amountMinor!=='string'||!/^[1-9][0-9]{0,18}$/.test(data.amountMinor)||BigInt(data.amountMinor)>9223372036854775807n)throw new Failure('INVALID_AMOUNT');if(!['cash','external_pos'].includes(String(data.method)))throw new Failure('INVALID_METHOD');if(data.reference!=null&&(typeof data.reference!=='string'||data.reference.length>100))throw new Failure('INVALID_REFERENCE');return json(await rpc(s,'counter_close',{...scope,p_check_id:uuid(data.checkId),p_operation_id:uuid(data.operationId),p_expected_revision:revision(data.expectedRevision),p_amount_minor:data.amountMinor,p_method:data.method,p_reference:data.reference??null}));}
 if(action==='start-table')return json(await rpc(s,'start_table',{...scope,p_table_id:uuid(data.tableId)}));
 if(action==='join'){if(typeof data.token!=='string'||!/^[0-9a-f]{64}$/.test(data.token))throw new Failure('INVALID_TOKEN');return json(await rpc(s,'join_table',{...scope,p_check_id:uuid(data.checkId),p_token:data.token}));}
 if(action==='split'){const mode=data.mode;if(mode!=='equal'&&mode!=='items')throw new Failure('INVALID_MODE');if(!Array.isArray(data.payers)||data.payers.length>16)throw new Failure('INVALID_PAYERS');
 return json(await rpc(s,'prepare_split',{...scope,p_check_id:uuid(data.checkId),p_operation_id:uuid(data.operationId),p_expected_revision:revision(data.expectedRevision),p_mode:mode,p_payers:data.payers.map(uuid),p_assignments:data.assignments??{}}));}
 if(action==='payment'){if(![0,500,1000,1500].includes(data.tipBps as number))throw new Failure('INVALID_TIP');return json(await rpc(s,'reserve_payment',{...scope,p_check_id:uuid(data.checkId),p_share_id:uuid(data.shareId),p_operation_id:uuid(data.operationId),p_tip_bps:data.tipBps}));}
 if(action==='consent'){if(!['denied','revoked'].includes(String(data.decision)))throw new Failure('VERIFIED_CONSENT_FLOW_REQUIRED',409);
 return json(await rpc(s,'crm_set_consent',{...scope,p_customer_id:uuid(data.customerId),p_decision:data.decision,p_text_version:'preference-revocation-v1',p_evidence_ref:'authenticated:'+crypto.randomUUID()}));}
 if(action==='loyalty-reserve')throw new Failure('PAYMENT_EVIDENCE_ADAPTER_REQUIRED',409);
 if(action==='delivery-dispatch')throw new Failure('COURIER_PROVIDER_NOT_CONFIGURED',409);
 if(['order-status','create-table','save-campaign','save-rule'].includes(action))return json(await rpc(s,'console_action',{...scope,p_action:action,p_payload:data}));
 throw new Failure('NOT_FOUND',404);
}catch(e){return failed(e);}}
