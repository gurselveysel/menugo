// Isolated PGlite acceptance for demand/waste evidence functions; never contacts production.
import fs from'node:fs';import{pathToFileURL}from'node:url';import{resolve}from'node:path';
const path=resolve('tests/.demand-waste-fixture.mjs');const marker=" fs.mkdirSync('test-results',{recursive:true});fs.writeFileSync('test-results/sql.json'";const source=fs.readFileSync('tests/sql.integration.mjs','utf8');if(!source.includes(marker))throw Error('Acceptance fixture contract changed');
const extra=`
 {
  await auth(users[0]);
  const read=async()=> (await q('select ops.demand_waste_snapshot($1,$2,28) as j',[b,br]))[0].j;
  const first=await read();
  check('demand baseline stays closed without sufficient real history',first.demandReady===false&&first.baselineNextDayMilli===undefined);
  check('demand snapshot reports evidence counts instead of fabricating forecast',BigInt(first.completedOrders)<50n&&Array.isArray(first.reasons)&&first.reasons.length>0);
  const key=op(3500);
  const one=(await q("select ops.record_waste_event($1,$2,'TIR-TEST-1',500,'prep',$3) as j",[b,br,key]))[0].j;
  check('owner can record explicit waste evidence',one.replayed===false&&one.quantityMilli==='500');
  const replay=(await q("select ops.record_waste_event($1,$2,'TIR-TEST-1',500,'prep',$3) as j",[b,br,key]))[0].j;
  check('waste operation is idempotent',replay.replayed===true&&replay.id===one.id);
  await rejects('waste idempotency key cannot change intent',()=>q("select ops.record_waste_event($1,$2,'TIR-TEST-1',700,'prep',$3)",[b,br,key]),'IDEMPOTENCY_CONFLICT');
  const after=await read();check('waste evidence count is real and observable',BigInt(after.wasteEvents)>=1n);
  await rejects('authenticated clients cannot directly read waste table',()=>q('select * from ops.waste_events'),'42501');
  await auth(users[1]);
  await rejects('customer cannot read demand/waste evidence',()=>q('select ops.demand_waste_snapshot($1,$2,28)',[b,br]),'OPERATIONS_STAFF_REQUIRED');
  await rejects('customer cannot record waste evidence',()=>q("select ops.record_waste_event($1,$2,'TIR-TEST-1',500,'prep',$3)",[b,br,op(3501)]),'OPERATIONS_STAFF_REQUIRED');
 }
`;
try{fs.writeFileSync(path,source.replace(marker,extra+marker));await import(pathToFileURL(path).href);}finally{fs.rmSync(path,{force:true});}if(process.exitCode)throw Error('Demand/waste SQL acceptance failed');
