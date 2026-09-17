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
 console.log('NATIVE POSTGRES PASS: real row-lock exclusion and release, isolated Auth/Realtime fixtures');
}finally{await a.query('ROLLBACK').catch(()=>{});await a.end().catch(()=>{});await b.end().catch(()=>{});}
