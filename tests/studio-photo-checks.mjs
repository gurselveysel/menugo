// Executes on disposable PGlite/PostgreSQL only, using synthetic WebP bytes and users.
import assert from 'node:assert/strict';
import sharp from 'sharp';
export async function photoPublicationChecks({q,db,auth,check,b,br,users,op,p1,p2}){
 await db.exec('reset role; BEGIN');let n=0;
 const reject=async(name,fn,code)=>{const sp='ph'+(++n);await db.exec('SAVEPOINT '+sp);let error;try{await fn();}catch(e){error=e;}await db.exec('ROLLBACK TO SAVEPOINT '+sp);await db.exec('RELEASE SAVEPOINT '+sp);assert.ok(error,name);assert.ok(error.code===code||error.message.includes(code),`${name}: ${error.message}`);check(name,true);};
 const base=JSON.stringify(await q('select * from public.menu_items order by id'));
 const previousCounts=JSON.stringify(await q('select (select count(*) from ops.orders) o,(select count(*) from ops.bill_charges) b'));
 const photo=await sharp({create:{width:24,height:24,channels:3,background:'#a64727'}}).webp().toBuffer();
 let seq=91000;
 async function prepare(pid=p1,state='approved',data=photo.toString('base64')){
  await db.exec('reset role');const jid=op(++seq);
  await q(`insert into ops.studio_jobs(id,business_id,branch_id,created_by,operation_id,kind,request_hash,request,source_snapshot,state,revision,result,reviewed_by,reviewed_at)
   values($1,$2,$3,$4,$1,'photo-enhance',repeat('a',64),'{}',jsonb_build_array(ops.studio_publication_source($2,$3,$5)->'product'),$6,3,$7::jsonb,$4,now())`,[jid,b,br,users[0],pid,state,JSON.stringify({kind:'photo-enhance',mime:'image/webp',draftOnly:true,data})]);await auth(users[0]);return jid;
 }
 const call=async(a,p={},bb=b,rr=br)=>(await q('select ops.studio_photo_publication($1,$2,$3,$4::jsonb) j',[bb,rr,a,JSON.stringify(p)]))[0].j;
 const preview=jid=>call('preview',{jobId:jid});
 const cmd=p=>({operationId:op(++seq),confirmed:true,...Object.fromEntries(['jobId','jobRevision','sourceHash','imageHash','overlayVersion'].map(k=>[k,p[k]]))});
 const undo=id=>({operationId:op(++seq),confirmed:true,publicationId:id});
 const catalogue=async()=>(await q('select ops.catalogue_with_studio_media($1,$2) j',[b,br]))[0].j;
 const bytes=async(asset,pid=p1,bb=b,rr=br)=>(await q('select ops.menu_photo($1,$2,$3,$4) j',[bb,rr,pid,asset]))[0].j;
 try{
  const first=await prepare(),p=await preview(first),command=cmd(p);
  check('photo preview reads reviewed source and output proofs',p.ready&&p.overlayVersion==='0'&&p.sourceHash.length===64&&p.imageHash.length===64&&p.beforeUrl===null);
  check('photo preview URLs never expose inline data',p.sourceUrl.startsWith('/api/studio/source?id=')&&!JSON.stringify(p).includes(photo.toString('base64')));
  await reject('photo requires explicit confirmation',()=>call('apply',{...command,confirmed:false}),'PUBLICATION_CONFIRM_REQUIRED');
  await reject('photo rejects client bytes on direct RPC',()=>call('apply',{...command,data:'malicious'}),'INVALID_PHOTO_PUBLICATION_INPUT');
  await reject('photo rejects changed image hash',()=>call('apply',{...command,imageHash:'c'.repeat(64)}),'PUBLICATION_CHANGED');
  await reject('photo rejects stale overlay version',()=>call('apply',{...command,overlayVersion:'1'}),'PUBLICATION_CHANGED');
  const applied=await call('apply',command);
  check('photo immutable receipt keeps operation identity',applied.operationId===command.operationId&&applied.version==='1'&&applied.cataloguePricesChanged===false);
  check('photo exact replay returns original receipt',JSON.stringify(await call('apply',command))===JSON.stringify(applied));
  await reject('photo idempotency key mismatch rejected',()=>call('apply',{...command,overlayVersion:'1'}),'IDEMPOTENCY_CONFLICT');
  await reject('photo cannot apply same job twice',()=>call('apply',{...command,operationId:op(++seq)}),'STUDIO_ALREADY_APPLIED');
  const current=(await catalogue()).items.find(i=>i.id===p1),asset=current.photoUrl.split('/').at(-1);
  check('photo customer catalogue adds URL not private image data',current.photoUrl.startsWith('/api/menu-photo/'+p1+'/')&&!('data'in current));
  await db.exec('reset role; set role anon');
  check('photo anonymous active published bytes accessible',Buffer.from((await bytes(asset)).data,'base64').equals(photo));
  check('photo wrong branch does not leak published bytes',(await bytes(asset,p1,b,op(99999)))===null);
  check('photo asset cannot be rebound to another product',(await bytes(asset,p2))===null);
  await reject('photo anonymous cannot list drafts',()=>call('list'),'42501');
  for(const table of ['studio_photo_assets','studio_photo_overlays','studio_photo_publications'])await reject('photo direct read denied '+table,()=>q('select * from ops.'+table),'42501');
  await auth(users[2]);await reject('photo customer cannot manage publication',()=>call('list'),'MANAGER_REQUIRED');
  await auth(users[0]);await reject('photo tenant manager cannot cross branch',()=>call('list',{},b,op(99999)),'MANAGER_REQUIRED');
  const second=await prepare(),p2v=await preview(second),a2=await call('apply',cmd(p2v));
  check('photo second preview shows published before image',p2v.beforeUrl===current.photoUrl);
  await db.exec('reset role; set role anon');check('photo old asset URL becomes inaccessible',(await bytes(asset))===null);await auth(users[0]);
  await reject('photo undo cannot overwrite newer photo',()=>call('undo',undo(applied.publicationId)),'PUBLICATION_CHANGED');
  const u2=undo(a2.publicationId);await call('undo',u2);check('photo undo restores earlier asset',(await catalogue()).items.find(i=>i.id===p1).photoUrl===current.photoUrl);
  check('photo undo replay exact',JSON.stringify(await call('undo',u2))===JSON.stringify(await call('undo',u2)));
  await reject('photo undo ABA guard keeps audit order',()=>call('undo',undo(applied.publicationId)),'PUBLICATION_CHANGED');
  await db.exec('reset role');await q("update ops.studio_jobs set state='discarded',result=null,request='{}',expires_at=now()-interval '1 day' where id=$1",[first]);
  await db.exec('set role anon');check('photo persists after source job expires and is discarded',Buffer.from((await bytes(asset)).data,'base64').equals(photo));await auth(users[0]);
  check('photo original successful replay survives job discard',JSON.stringify(await call('apply',command))===JSON.stringify(applied));
  const third=await prepare(),p3=await preview(third),c3=cmd(p3);
  await db.exec('SAVEPOINT changed_product; reset role');await q("update public.menu_items set name='New fixture product',updated_at=clock_timestamp() where id=$1",[p1]);await auth(users[0]);
  await reject('photo source changes stop stale apply',()=>call('apply',c3),'STUDIO_SOURCE_CHANGED');
  check('photo stale published image removed from catalogue',!(await catalogue()).items.find(i=>i.id===p1).photoUrl);
  await db.exec('set role anon');check('photo stale image URL itself revoked',(await bytes(asset))===null);
  await db.exec('ROLLBACK TO SAVEPOINT changed_product; RELEASE SAVEPOINT changed_product');await auth(users[0]);
  const review=await prepare(p2,'review');await reject('photo unreviewed source cannot publish',()=>preview(review),'STUDIO_REVIEW_REQUIRED');
  const invalid=await prepare(p2,'approved',Buffer.from('<svg>unsafe</svg>').toString('base64'));await reject('photo non-WebP rejected',()=>preview(invalid),'INVALID_PHOTO_DRAFT');
  await db.exec('SAVEPOINT expired; reset role');await q("update ops.studio_jobs set expires_at=now()-interval '1 day' where id=$1",[third]);await auth(users[0]);await reject('photo expired draft cannot publish',()=>preview(third),'STUDIO_REVIEW_REQUIRED');await db.exec('ROLLBACK TO SAVEPOINT expired; RELEASE SAVEPOINT expired');
  const pol=(await q('select ops.platform_control_snapshot(null,null) j'))[0].j;
  await q('select ops.platform_control_save(null,null,$1,$2::bigint,$3::jsonb,$4)',[op(++seq),pol.version,JSON.stringify({...pol.settings,studioPublicationEnabled:false}),'Photo publication isolated gate test']);
  await reject('photo publication company kill-switch enforced',()=>call('apply',c3),'PLATFORM_SERVICE_PAUSED');
  check('photo exact replay allowed while publication stopped',JSON.stringify(await call('apply',command))===JSON.stringify(applied));
  // New product, apply then disable demonstrates undo remains possible under central gate.
  await db.exec('reset role');const assetCount=(await q('select count(*)::int n from ops.studio_photo_assets'))[0].n;check('photo denied apply leaves no partial durable asset',assetCount===2);
  await auth(users[0]);const pol2=(await q('select ops.platform_control_snapshot(null,null) j'))[0].j;await q('select ops.platform_control_save(null,null,$1,$2::bigint,$3::jsonb,$4)',[op(++seq),pol2.version,JSON.stringify({...pol.settings,studioPublicationEnabled:true}),'Restore fixture photo gate']);
  const a3=await call('apply',c3);const pol3=(await q('select ops.platform_control_snapshot(null,null) j'))[0].j;await q('select ops.platform_control_save(null,null,$1,$2::bigint,$3::jsonb,$4)',[op(++seq),pol3.version,JSON.stringify({...pol.settings,studioPublicationEnabled:false}),'Stop fixture photo gate']);
  await call('undo',undo(a3.publicationId));check('photo undo allowed while company publication disabled',(await catalogue()).items.find(i=>i.id===p1).photoUrl===current.photoUrl);
  await db.exec('reset role');await reject('photo assets append-only immutable',()=>q('delete from ops.studio_photo_assets'),'STUDIO_AUDIT_IMMUTABLE');
  await reject('photo history cannot truncate',()=>q('truncate ops.studio_photo_publications cascade'),'STUDIO_AUDIT_IMMUTABLE');
  await db.exec('SET CONSTRAINTS ALL IMMEDIATE');
  check('photo lifecycle leaves public catalogue unchanged',JSON.stringify(await q('select * from public.menu_items order by id'))===base);
  check('photo lifecycle does not create orders or charges',JSON.stringify(await q('select (select count(*) from ops.orders) o,(select count(*) from ops.bill_charges) b'))===previousCounts);
 }finally{await db.exec('ROLLBACK;reset role');}
}
