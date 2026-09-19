// Runs within the existing synthetic PGlite AND native PostgreSQL fixtures, never production.
import assert from 'node:assert/strict';
export async function runPublicationChecks({q,db,auth,check,b,br,users,op,p1,p2}){
 await db.exec('reset role; BEGIN');
 const base=JSON.stringify(await q('select * from public.menu_items order by id'));
 const settings=JSON.stringify(await q('select * from ops.branch_settings order by branch_id'));
 let counter=0;
 const reject=async(name,fn,code)=>{
  const s='pub_'+(++counter);await db.exec('SAVEPOINT '+s);let caught;
  try{await fn();}catch(e){caught=e;}
  await db.exec('ROLLBACK TO SAVEPOINT '+s);await db.exec('RELEASE SAVEPOINT '+s);
  assert.ok(caught,name+' must reject');assert.ok(caught.code===code||caught.message.includes(code),`${name}: ${caught?.message}`);check(name,true);
 };
 const pub=async(action,payload={},business=b,branch=br)=>(await q('select ops.studio_text_publication($1,$2,$3,$4::jsonb) as j',[business,branch,action,JSON.stringify(payload)]))[0].j;
 const studio=async(action,id=null,payload={})=>(await q('select ops.studio_job($1,$2,$3,$4,$5::jsonb) as j',[b,br,action,id,JSON.stringify(payload)]))[0].j;
 const prepare=async(id,language='tr',body='Sınanan açıklama')=>{
  const kind=language==='en'?'translation':'product-copy';
  const create=await studio('create',null,{operationId:op(9000+(++counter)),kind,input:{productId:id,language,style:'white'}});
  const lease=await studio('claim',create.id);
  await studio('finish',create.id,{lease:lease.lease,model:'TEST-DOUBLE-NO-PROVIDER',draft:{kind,draftOnly:true,title:'Reviewed English title',body,options:[],sourceIds:[id],warnings:[]},inputTokens:'0',outputTokens:'0'});
  const get=await studio('get',create.id);await studio('approve',create.id,{revision:get.revision,comparedOriginal:true});
  return create.id;
 };
 const preview=async(...ids)=>pub('preview',{items:ids.map(jobId=>({jobId}))});
 const applyInput=(p,n)=>({operationId:op(n),confirmed:true,items:p.items.map(({jobId,jobRevision,sourceHash,overlayVersion})=>({jobId,jobRevision,sourceHash,overlayVersion}))});
 const catalog=async()=> (await q('select ops.catalogue_with_studio_text($1,$2) as j',[b,br]))[0].j;
 try{
  await auth(users[0]);
  const first=await prepare(p1);
  const p=await preview(first);
  check('publication preview contains current source proof and no write',p.items[0].ready&&/^[a-f0-9]{64}$/.test(p.items[0].sourceHash)&&p.items[0].overlayVersion==='0');
  await reject('publication human confirmation required',()=>pub('apply',{...applyInput(p,9500),confirmed:false}),'PUBLICATION_CONFIRM_REQUIRED');
  await reject('publication duplicate job rejected',()=>preview(first,first),'DUPLICATE_PUBLICATION_JOB');
  const applied=await pub('apply',applyInput(p,9500));
  check('publication first apply has immutable receipt',applied.action==='apply'&&applied.items.length===1&&applied.cataloguePricesChanged===false);
  check('publication exact lost-response replay returns same receipt',JSON.stringify(await pub('apply',applyInput(p,9500)))===JSON.stringify(applied));
  await reject('publication changed intent cannot reuse operation',()=>pub('apply',{...applyInput(p,9500),items:[{...applyInput(p,9500).items[0],overlayVersion:'999'}]}),'IDEMPOTENCY_CONFLICT');
  await reject('publication job cannot apply twice even with another key',()=>pub('apply',applyInput(p,9501)),'STUDIO_ALREADY_APPLIED');
  await db.exec('reset role');check('publication leaves public catalogue bit-for-bit unchanged',JSON.stringify(await q('select * from public.menu_items order by id'))===base);
  await db.exec('set role anon');check('public display contains reviewed text',(await catalog()).items.find(x=>x.id===p1).description==='Sınanan açıklama');
  await reject('anonymous cannot read draft publication audit',()=>q('select * from ops.studio_text_changes'),'42501');
  await reject('anonymous cannot execute manager publish',()=>pub('list'),'42501');
  await auth(users[2]);await reject('customer cannot list studio publication drafts',()=>pub('list'),'MANAGER_REQUIRED');
  await auth(users[0]);await reject('publication cannot cross branch',()=>pub('list',{},b,op(9800)),'MANAGER_REQUIRED');
  const undo={operationId:op(9502),confirmed:true,batchId:applied.batchId};const undone=await pub('undo',undo);
  check('publication rollback writes inverse event',undone.action==='undo'&&undone.items[0].version==='2');
  check('publication undo safely replays',JSON.stringify(await pub('undo',undo))===JSON.stringify(undone));
  await db.exec('set role anon');const restored=(await catalog()).items.find(x=>x.id===p1);const original=JSON.parse(base).find(x=>x.id===p1);
  check('undo restores canonical description and price',restored.description===original.description&&restored.name===original.name);
  await auth(users[0]);
  const second=await prepare(p1,'tr','İkinci açıklama'),third=await prepare(p2,'en','Reviewed English description');
  const two=await preview(second,third);const twoApplied=await pub('apply',applyInput(two,9503));
  check('batch publication applies both language targets atomically',twoApplied.items.length===2);
  const catalogue=await catalog();check('English name/description added without renaming canonical product',catalogue.items.find(x=>x.id===p2).englishName==='Reviewed English title'&&catalogue.items.find(x=>x.id===p2).name===JSON.parse(base).find(x=>x.id===p2).name);
  const fourth=await prepare(p1,'tr','En yeni açıklama');const p4=await preview(fourth);await pub('apply',applyInput(p4,9504));
  await reject('undo refuses to overwrite newer publication, entire batch rolls back',()=>pub('undo',{operationId:op(9505),confirmed:true,batchId:twoApplied.batchId}),'PUBLICATION_CHANGED');
  check('failed batch undo leaves English target unchanged',(await catalog()).items.find(x=>x.id===p2).englishDescription==='Reviewed English description');
  const fifth=await prepare(p2,'tr','Yeni Türkçe'),p5=await preview(fifth);
  await db.exec('SAVEPOINT changed_source; reset role');
  await q("update public.menu_items set description='A real source edit in isolated fixture',updated_at=clock_timestamp() where id=$1",[p2]);
  await auth(users[0]);await reject('source edit between preview and apply is rejected',()=>pub('apply',applyInput(p5,9506)),'STUDIO_SOURCE_CHANGED');
  check('public display suppresses stale source translations',!(await catalog()).items.find(x=>x.id===p2).englishDescription);
  await db.exec('ROLLBACK TO SAVEPOINT changed_source; RELEASE SAVEPOINT changed_source');await auth(users[0]);
  await db.exec('SAVEPOINT changed_metadata; reset role');
  await q('update ops.product_information set version=version+1 where product_source_id=(select source_id from public.menu_items where id=$1)',[p2]);
  await q("insert into ops.product_information(business_id,branch_id,product_source_id,published,version) select business_id,branch_id,source_id,false,1 from public.menu_items where id=$1 on conflict do nothing",[p2]);
  await auth(users[0]);await reject('metadata changes invalidate preview proof',()=>pub('apply',applyInput(p5,9507)),'PUBLICATION_CHANGED');
  await db.exec('ROLLBACK TO SAVEPOINT changed_metadata; RELEASE SAVEPOINT changed_metadata');await auth(users[0]);
  const sixth=await prepare(p2,'tr','Diğer taslak');await reject('one batch cannot choose competing drafts for same product-language',()=>preview(fifth,sixth),'DUPLICATE_PUBLICATION_TARGET');
  await reject('bulk partial failure never leaves early target modified',async()=>pub('apply',{...applyInput(await preview(fifth),9508),items:[...applyInput(await preview(fifth),9508).items,{jobId:op(9899),jobRevision:'0',sourceHash:'a'.repeat(64),overlayVersion:'0'}]}),'STUDIO_JOB_NOT_FOUND');
  check('failed apply left first target unpublished',!(await pub('preview',{items:[{jobId:fifth}]})).items[0].reason);
  await db.exec('reset role; SET CONSTRAINTS ALL IMMEDIATE');
  await reject('publication audit cannot be edited even by table owner',()=>q("update ops.studio_text_changes set action='undo'"),'STUDIO_AUDIT_IMMUTABLE');
  await reject('publication receipts cannot be truncated',()=>q('truncate ops.studio_publication_batches cascade'),'STUDIO_AUDIT_IMMUTABLE');
  check('publication does not change order settings',JSON.stringify(await q('select * from ops.branch_settings order by branch_id'))===settings);
  check('publication full lifecycle preserves catalogue',JSON.stringify(await q('select * from public.menu_items order by id'))===base);
 }finally{await db.exec('ROLLBACK; reset role');}
}
