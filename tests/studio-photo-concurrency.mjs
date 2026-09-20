// Called ONLY by native-postgres.integration.mjs against disposable localhost/menugo_ci.
// This is a real two-client test; it has NOT run in environments without PostgreSQL.
import assert from 'node:assert/strict';import sharp from 'sharp';import {randomUUID} from 'node:crypto';
export async function photoConcurrency(a,b){
 await a.query('reset role');await b.query('reset role');
 const staff=(await a.query("select s.business_id,s.branch_id,s.user_id from ops.branch_staff s join auth.users u on u.id=s.user_id where s.active and s.role='owner' and u.email='owner@example.test' limit 1")).rows[0];assert.ok(staff);
 const pid=(await a.query('select id from public.menu_items where business_id=$1 and branch_id=$2 order by id limit 1',[staff.business_id,staff.branch_id])).rows[0].id;
 const bytes=(await sharp({create:{width:20,height:20,channels:3,background:'#974421'}}).webp().toBuffer()).toString('base64');
 const prepare=async()=>{const id=randomUUID();await a.query(`insert into ops.studio_jobs(id,business_id,branch_id,created_by,operation_id,kind,request_hash,request,source_snapshot,state,revision,result,reviewed_by,reviewed_at)
 values($1,$2,$3,$4,$1,'photo-enhance',repeat('a',64),'{}',jsonb_build_array(ops.studio_publication_source($2,$3,$5)->'product'),'approved',3,$6::jsonb,$4,now())`,[id,staff.business_id,staff.branch_id,staff.user_id,pid,JSON.stringify({kind:'photo-enhance',mime:'image/webp',draftOnly:true,data:bytes})]);return id;};
 const j1=await prepare(),j2=await prepare();
 for(const conn of[a,b]){await conn.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:staff.user_id,role:'authenticated'})]);await conn.query('set role authenticated');}
 const call=async(conn,action,payload)=>(await conn.query('select ops.studio_photo_publication($1,$2,$3,$4::jsonb) j',[staff.business_id,staff.branch_id,action,JSON.stringify(payload)])).rows[0].j;
 const proof=async id=>{const p=await call(a,'preview',{jobId:id});return {confirmed:true,operationId:randomUUID(),...Object.fromEntries(['jobId','jobRevision','sourceHash','imageHash','overlayVersion'].map(k=>[k,p[k]]))};};
 const p1=await proof(j1),p2=await proof(j2);
 const results=await Promise.allSettled([call(a,'apply',p1),call(b,'apply',p2)]);
 assert.equal(results.filter(x=>x.status==='fulfilled').length,1);assert.ok(results.some(x=>x.status==='rejected'&&x.reason.message==='PUBLICATION_CHANGED'));
 const winner=results[0].status==='fulfilled'?p1:p2;
 const replay=await Promise.all([call(a,'apply',winner),call(b,'apply',winner)]);assert.deepEqual(replay[0],replay[1]);
 console.log('NATIVE PHOTO CONCURRENCY PASS: same preview cannot overwrite; exact operation returns one receipt');
 await a.query('reset role');await b.query('reset role');
}
