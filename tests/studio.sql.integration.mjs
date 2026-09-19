// New RPC checks in the same isolated PGlite fixture; no live database credentials.
import fs from 'node:fs';import {pathToFileURL} from 'node:url';import {resolve} from 'node:path';
const path=resolve('tests/.studio-fixture.mjs');
const marker=" fs.mkdirSync('test-results',{recursive:true});fs.writeFileSync('test-results/sql.json'";
const source=fs.readFileSync('tests/sql.integration.mjs','utf8');
if(!source.includes(marker))throw Error('Acceptance fixture contract changed');
const extra=`
 {
 await auth(users[0]);
 const studio=async(action,id=null,payload={})=>(await q('select ops.studio_job($1,$2,$3,$4,$5::jsonb) as j',[b,br,action,id,JSON.stringify(payload)]))[0].j;
 check('studio only lists an empty draft collection initially',(await studio('list')).jobs.length===0);
 const payload={operationId:op(3000),kind:'product-copy',input:{productId:p1,language:'tr',style:'white'}};
 const created=await studio('create',null,payload);
 check('studio starts queued rather than pretending generated',created.state==='queued');
 check('studio same operation deduplicates',(await studio('create',null,payload)).id===created.id);
 await rejects('studio key cannot change intent',()=>studio('create',null,{...payload,kind:'campaign'}),'IDEMPOTENCY_CONFLICT');
 const claim=await studio('claim',created.id);
 check('studio sources are server-loaded product records',claim.claimed&&claim.sources[0].id===p1);
 check('studio repeated claim cannot call model twice',!(await studio('claim',created.id)).claimed);
 await rejects('studio wrong lease cannot save',()=>studio('finish',created.id,{lease:op(3001),error:'AI_RESULT_UNKNOWN'}),'STUDIO_LEASE_LOST');
 await studio('finish',created.id,{lease:claim.lease,model:'TEST-NO-MODEL',draft:{kind:'product-copy',draftOnly:true,title:'Test',body:'Test',options:[],sourceIds:[p1],warnings:[]},inputTokens:'0',outputTokens:'0'});
 const saved=await studio('get',created.id);
 check('studio completed output still needs human review',saved.state==='review'&&!('request'in saved)&&!('lease_token'in saved));
 await rejects('studio approval needs explicit source comparison',()=>studio('approve',created.id,{revision:saved.revision}),'STUDIO_REVIEW_REQUIRED');
 const approved=await studio('approve',created.id,{revision:saved.revision,comparedOriginal:true});
 check('studio approval is not a catalogue mutation',approved.approved&&approved.applied===false);
 await rejects('studio authenticated cannot directly read stored documents',()=>q('select * from ops.studio_jobs'),'42501');
 await auth(users[2]);await rejects('studio denies customer access',()=>studio('list'),'MANAGER_REQUIRED');
 await auth(users[0]);await studio('discard',created.id);
 await rejects('studio discarded source cannot be retrieved',()=>studio('get',created.id),'STUDIO_RESULT_EXPIRED');
 }
`;
try{fs.writeFileSync(path,source.replace(marker,extra+marker));await import(pathToFileURL(path).href);}finally{fs.rmSync(path,{force:true});}
if(process.exitCode)throw Error('Studio SQL acceptance failed');
