import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
export async function controlConcurrency(a,b){
 for(const c of[a,b]){await c.query('reset role');await c.query("set lock_timeout='4s'");}
 const owner=(await a.query("select user_id from ops.platform_staff where active and role='platform_owner' limit 1")).rows[0].user_id;
 for(const c of[a,b]){await c.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:owner,role:'authenticated'})]);await c.query('set role authenticated');}
 let s=(await a.query('select ops.platform_control_snapshot(null,null) j')).rows[0].j;
 const vals=[{...s.settings,dailyAiLimit:41},{...s.settings,dailyAiLimit:42}];
 const responses=await Promise.allSettled([a,b].map((c,i)=>c.query('select ops.platform_control_save(null,null,$1,$2,$3::jsonb,$4) j',[randomUUID(),s.version,JSON.stringify(vals[i]),'Concurrent policy acceptance'])));
 assert.equal(responses.filter(x=>x.status==='fulfilled').length,1);assert.ok(responses.some(x=>x.status==='rejected'&&x.reason.message==='PLATFORM_VERSION_CHANGED'));
 s=(await a.query('select ops.platform_control_snapshot(null,null) j')).rows[0].j;
 const params=[randomUUID(),s.version,JSON.stringify({...s.settings,dailyAiLimit:50}),'Identical idempotent policy'];
 const replay=await Promise.all([a,b].map(c=>c.query('select ops.platform_control_save(null,null,$1,$2,$3::jsonb,$4) j',params)));
 assert.deepEqual(replay[0].rows[0].j,replay[1].rows[0].j);
 console.log('PLATFORM POLICY NATIVE CONCURRENCY PASS: one commit for conflicting revisions; identical key replays same receipt.');
 for(const c of[a,b])await c.query('reset role');
}
