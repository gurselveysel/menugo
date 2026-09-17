import type {Pool} from 'pg';import type {SmsLease,SendPermit} from './winback';
/** Parameterized calls; RPC functions own their short transactions. HTTP lives outside them. */
export class CrmRepository{constructor(private readonly pool:Pool){}
 async evaluate(){const r=await this.pool.query('select ops.crm_enqueue() as result');return r.rows[0].result;}
 async claim():Promise<SmsLease|null>{const r=await this.pool.query('select ops.crm_claim() as result');return r.rows[0].result;}
 async prepare(l:SmsLease):Promise<SendPermit|null>{const r=await this.pool.query('select ops.crm_prepare_send($1::uuid,$2::uuid) as result',[l.id,l.leaseToken]);return r.rows[0].result;}
 async finish(l:SmsLease,state:'accepted'|'unknown'|'failed',ref:string|null,reason:string|null){const r=await this.pool.query('select ops.crm_finish($1::uuid,$2::uuid,$3,$4,$5) as result',[l.id,l.leaseToken,state,ref,reason]);return r.rows[0].result===true;}
}
