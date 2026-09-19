// Isolated PGlite or dedicated CI PostgreSQL17 database; no production data.
import fs from 'node:fs';import {pathToFileURL} from 'node:url';import {resolve} from 'node:path';
let source=fs.readFileSync('tests/sql.integration.mjs','utf8');
const marker=" fs.mkdirSync('test-results',{recursive:true});fs.writeFileSync('test-results/sql.json'";
if(!source.includes(marker))throw Error('Fixture contract changed');
const extra=`
 {
 await db.exec('reset role');await q('update public.menu_items set available=true where id=$1',[p1]);await auth(users[0]);
 const snap=async(pid=p1,jid=null,version=null)=>(await q('select ops.campaign_snapshot($1,$2,$3,$4,$5) as j',[b,br,pid,jid,version]))[0].j;
 const baseline=await snap();check('campaign snapshot contains exact approved price',/^[0-9]+$/.test(baseline.priceMinor));
 check('campaign version is stable across reads',(await snap()).version===baseline.version);
 check('campaign export validates reviewed version',(await snap(p1,null,baseline.version)).version===baseline.version);
 await rejects('campaign rejects stale reviewed version',()=>snap(p1,null,'b'.repeat(64)),'CAMPAIGN_SOURCE_CHANGED');
 await auth(users[2]);await rejects('campaign customer denied',()=>snap(),'MANAGER_REQUIRED');
 await db.exec('reset role');await db.exec('set role anon');await rejects('campaign anonymous denied',()=>snap(),'42501');
 await auth(users[0]);const studio=async(action,id=null,payload={})=>(await q('select ops.studio_job($1,$2,$3,$4,$5::jsonb) as j',[b,br,action,id,JSON.stringify(payload)]))[0].j;
 const job=await studio('create',null,{operationId:op(6200),kind:'campaign',input:{productId:p1,language:'tr',style:'white'}});
 const lease=await studio('claim',job.id);
 await studio('finish',job.id,{lease:lease.lease,model:'FIXTURE_ONLY',draft:{kind:'campaign',draftOnly:true,title:'Test başlık',body:'İncelenmiş test açıklaması.',sourceIds:[p1],options:[],warnings:[]}});
 await rejects('unreviewed campaign cannot export',()=>snap(p1,job.id),'CAMPAIGN_REVIEW_REQUIRED');
 const jobState=await studio('get',job.id);await studio('approve',job.id,{revision:jobState.revision,comparedOriginal:true});
 check('reviewed campaign text can be used',(await snap(p1,job.id)).caption.includes('İncelenmiş'));
 await rejects('reviewed campaign cannot bind another product',()=>snap(p2,job.id),'CAMPAIGN_SOURCE_CHANGED');
 await db.exec('reset role');await q('update public.menu_items set approved_price=approved_price+1 where id=$1',[p1]);await auth(users[0]);
 await rejects('price change invalidates original preview',()=>snap(p1,null,baseline.version),'CAMPAIGN_SOURCE_CHANGED');
 await rejects('price change invalidates reviewed AI campaign',()=>snap(p1,job.id),'CAMPAIGN_SOURCE_CHANGED');
 await db.exec('reset role');await q('update public.menu_items set available=false where id=$1',[p1]);await auth(users[0]);
 await rejects('sold out product cannot be exported',()=>snap(),'PRODUCT_NOT_ADVERTISABLE');
 await db.exec('reset role');await q('update public.menu_items set available=true,approved_price=approved_price-1 where id=$1',[p1]);await auth(users[0]);
 const original=JSON.stringify(await snap());check('campaign rendering does not create a job',(await studio('list')).jobs.length===1);
 await studio('discard',job.id);await rejects('discarded review cannot export',()=>snap(p1,job.id),'CAMPAIGN_REVIEW_REQUIRED');
 await db.exec('reset role');check('no campaign write tables required',(await q("select count(*)::int n from information_schema.tables where table_schema='ops' and table_name='campaign_exports'"))[0].n===0);
 }
`;
source=source.replace(marker,extra+marker);
if(process.env.POSTGRES_TEST_URL){
 const u=new URL(process.env.POSTGRES_TEST_URL);if(!['127.0.0.1','localhost'].includes(u.hostname)||u.pathname!=='/menugo_campaign_ci')throw Error('Only disposable campaign CI allowed');
 source=source.replace("import {PGlite} from '@electric-sql/pglite';","import {Client} from 'pg';").replace('const db=new PGlite();',`const client=new Client({connectionString:process.env.POSTGRES_TEST_URL});await client.connect();const db={query:(...a)=>client.query(...a),exec:sql=>client.query(sql),close:()=>client.end()};`);
}
const path=resolve('tests/.campaign-fixture.mjs');try{fs.writeFileSync(path,source);await import(pathToFileURL(path).href);}finally{fs.rmSync(path,{force:true});}if(process.exitCode)throw Error('Campaign SQL acceptance failed');
