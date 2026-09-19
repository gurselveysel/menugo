import {actor,client,rpc,json,failed,origin,scope,body,uuid,Failure} from '@/lib/api';
import {money} from '@/components/transport';
export const dynamic='force-dynamic';export const runtime='nodejs';
type Context={params:Promise<{action:string}>};
function text(v:unknown,max:number,optional=false){if(optional&&v===undefined)return '';if(typeof v!=='string'||v.length>max)throw new Failure('INVALID_INPUT');return v;}
export async function GET(req:Request,ctx:Context){try{origin(req);const{action}=await ctx.params;
 if(action==='availability')return json(await rpc(await client(),'service_availability',scope));
 if(action==='profile')return json(await rpc(await client(),'merchant_profile',scope));
 if(action==='product-information')return json(await rpc(await client(),'product_information_read',{...scope,p_admin:false}));
 const{s}=await actor();
 if(action==='pause')return json(await rpc(s,'service_pause',scope));
 if(action==='feedback')return json(await rpc(s,'feedback_inbox',scope));
 if(action==='daily-report'){const day=new URL(req.url).searchParams.get('day');if(day&&(!/^\d{4}-\d{2}-\d{2}$/.test(day)||Number.isNaN(Date.parse(day+'T00:00:00Z'))||new Date(day+'T00:00:00Z').toISOString().slice(0,10)!==day))throw new Failure('INVALID_REPORT_DAY');return json(await rpc(s,'daily_service_report',{...scope,p_day:day}));}
 if(action==='table-policy')return json(await rpc(s,'table_ordering_policy',{...scope,p_mode:null}));
 if(action==='readiness')return json(await rpc(s,'handover_readiness',scope));
 if(action==='table-requests')return json(await rpc(s,'table_entry_pending',scope));
 if(action==='service-dashboard')return json(await rpc(s,'service_dashboard',scope));
 if(action==='linked-visits')return json(await rpc(s,'linked_guest_visits',scope));
 if(action==='product-editor')return json(await rpc(s,'product_information_read',{...scope,p_admin:true}));
 if(action==='service-control')return json(await rpc(s,'service_control',{...scope,p_value:null}));
 if(action==='snapshot')return json(await rpc(s,'merchant_manage',{...scope,p_action:'snapshot',p_payload:{}}));
 if(action==='visits')return json(await rpc(s,'my_visits',scope));
 if(action==='orders')return json(await rpc(s,'customer_orders',{...scope,p_check_id:uuid(new URL(req.url).searchParams.get('check'))}));
 if(action==='demand-waste')return json(await rpc(s,'demand_waste_snapshot',{...scope,p_lookback_days:28}));
 if(action==='multi-branch-menu')return json(await rpc(s,'multi_branch_snapshot',scope));
 throw new Failure('NOT_FOUND',404);
 }catch(e){return failed(e);}}
export async function POST(req:Request,ctx:Context){try{origin(req);const{action}=await ctx.params;
 if(action==='quote'){
  const b=await body(req);if(!Array.isArray(b.lines)||b.lines.length<1||b.lines.length>30)throw new Failure('INVALID_CART');
  const note=text(b.note,300,true).replace(/[\u0000-\u001f]/g,' ');
  const lines=b.lines.map((x:unknown)=>{if(!x||typeof x!=='object'||Array.isArray(x))throw new Failure('INVALID_CART');const l=x as Record<string,unknown>;if(!Number.isInteger(l.quantity)||Number(l.quantity)<1||Number(l.quantity)>20)throw new Failure('INVALID_QUANTITY');const choice=l.option===undefined?undefined:text(l.option,100);return {productId:uuid(l.productId),quantity:l.quantity,...(choice?{option:choice}:{})};});
  const quote=await rpc(await client(),'whatsapp_quote',{...scope,p_lines:lines});
  if(!quote||!Array.isArray(quote.lines)||!/^[1-9][0-9]{7,14}$/.test(quote.phone))throw new Failure('QUOTE_UNAVAILABLE',503);
  const message=['Merhaba, Meşhur Sarıyer Börekçisi Sandviç Bahçeşehir için sipariş talebim:',...quote.lines.map((l:any)=>`${l.quantity} × ${l.name}${l.option?' ('+l.option+')':''} — ${money(l.lineTotalMinor)}`),'Ürün toplamı: '+money(quote.totalMinor),...(note?['Not: '+note]:[]),'Ürün uygunluğunu, teslimat/gel-al durumunu ve varsa teslimat ücretini teyit eder misiniz?'].join('\n');
  return json({...quote,url:'https://wa.me/'+quote.phone+'?text='+encodeURIComponent(message)});
 }
 const{s}=await actor();
 if(action==='claim')return json(await rpc(s,'staff_bootstrap',scope));
 const b=await body(req);
 if(action==='multi-branch-menu'){
  const command=String(b.command??'');if(!['create-master','bind-product','set-master-price','set-local-price','clear-local-price'].includes(command)||!b.payload||typeof b.payload!=='object'||Array.isArray(b.payload))throw new Failure('INVALID_INPUT');
  return json(await rpc(s,'multi_branch_manage',{...scope,p_operation_id:uuid(b.operationId),p_action:command,p_payload:b.payload}));
 }
 if(action==='pause'){if(!Number.isInteger(b.minutes)||![0,15,30,60].includes(Number(b.minutes))||typeof b.version!=='string'||!/^\d{1,18}$/.test(b.version))throw new Failure('INVALID_INPUT');return json(await rpc(s,'service_pause',{...scope,p_minutes:b.minutes,p_version:b.version}));}
 if(action==='feedback')return json(await rpc(s,'feedback_inbox',{...scope,p_review_id:uuid(b.id)}));
 if(action==='table-policy'){if(!['direct','staff_approved'].includes(String(b.mode)))throw new Failure('INVALID_INPUT');return json(await rpc(s,'table_ordering_policy',{...scope,p_mode:b.mode}));}
 if(action==='reject-order'){if(typeof b.note!=='string'||!b.note.trim()||b.note.length>300)throw new Failure('REASON_REQUIRED');return json(await rpc(s,'reject_submitted_order',{...scope,p_order_id:uuid(b.orderId),p_note:b.note.trim()}));}
 if(action==='table-decision'){if(typeof b.approve!=='boolean'||typeof b.code!=='string'||(b.approve&&!/^[0-9]{4}$/.test(b.code)))throw new Failure('INVALID_INPUT');return json(await rpc(s,'table_entry_decide',{...scope,p_request_id:uuid(b.id),p_code:b.code,p_approve:b.approve}));}
 if(action==='close-empty')return json(await rpc(s,'close_empty_check',{...scope,p_check_id:uuid(b.checkId)}));
 if(action==='end-guest')return json(await rpc(s,'guest_revoke',{...scope,p_check_id:uuid(b.checkId),p_guest_id:uuid(b.guestId)}));
 if(action==='save-information')return json(await rpc(s,'product_information_save',{...scope,p_product_id:uuid(b.productId),p_value:b.value}));
 if(action==='service-control')return json(await rpc(s,'service_control',{...scope,p_value:b}));
 if(action==='decide-cancellation'){if(typeof b.approve!=='boolean'||typeof b.note!=='string'||!b.note.trim()||b.note.length>300)throw new Failure('INVALID_INPUT');return json(await rpc(s,'decide_cancellation',{...scope,p_id:uuid(b.id),p_approve:b.approve,p_note:b.note}));}
 if(action==='request-service'){if(!['waiter','bill'].includes(String(b.kind)))throw new Failure('INVALID_SERVICE_REQUEST');return json(await rpc(s,'request_service',{...scope,p_check_id:uuid(b.checkId),p_kind:b.kind}));}
 if(action==='record-waste'){
  if(typeof b.productId!=='string'||!/^[A-Za-z0-9._:-]{1,100}$/.test(b.productId)||!Number.isInteger(b.quantityMilli)||Number(b.quantityMilli)<1||Number(b.quantityMilli)>999000||!['prep','spoilage','return','other'].includes(String(b.reason)))throw new Failure('INVALID_WASTE_EVENT');
  return json(await rpc(s,'record_waste_event',{...scope,p_product_source_id:b.productId,p_quantity_milli:b.quantityMilli,p_reason:b.reason,p_client_request_id:uuid(b.operationId)}));
 }
 if(!['save-profile','invite-staff','revoke-invite','revoke-staff','resolve-request'].includes(action))throw new Failure('NOT_FOUND',404);
 if(action==='invite-staff'){text(b.email,254);text(b.name,80);if(!['manager','waiter','kitchen','cashier'].includes(String(b.role)))throw new Failure('INVALID_ROLE');}
 if(['revoke-invite','revoke-staff','resolve-request'].includes(action))uuid(b.id);
 return json(await rpc(s,'merchant_manage',{...scope,p_action:action,p_payload:b}));
 }catch(e){return failed(e);}}
