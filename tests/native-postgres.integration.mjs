// Isolated CI PostgreSQL only. No production credentials or Supabase connection.
import fs from 'node:fs';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import assert from 'node:assert/strict';
import {Client} from 'pg';
const connectionString=process.env.POSTGRES_TEST_URL;
if(!connectionString)throw Error('POSTGRES_TEST_URL required');
const url=new URL(connectionString);
if(!['127.0.0.1','localhost'].includes(url.hostname)||url.pathname!=='/menugo_ci')throw Error('Only disposable local menugo_ci is allowed');
let source=fs.readFileSync('tests/sql.integration.mjs','utf8');
source=source.replace("import {PGlite} from '@electric-sql/pglite';", "import {Client} from 'pg';");
if(!source.includes('const db=new PGlite();'))throw Error('Test fixture changed');
source=source.replace('const db=new PGlite();',`const client=new Client({connectionString:process.env.POSTGRES_TEST_URL});await client.connect();const db={query:(...a)=>client.query(...a),exec:(sql)=>client.query(sql),close:()=>client.end()};`);
const temp=resolve('tests/.native-fixture.mjs');
try{fs.writeFileSync(temp,source);await import(pathToFileURL(temp).href);}finally{fs.rmSync(temp,{force:true});}
if(process.exitCode)throw Error('Native PostgreSQL acceptance suite failed');
const a=new Client({connectionString}),b=new Client({connectionString});
try{
 await a.connect();await b.connect();
 const row=(await a.query('select business_id,branch_id,id from ops.checks order by created_at limit 1')).rows[0];
 assert.ok(row);
 await a.query('BEGIN');
 await a.query('select * from ops.lock_check($1,$2,$3,null)',[row.business_id,row.branch_id,row.id]);
 await b.query("set lock_timeout='150ms'");
 await assert.rejects(()=>b.query('select * from ops.checks where id=$1 for update',[row.id]),e=>e.code==='55P03');
 await a.query('ROLLBACK');
 assert.equal((await b.query('select id from ops.checks where id=$1 for update',[row.id])).rows.length,1);
 // Simultaneous guests attempting the same observed revision: one commit, one conflict.
 const guestRows=(await a.query("select g.*,c.revision::text from ops.guest_sessions g join ops.checks c on c.id=g.check_id where g.revoked_at is null and c.status='open' and g.seat_no in(1,2) and g.secret_hash=encode(sha256(convert_to(repeat(g.seat_no::text,64),'UTF8')),'hex') order by g.created_at desc limit 2")).rows;
 assert.equal(guestRows.length,2);
 const product=(await a.query("select id from public.menu_items where source_id='TIR-TEST-2'")).rows[0].id;
 const revision=guestRows[0].revision;
 for(const conn of [a,b]){await conn.query('reset role');await conn.query("select set_config('request.jwt.claims','{}',false)");await conn.query('set role anon');await conn.query("set lock_timeout='3s'");}
 const commands=guestRows.map((g,i)=>[g.business_id,g.branch_id,g.check_id,`88888888-8888-4888-8888-${String(i+1).padStart(12,'0')}`,product,revision,String(g.seat_no).repeat(64)]);
 const competing=await Promise.allSettled([a,b].map((conn,i)=>conn.query('select ops.guest_cart_mutate($1,$2,$3,$4,$5,1,$6::bigint,$7,null)',commands[i])));
 assert.equal(competing.filter(x=>x.status==='fulfilled').length,1);
 assert.ok(competing.some(x=>x.status==='rejected'&&x.reason.message==='REVISION_CONFLICT'));
 console.log('NATIVE GUEST CONCURRENCY PASS: single commit for a shared revision, second guest must refresh.');

 await a.query('reset role');
 const table=(await a.query("insert into ops.dining_tables(business_id,branch_id,table_code,display_name) values($1,$2,'parallel-entry','Parallel QR') returning id",[row.business_id,row.branch_id])).rows[0].id;
 for(const conn of[a,b]){await conn.query('reset role');await conn.query("select set_config('request.jwt.claims','{}',false)");await conn.query('set role anon');}
 const entries=await Promise.all([a,b].map((conn,i)=>conn.query('select ops.table_guest_join($1,$2,$3,$4) as j',[row.business_id,row.branch_id,table,String(i+5).repeat(64)])));
 assert.equal(entries[0].rows[0].j.checkId,entries[1].rows[0].j.checkId);
 assert.notEqual(entries[0].rows[0].j.viewerUserId,entries[1].rows[0].j.viewerUserId);
 console.log('NATIVE CODELESS CONCURRENCY PASS: parallel table QR opens exactly one check and distinct private visitors.');
 await (await import('./studio-publication-concurrency.mjs')).publicationConcurrency(a,b);
 await (await import('./platform-control-concurrency.mjs')).controlConcurrency(a,b);
 await (await import('./studio-photo-concurrency.mjs')).photoConcurrency(a,b);
 console.log('NATIVE POSTGRES PASS: real row-lock exclusion and release, isolated Auth/Realtime fixtures');
}finally{await a.query('ROLLBACK').catch(()=>{});await a.end().catch(()=>{});await b.end().catch(()=>{});}
