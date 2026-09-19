// Native PostgreSQL only, receives the two disposable CI connections. Never a live DB URL.
import assert from 'node:assert/strict';
export async function publicationConcurrency(a,b){
 const business='11111111-1111-4111-8111-111111111111',branch='22222222-2222-4222-8222-222222222222',owner='33333333-3333-4333-8333-333333333331';
 const op=n=>`77777777-7777-4777-8777-${String(n).padStart(12,'0')}`;
 for(const c of[a,b]){await c.query('reset role');await c.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:owner,role:'authenticated'})]);await c.query('set role authenticated');}
 const studio=async(action,id=null,payload={})=>(await a.query('select ops.studio_job($1,$2,$3,$4,$5::jsonb) j',[business,branch,action,id,JSON.stringify(payload)])).rows[0].j;
 const pub=async(conn,action,payload)=>(await conn.query('select ops.studio_text_publication($1,$2,$3,$4::jsonb) j',[business,branch,action,JSON.stringify(payload)])).rows[0].j;
 const catalogue=(await a.query('select ops.catalogue($1,$2) j',[business,branch])).rows[0].j;
 const product=catalogue.items[0].id;
 async function prepare(n){
  const j=await studio('create',null,{operationId:op(n),kind:'product-copy',input:{productId:product,language:'tr',style:'white'}}),c=await studio('claim',j.id);
  await studio('finish',j.id,{lease:c.lease,model:'TEST-NO-MODEL',draft:{kind:'product-copy',draftOnly:true,title:'TEST',body:'Reviewed synthetic text '+n,sourceIds:[product],options:[],warnings:[]}});
  const v=await studio('get',j.id);await studio('approve',j.id,{revision:v.revision,comparedOriginal:true});
  const p=await pub(a,'preview',{items:[{jobId:j.id}]});
  return {operationId:op(n+100),confirmed:true,items:p.items.map(({jobId,jobRevision,sourceHash,overlayVersion})=>({jobId,jobRevision,sourceHash,overlayVersion}))};
 }
 const command=await prepare(6000);
 const receipts=await Promise.all([pub(a,'apply',command),pub(b,'apply',command)]);
 assert.deepEqual(receipts[0],receipts[1]);
 console.log('NATIVE PUBLICATION: simultaneous same-key calls return one receipt');
 const next=await prepare(6001);
 const conflict=await Promise.allSettled([pub(a,'apply',next),pub(b,'apply',{...next,operationId:op(6999)})]);
 assert.equal(conflict.filter(v=>v.status==='fulfilled').length,1);
 assert.ok(conflict.some(v=>v.status==='rejected'&&v.reason.message==='STUDIO_ALREADY_APPLIED'));
 assert.deepEqual((await a.query('select ops.catalogue($1,$2) j',[business,branch])).rows[0].j,catalogue);
 console.log('NATIVE PUBLICATION: new-key duplicate blocked and canonical catalogue unchanged');
 const winner=conflict.find(v=>v.status==='fulfilled').value;
 const undo={operationId:op(7100),confirmed:true,batchId:winner.batchId};
 const reversed=await Promise.all([pub(a,'undo',undo),pub(b,'undo',undo)]);
 assert.deepEqual(reversed[0],reversed[1]);console.log('NATIVE PUBLICATION: concurrent undo has one inverse receipt');
}
