/** Parameterized PostgreSQL adapter; NO independent PostgREST calls inside a transaction. */
import { DomainError, fail, stableKey, uuid, MAX_I64 } from '../shared.js';
import type {
  Account, CurrencyScope, EvidencePort, LoyaltyTx, PoolPort,
  QueryClient, Transfer,
} from './contracts.js';

type Row = Record<string, unknown>;
const columns=`id,business_id,branch_id,account_id,check_id,kind,reason,
 from_account_id,from_bucket,to_account_id,to_bucket,points::text,operation_key,
 request_hash,source_ref,eligible_food_minor::text,award_refunded_food_minor::text,
 earn_bps::text,resolves_reservation_id,reverses_entry_id,refund_food_cumulative_minor::text,review_after`;
function str(r:Row,k:string):string { if(typeof r[k]!=='string') fail('INVALID_DB_ROW'); return r[k]; }
function nullable(r:Row,k:string):string|null { return r[k]===null?null:str(r,k); }
function int(r:Row,k:string):bigint {
  const s=str(r,k); if(!/^-?(0|[1-9][0-9]*)$/.test(s)) fail('INVALID_DB_INTEGER');
  const n=BigInt(s); if(n < -MAX_I64-1n || n>MAX_I64) fail('DB_INTEGER_OVERFLOW'); return n;
}
function optInt(r:Row,k:string):bigint|null { return r[k]===null?null:int(r,k); }
function decode(r:Row):Transfer {
  return {
    id:str(r,'id'), businessId:str(r,'business_id'),branchId:str(r,'branch_id'),
    accountId:str(r,'account_id'),checkId:str(r,'check_id'),
    kind:str(r,'kind') as Transfer['kind'],reason:str(r,'reason') as Transfer['reason'],
    fromAccountId:str(r,'from_account_id'),fromBucket:str(r,'from_bucket') as Transfer['fromBucket'],
    toAccountId:str(r,'to_account_id'),toBucket:str(r,'to_bucket') as Transfer['toBucket'],
    points:int(r,'points'),operationKey:str(r,'operation_key'),requestHash:str(r,'request_hash'),
    sourceRef:str(r,'source_ref'),eligibleFoodMinor:optInt(r,'eligible_food_minor'),
    awardRefundedFoodMinor:optInt(r,'award_refunded_food_minor'),earnBps:optInt(r,'earn_bps'),
    resolvesReservationId:nullable(r,'resolves_reservation_id'),reversesEntryId:nullable(r,'reverses_entry_id'),
    refundFoodCumulativeMinor:optInt(r,'refund_food_cumulative_minor'),
    reviewAfter:r.review_after===null?null:r.review_after instanceof Date
      ?r.review_after.toISOString():str(r,'review_after'),
  };
}

class PgLoyaltyTx implements LoyaltyTx {
  private active=true;
  private poisoned=false;
  private check:string|null=null;
  private account:string|null=null;
  readonly evidence:LoyaltyTx['evidence'];
  constructor(private db:QueryClient,readonly scope:CurrencyScope,proofs:EvidencePort){
    this.evidence={
      capturedFood:async checkId=>{this.beforeProof(checkId);return proofs.capturedFood(db,scope,checkId);},
      redemption:async checkId=>{this.beforeProof(checkId);return proofs.redemption(db,scope,checkId);},
      resolution:async hold=>{this.beforeProof(hold.checkId);return proofs.resolution(db,scope,hold);},
      refund:async original=>{this.beforeProof(original.checkId);return proofs.refund(db,scope,original);},
    };
  }
  private ready(){if(!this.active||this.poisoned)fail('TRANSACTION_NOT_USABLE');}
  private beforeProof(checkId:string){this.ready();if(this.check!==checkId||this.account!==null)fail('INVALID_LOCK_ORDER');}
  private async q(sql:string,args:unknown[]=[]){this.ready();return this.db.query(sql,args);}
  markFailed(_error:unknown){this.poisoned=true;}
  assertCommit(){this.ready();}
  close(){this.active=false;}
  async lockCheck(checkId:string){
    checkId=uuid(checkId);
    if(this.check!==null&&this.check!==checkId)fail('ONE_CHECK_PER_TRANSACTION');
    if(this.account!==null)fail('CHECK_LOCK_MUST_PRECEDE_ACCOUNT');
    await this.q('select id from ops.lock_check($1,$2,$3,null)',
      [this.scope.businessId,this.scope.branchId,checkId]);
    this.check=checkId;
  }
  async lockAccount(accountId:string):Promise<Account>{
    accountId=uuid(accountId);if(this.check===null)fail('CHECK_LOCK_REQUIRED');
    if(this.account!==null&&this.account!==accountId)fail('ONE_CUSTOMER_PER_TRANSACTION');
    const result=await this.q(`select a.id,a.customer_id,a.earn_bps::text,a.active,
      c.auth_user_id,s.id as system_account_id
      from ops.loyalty_accounts a join ops.customers c
        on c.business_id=a.business_id and c.branch_id=a.branch_id and c.id=a.customer_id
      join ops.loyalty_accounts s on s.business_id=a.business_id and s.branch_id=a.branch_id and s.kind='system'
      where a.business_id=$1 and a.branch_id=$2 and a.id=$3 and a.kind='customer'
      for update of a`,[this.scope.businessId,this.scope.branchId,accountId]);
    const row=result.rows[0];if(!row)fail('ACCOUNT_NOT_FOUND');
    this.account=accountId;
    return {id:str(row,'id'),customerId:str(row,'customer_id'),ownerUserId:nullable(row,'auth_user_id'),
      active:row.active===true,earnBps:int(row,'earn_bps'),systemAccountId:str(row,'system_account_id')};
  }
  async balance(accountId:string){
    if(this.account!==accountId)fail('ACCOUNT_LOCK_REQUIRED');
    const result=await this.q(`select available::text,held::text
      from ops.loyalty_balances($1,$2,$3)`,[this.scope.businessId,this.scope.branchId,accountId]);
    const r=result.rows[0];if(!r)fail('BALANCE_NOT_FOUND');return {available:int(r,'available'),held:int(r,'held')};
  }
  private async find(predicate:string,args:unknown[]):Promise<Transfer|null>{
    const result=await this.q(`select ${columns} from ops.loyalty_ledger
      where business_id=$1 and branch_id=$2 and (${predicate}) order by posting_no limit 1`,
    [this.scope.businessId,this.scope.branchId,...args]);
    return result.rows[0]?decode(result.rows[0]):null;
  }
  operation(key:string){return this.find('operation_key=$3',[key]);}
  entry(id:string){return this.find('id=$3',[uuid(id)]);}
  earnBySource(ref:string){return this.find("kind='earn' and source_ref=$3",[stableKey(ref)]);}
  unresolvedHold(accountId:string,checkId:string,ref:string){
    return this.find(`kind='reserve' and account_id=$3 and check_id=$4 and source_ref=$5
      and not exists(select 1 from ops.loyalty_ledger z where z.resolves_reservation_id=ops.loyalty_ledger.id)`,
    [accountId,checkId,stableKey(ref)]);
  }
  resolution(id:string){return this.find('resolves_reservation_id=$3',[uuid(id)]);}
  async refunds(id:string){
    const result=await this.q(`select ${columns} from ops.loyalty_ledger
      where business_id=$1 and branch_id=$2 and reverses_entry_id=$3 and kind='refund' order by posting_no`,
    [this.scope.businessId,this.scope.branchId,uuid(id)]);
    return result.rows.map(decode);
  }
  async append(e:Transfer){
    if(this.check!==e.checkId || this.account!==e.accountId ||
      e.businessId!==this.scope.businessId || e.branchId!==this.scope.branchId)fail('WRITE_SCOPE_MISMATCH');
    await this.q(`insert into ops.loyalty_ledger(id,business_id,branch_id,account_id,check_id,
      kind,reason,from_account_id,from_bucket,to_account_id,to_bucket,points,
      operation_key,request_hash,source_ref,eligible_food_minor,award_refunded_food_minor,earn_bps,
      resolves_reservation_id,reverses_entry_id,refund_food_cumulative_minor,review_after)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`,
    [e.id,e.businessId,e.branchId,e.accountId,e.checkId,e.kind,e.reason,e.fromAccountId,e.fromBucket,
      e.toAccountId,e.toBucket,e.points.toString(),e.operationKey,e.requestHash,e.sourceRef,
      e.eligibleFoodMinor?.toString()??null,e.awardRefundedFoodMinor?.toString()??null,e.earnBps?.toString()??null,
      e.resolvesReservationId,e.reversesEntryId,e.refundFoodCumulativeMinor?.toString()??null,e.reviewAfter]);
  }
}

/** db parameter allows the existing payment settlement writer to share THIS transaction. */
export async function withLoyaltyTransaction<T>(
  pool:PoolPort,scopeInput:CurrencyScope,proofs:EvidencePort,
  work:(tx:LoyaltyTx,db:QueryClient)=>Promise<T>,
):Promise<T>{
  const scope:CurrencyScope=Object.freeze({
    businessId:uuid(scopeInput.businessId),branchId:uuid(scopeInput.branchId),
    operationId:uuid(scopeInput.operationId),sourceRef:stableKey(scopeInput.sourceRef),
    actor:Object.freeze(scopeInput.actor.kind==='customer'
      ? {kind:'customer' as const,userId:uuid(scopeInput.actor.userId)}
      : scopeInput.actor.kind==='settlement-worker'?{kind:'settlement-worker' as const}
      : fail('INVALID_ACTOR')),
  });
  const client=await pool.connect();let tx:PgLoyaltyTx|undefined;let destroy=false;
  try{
    await client.query('begin isolation level read committed');
    await client.query("set local lock_timeout='3s'");
    await client.query("set local statement_timeout='10s'");
    await client.query("set local idle_in_transaction_session_timeout='15s'");
    tx=new PgLoyaltyTx(client,scope,proofs);
    const result=await work(tx,client);
    tx.assertCommit();
    await client.query('commit');
    return result;
  }catch(error:unknown){
    try{await client.query('rollback');}catch{destroy=true;}
    if(error instanceof DomainError)throw error;
    // Includes a lost COMMIT response. Retry the same operation key, never assume rollback.
    throw new DomainError('LOYALTY_RESULT_UNCONFIRMED_RETRY_SAME_KEY',error);
  }finally{tx?.close();client.release(destroy);}
}
