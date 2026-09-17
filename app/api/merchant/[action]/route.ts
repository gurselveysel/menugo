import {actor,client,rpc,json,failed,origin,scope,body,uuid,Failure} from '@/lib/api';
import {money} from '@/components/transport';
export const dynamic='force-dynamic';export const runtime='nodejs';
type Context={params:Promise<{action:string}>};
function text(v:unknown,max:number,optional=false){if(optional&&v===undefined)return '';if(typeof v!=='string'||v.length>max)throw new Failure('INVALID_INPUT');return v;}
export async function GET(req:Request,ctx:Context){try{origin(req);const{action}=await ctx.params;
 if(action==='profile')return json(await rpc(await client(),'merchant_profile',scope));
 const{s}=await actor();
 if(action==='snapshot')return json(await rpc(s,'merchant_manage',{...scope,p_action:'snapshot',p_payload:{}}));
 if(action==='visits')return json(await rpc(s,'my_visits',scope));
 if(action==='orders')return json(await rpc(s,'customer_orders',{...scope,p_check_id:uuid(new URL(req.url).searchParams.get('check'))}));
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
 if(action==='request-service'){if(!['waiter','bill'].includes(String(b.kind)))throw new Failure('INVALID_SERVICE_REQUEST');return json(await rpc(s,'request_service',{...scope,p_check_id:uuid(b.checkId),p_kind:b.kind}));}
 if(!['save-profile','invite-staff','revoke-invite','revoke-staff','resolve-request'].includes(action))throw new Failure('NOT_FOUND',404);
 if(action==='invite-staff'){text(b.email,254);text(b.name,80);if(!['manager','waiter','kitchen','cashier'].includes(String(b.role)))throw new Failure('INVALID_ROLE');}
 if(['revoke-invite','revoke-staff','resolve-request'].includes(action))uuid(b.id);
 return json(await rpc(s,'merchant_manage',{...scope,p_action:action,p_payload:b}));
 }catch(e){return failed(e);}}
