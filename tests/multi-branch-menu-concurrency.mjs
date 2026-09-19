// Disposable PostgreSQL 17 concurrency acceptance; never contacts production.
import assert from'node:assert/strict';import{Client}from'pg';
const connectionString=process.env.POSTGRES_TEST_URL;if(!connectionString)throw Error('POSTGRES_TEST_URL required');const u=new URL(connectionString);if(!['127.0.0.1','localhost'].includes(u.hostname)||u.pathname!=='/menugo_ci')throw Error('Only disposable local menugo_ci is allowed');
const business='11111111-1111-4111-8111-111111111111',branch='22222222-2222-4222-8222-222222222222',owner='33333333-3333-4333-8333-333333333331';
const op=n=>`bbbbbbbb-bbbb-4bbb-8bbb-${String(n).padStart(12,'0')}`;const a=new Client({connectionString}),b=new Client({connectionString});
async function auth(c){await c.query('reset role');await c.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:owner,role:'authenticated'})]);await c.query('set role authenticated');}
try{await a.connect();await b.connect();await auth(a);await auth(b);
 let master=(await a.query("select id,version::text from ops.master_menu_items where business_id=$1 and master_key='TIR-TEST-1'",[business])).rows[0];
 if(!master){const j=(await a.query("select ops.multi_branch_manage($1,$2,$3,'create-master',$4::jsonb) j",[business,branch,op(1),JSON.stringify({productSourceId:'TIR-TEST-1'})])).rows[0].j;master={id:j.masterItemId,version:j.version};}
 const expected=master.version;const calls=[[a,'18001',op(2)],[b,'18002',op(3)]].map(([c,p,k])=>c.query("select ops.multi_branch_manage($1,$2,$3,'set-master-price',$4::jsonb) j",[business,branch,k,JSON.stringify({masterItemId:master.id,priceMinor:p,expectedVersion:expected})]));
 const settled=await Promise.allSettled(calls);assert.equal(settled.filter(x=>x.status==='fulfilled').length,1);assert.equal(settled.filter(x=>x.status==='rejected'&&String(x.reason?.message).includes('MASTER_ITEM_CHANGED')).length,1);
 const row=(await a.query('select version::text,base_price_minor::text from ops.master_menu_items where id=$1',[master.id])).rows[0];assert.equal(row.version,(BigInt(expected)+1n).toString());assert.ok(['18001','18002'].includes(row.base_price_minor));console.log('MULTI BRANCH CONCURRENCY PASS: one master-price write wins, stale concurrent writer is rejected.');
}finally{await a.query('rollback').catch(()=>{});await b.query('rollback').catch(()=>{});await a.end().catch(()=>{});await b.end().catch(()=>{});}
