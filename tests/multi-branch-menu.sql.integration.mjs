// Isolated PGlite acceptance for multi-branch master menu; never contacts production.
import fs from'node:fs';import{pathToFileURL}from'node:url';import{resolve}from'node:path';
const path=resolve('tests/.multi-branch-fixture.mjs');const marker=" fs.mkdirSync('test-results',{recursive:true});fs.writeFileSync('test-results/sql.json'";const source=fs.readFileSync('tests/sql.integration.mjs','utf8');if(!source.includes(marker))throw Error('Acceptance fixture contract changed');
const extra=`
 {
  const br2='99999999-9999-4999-8999-999999999999',p4='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  await db.exec('reset role');
  await q('insert into public.branches values($1,$2,$3,$4,$5)',[br2,b,'ikinci','İkinci Şube','05000000000']);
  await q("insert into public.menu_items(id,business_id,branch_id,source_id,name,approved_price,price_approved) values($1,$2,$3,'TIR-TEST-1','Test ürün ikinci',88.88,true)",[p4,b,br2]);
  await auth(users[0]);
  const createKey=op(3600);const created=(await q("select ops.multi_branch_manage($1,$2,$3,'create-master',$4::jsonb) as j",[b,br,createKey,JSON.stringify({productSourceId:'TIR-TEST-1'})]))[0].j;
  check('owner creates master item from approved current-branch product',created.replayed===false&&created.masterItemId);
  const replay=(await q("select ops.multi_branch_manage($1,$2,$3,'create-master',$4::jsonb) as j",[b,br,createKey,JSON.stringify({productSourceId:'TIR-TEST-1'})]))[0].j;
  check('multi-branch command is idempotent',replay.replayed===true&&replay.masterItemId===created.masterItemId);
  await rejects('multi-branch idempotency key cannot change intent',()=>q("select ops.multi_branch_manage($1,$2,$3,'create-master',$4::jsonb)",[b,br,createKey,JSON.stringify({productSourceId:'TIR-TEST-2'})]),'IDEMPOTENCY_CONFLICT');
  const bind=(await q("select ops.multi_branch_manage($1,$2,$3,'bind-product',$4::jsonb) as j",[b,br,op(3601),JSON.stringify({masterItemId:created.masterItemId,targetBranchId:br2,productSourceId:'TIR-TEST-1'})]))[0].j;
  check('owner binds corresponding product without silently repricing it',bind.cataloguePriceMinor==='8888');
  const local=(await q("select ops.multi_branch_manage($1,$2,$3,'set-local-price',$4::jsonb) as j",[b,br,op(3602),JSON.stringify({masterItemId:created.masterItemId,targetBranchId:br2,priceMinor:'12345',expectedOverrideVersion:'-1'})]))[0].j;
  const localSnap=(await q('select ops.multi_branch_snapshot($1,$2) as j',[b,br]))[0].j;const localBinding=localSnap.masters.find(x=>x.id===created.masterItemId).bindings.find(x=>x.branchId===br2);
  check('local price uses exact bigint cents',local.overridePriceMinor==='12345'&&localBinding.cataloguePriceMinor==='12345'&&localBinding.effectivePriceMinor==='12345');
  const master=(await q("select ops.multi_branch_manage($1,$2,$3,'set-master-price',$4::jsonb) as j",[b,br,op(3603),JSON.stringify({masterItemId:created.masterItemId,priceMinor:'17001',expectedVersion:'0'})]))[0].j;
  check('master price version advances',master.version==='1'&&master.basePriceMinor==='17001');
  const masterSnap=(await q('select ops.multi_branch_snapshot($1,$2) as j',[b,br]))[0].j;const masterBinding=masterSnap.masters.find(x=>x.id===created.masterItemId).bindings.find(x=>x.branchId===br2);
  check('local override survives master price propagation',masterBinding.cataloguePriceMinor==='12345'&&masterBinding.overridePriceMinor==='12345'&&masterBinding.effectivePriceMinor==='12345');
  const cleared=(await q("select ops.multi_branch_manage($1,$2,$3,'clear-local-price',$4::jsonb) as j",[b,br,op(3604),JSON.stringify({masterItemId:created.masterItemId,targetBranchId:br2,expectedOverrideVersion:'0'})]))[0].j;
  const clearedSnap=(await q('select ops.multi_branch_snapshot($1,$2) as j',[b,br]))[0].j;const clearedBinding=clearedSnap.masters.find(x=>x.id===created.masterItemId).bindings.find(x=>x.branchId===br2);
  check('clearing local price restores current master price',cleared.basePriceMinor==='17001'&&clearedBinding.cataloguePriceMinor==='17001'&&clearedBinding.overridePriceMinor===null&&clearedBinding.effectivePriceMinor==='17001');
  const snap=(await q('select ops.multi_branch_snapshot($1,$2) as j',[b,br]))[0].j;
  check('owner snapshot is business-scoped and reports branch bindings',snap.branches.length===2&&snap.masters.some(x=>x.id===created.masterItemId&&x.bindings.length===2));
  await rejects('authenticated clients cannot directly read master menu tables',()=>q('select * from ops.master_menu_items'),'42501');
  await db.exec('reset role');await q("insert into ops.branch_staff(business_id,branch_id,user_id,role,active) values($1,$2,$3,'manager',true) on conflict(business_id,branch_id,user_id) do update set role='manager',active=true",[b,br,users[1]]);await auth(users[1]);
  await rejects('manager cannot change another branch price',()=>q("select ops.multi_branch_manage($1,$2,$3,'set-local-price',$4::jsonb)",[b,br,op(3605),JSON.stringify({masterItemId:created.masterItemId,targetBranchId:br2,priceMinor:'9900',expectedOverrideVersion:'-1'})]),'OWNER_REQUIRED');
 }
`;
try{fs.writeFileSync(path,source.replace(marker,extra+marker));await import(pathToFileURL(path).href);}finally{fs.rmSync(path,{force:true});}if(process.exitCode)throw Error('Multi-branch SQL acceptance failed');
