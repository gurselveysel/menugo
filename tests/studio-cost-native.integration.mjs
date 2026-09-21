// Isolated CI PostgreSQL concurrency for append-only recipe versions. Never contacts production.
import assert from 'node:assert/strict';import {Client} from 'pg';
const connectionString=process.env.POSTGRES_TEST_URL;if(!connectionString)throw Error('POSTGRES_TEST_URL required');const u=new URL(connectionString);if(!['127.0.0.1','localhost'].includes(u.hostname)||u.pathname!=='/menugo_ci')throw Error('Only disposable local menugo_ci is allowed');
const a=new Client({connectionString}),b=new Client({connectionString});
try{await a.connect();await b.connect();const owner=(await a.query("select s.business_id,s.branch_id,s.user_id from ops.branch_staff s where s.role='owner' and s.active order by s.created_at limit 1")).rows[0];assert.ok(owner);const product=(await a.query('select id from public.menu_items where business_id=$1 and branch_id=$2 order by id limit 1',[owner.business_id,owner.branch_id])).rows[0].id;
 for(const c of[a,b]){await c.query('reset role');await c.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:owner.user_id,role:'authenticated'})]);await c.query('set role authenticated');await c.query("set lock_timeout='3s'");}
 const base={productId:product,name:'Parallel cost recipe',portions:2,overheadMinor:'0',confirmed:true,ingredients:[{name:'Ingredient',unit:'g',packQuantity:'1000',packCostMinor:'10000',recipeQuantity:'100',edibleYieldBps:10000}]};
 const payloads=[0,1].map(i=>JSON.stringify({...base,operationId:`99999999-9999-4999-8999-${String(9000+i).padStart(12,'0')}`}));
 const results=await Promise.all([a,b].map((c,i)=>c.query("select ops.studio_cost_ledger($1,$2,'save-recipe',$3::jsonb) j",[owner.business_id,owner.branch_id,payloads[i]])));
 const versions=results.map(x=>Number(x.rows[0].j.version)).sort((x,y)=>x-y);assert.equal(versions[1]-versions[0],1);assert.equal(new Set(results.map(x=>x.rows[0].j.recipeId)).size,2);
 console.log('NATIVE COST LEDGER CONCURRENCY PASS: simultaneous recipe saves serialize into distinct append-only versions.');
}finally{await a.query('ROLLBACK').catch(()=>{});await b.query('ROLLBACK').catch(()=>{});await a.end().catch(()=>{});await b.end().catch(()=>{});}
