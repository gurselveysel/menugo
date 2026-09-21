// Adds purchasing/recipe journal acceptance to the existing isolated PGlite fixture. No live writes.
import fs from 'node:fs';import {pathToFileURL} from 'node:url';import {resolve} from 'node:path';
const path=resolve('tests/.studio-cost-fixture.mjs');
const marker=" fs.mkdirSync('test-results',{recursive:true});fs.writeFileSync('test-results/sql.json'";
const source=fs.readFileSync('tests/sql.integration.mjs','utf8');if(!source.includes(marker))throw Error('Acceptance fixture contract changed');
const extra=`
 {
  await auth(users[0]);
  const studio=async(action,id=null,payload={})=>(await q('select ops.studio_job($1,$2,$3,$4,$5::jsonb) as j',[b,br,action,id,JSON.stringify(payload)]))[0].j;
  const ledger=async(action,payload={})=>(await q('select ops.studio_cost_ledger($1,$2,$3,$4::jsonb) as j',[b,br,action,JSON.stringify(payload)]))[0].j;
  const createInvoice=async(n,draft)=>{const created=await studio('create',null,{operationId:op(n),kind:'invoice',input:{language:'tr',style:'white',attachment:{mime:'image/png',data:'cG5n',pages:1}}});const claim=await studio('claim',created.id);await studio('finish',created.id,{lease:claim.lease,model:'TEST-NO-MODEL',draft,inputTokens:'0',outputTokens:'0'});const review=await studio('get',created.id);await studio('approve',created.id,{revision:review.revision,comparedOriginal:true});return studio('get',created.id);};
  const invoice={kind:'invoice',draftOnly:true,currency:'TRY',invoiceNumber:'T-1',invoiceDate:'2026-09-20',totalMinor:'120',lines:[{name:'Un',quantityText:'1',unitText:'kg',netMinor:'100',taxMinor:'20',grossMinor:'120',page:1,sourceText:'Un 1 kg'}],warnings:[]};
  const approved=await createInvoice(6100,invoice);
  const post={operationId:op(6101),jobId:approved.id,revision:approved.revision,confirmed:true};const posted=await ledger('post-invoice',post);
  check('approved invoice posts immutable purchase journal',posted.posted&&posted.totalMinor==='120'&&!posted.alreadyPosted);
  check('purchase post replays idempotently',(await ledger('post-invoice',post)).purchaseId===posted.purchaseId);
  await rejects('purchase operation id cannot change intent',()=>ledger('post-invoice',{...post,jobId:p1}),'IDEMPOTENCY_CONFLICT');
  const again=await ledger('post-invoice',{...post,operationId:op(6102)});check('same approved invoice never duplicates purchase',again.purchaseId===posted.purchaseId&&again.alreadyPosted);
  const lines=await q('select * from ops.purchase_entry_lines where purchase_id=$1',[posted.purchaseId]);check('purchase values come from approved server draft',lines.length===1&&lines[0].gross_minor==='120');
  const bad=await createInvoice(6103,{...invoice,totalMinor:'119'});await rejects('mismatched invoice cannot become purchase journal',()=>ledger('post-invoice',{operationId:op(6104),jobId:bad.id,revision:bad.revision,confirmed:true}),'INVOICE_RECONCILIATION_REQUIRED');
  const recipe={operationId:op(6110),productId:p1,name:'Test reçete',portions:3,overheadMinor:'0',confirmed:true,ingredients:[{name:'Un',unit:'g',packQuantity:'1000',packCostMinor:'12345',recipeQuantity:'100',edibleYieldBps:10000}]};
  const saved=await ledger('save-recipe',recipe);check('recipe journal recomputes exact bigint cost server-side',saved.totalMinor==='1235'&&saved.portionMinMinor==='411'&&saved.portionMaxMinor==='412'&&saved.version==='1');
  check('recipe command replay does not create version',(await ledger('save-recipe',recipe)).recipeId===saved.recipeId);
  await rejects('recipe operation id cannot change costs',()=>ledger('save-recipe',{...recipe,overheadMinor:'1'}),'IDEMPOTENCY_CONFLICT');
  const v2=await ledger('save-recipe',{...recipe,operationId:op(6111)});check('new verified recipe save appends version',v2.version==='2');
  const listed=await ledger('list');check('ledger list is branch scoped',listed.scopeKey===b+':'+br+':'+users[0]&&listed.purchases.length>=1&&listed.recipes.some(x=>x.id===v2.recipeId));
  await rejects('manager cannot directly read purchase journal',()=>q('select * from ops.purchase_entries'),'42501');
  await rejects('manager cannot directly read recipe journal',()=>q('select * from ops.recipe_versions'),'42501');
  check('cost journal never changes catalogue price',(await q('select approved_price::text p from public.menu_items where id=$1',[p1]))[0].p==='33.33');
  await auth(users[2]);await rejects('customer cannot read cost ledger',()=>ledger('list'),'MANAGER_REQUIRED');
 }
`;
try{fs.writeFileSync(path,source.replace(marker,extra+marker));await import(pathToFileURL(path).href);}finally{fs.rmSync(path,{force:true});}
if(process.exitCode)throw Error('Studio cost SQL acceptance failed');
