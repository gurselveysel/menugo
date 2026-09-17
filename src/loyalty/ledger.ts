/** Backend only. Every public function requires ONE active DB transaction. */
import { createHash, randomUUID } from 'node:crypto';
import { DomainError, earned, fail, json, minor, stableKey, uuid } from '../shared.js';
import type { Account, LoyaltyTx, ProofScope, Transfer } from './contracts.js';

export interface Receipt {
  readonly entryId: string;
  readonly kind: Transfer['kind'];
  readonly points: bigint;
  readonly replayed: boolean;
}
function receipt(entry: Transfer, replayed = false): Receipt {
  return Object.freeze({ entryId: entry.id, kind: entry.kind, points: entry.points, replayed });
}
async function guarded<T>(tx: LoyaltyTx, work: () => Promise<T>): Promise<T> {
  try { return await work(); }
  catch (error: unknown) {
    tx.markFailed(error); // even a swallowed error must prevent outer COMMIT
    if (error instanceof DomainError) throw error;
    throw new DomainError('LOYALTY_RESULT_UNCONFIRMED_RETRY_SAME_KEY', error);
  }
}
function worker(tx: LoyaltyTx) {
  if (tx.scope.actor.kind !== 'settlement-worker') fail('WORKER_REQUIRED');
}
function context(tx: LoyaltyTx, checkId: string, accountId: string) {
  uuid(tx.scope.businessId); uuid(tx.scope.branchId); uuid(tx.scope.operationId);
  stableKey(tx.scope.sourceRef); uuid(checkId); uuid(accountId);
}
function hash(tx: LoyaltyTx, kind: string, accountId: string, checkId: string, args: unknown[]) {
  return createHash('sha256').update(json([
    kind,tx.scope.businessId,tx.scope.branchId,accountId,checkId,tx.scope.sourceRef,...args,
  ])).digest('hex');
}
function verifyProof(tx: LoyaltyTx, p: ProofScope, a: Account, checkId: string, sourceRef=tx.scope.sourceRef) {
  if (p.businessId!==tx.scope.businessId || p.branchId!==tx.scope.branchId ||
      p.checkId!==checkId || p.customerId!==a.customerId || p.sourceRef!==sourceRef)
    fail('PAYMENT_OWNER_OR_SCOPE_MISMATCH');
}
function verifyReplay(tx: LoyaltyTx, old: Transfer, accountId: string, checkId: string, digest: string) {
  if (old.businessId!==tx.scope.businessId || old.branchId!==tx.scope.branchId ||
    old.accountId!==accountId || old.checkId!==checkId || old.requestHash!==digest)
    fail('IDEMPOTENCY_CONFLICT');
  return receipt(old,true);
}
function transfer(tx: LoyaltyTx, a: Account, checkId: string, kind: Transfer['kind'],
  reason: Transfer['reason'], points: bigint, digest: string): Transfer {
  const inward = kind==='earn' || reason==='restore_spend';
  return {
    id:randomUUID(), businessId:tx.scope.businessId, branchId:tx.scope.branchId,
    accountId:a.id, checkId, kind, reason, points:minor(points),
    fromAccountId:inward?a.systemAccountId:a.id,
    fromBucket:inward?'control':kind==='spend'||kind==='release'?'held':'available',
    toAccountId:kind==='reserve'||kind==='release'||inward?a.id:a.systemAccountId,
    toBucket:kind==='reserve'?'held':kind==='release'||inward?'available':'control',
    operationKey:`op:${tx.scope.operationId}`, requestHash:digest, sourceRef:tx.scope.sourceRef,
    eligibleFoodMinor:null,awardRefundedFoodMinor:null,earnBps:null,
    resolvesReservationId:null,reversesEntryId:null,refundFoodCumulativeMinor:null,reviewAfter:null,
  };
}

/** amountMinor is an ASSERTION, not authority: verified against paid-food evidence. */
export async function awardPoints(
  tx: LoyaltyTx, accountId: string, checkId: string, amountMinor: bigint,
): Promise<Receipt> {
  return guarded(tx,async()=>{
    context(tx,checkId,accountId); worker(tx); minor(amountMinor);
    await tx.lockCheck(checkId);
    const proof = await tx.evidence.capturedFood(checkId); // locks share/capture allocation rows
    const account = await tx.lockAccount(accountId);
    verifyProof(tx,proof,account,checkId);
    const digest = hash(tx,'earn',accountId,checkId,[amountMinor]);
    const replay = await tx.operation(`op:${tx.scope.operationId}`);
    if (replay) return verifyReplay(tx,replay,accountId,checkId,digest);
    const original = await tx.earnBySource(proof.sourceRef);
    if (original) return verifyReplay(tx,original,accountId,checkId,digest);

    if (!account.active) fail('ACCOUNT_INACTIVE');
    if (proof.paymentState!=='captured' || !proof.orderCompleted || !proof.shareFullySettled) fail('NOT_SETTLED_AND_FULFILLED');
    if (proof.currency!=='TRY') fail('UNSUPPORTED_CURRENCY');
    for (const p of [proof.baseMinor,proof.tipMinor,proof.capturedMinor,
      proof.deliveryCashMinor,proof.foodCashPaidMinor,proof.refundedFoodCashMinor]) minor(p);
    if (proof.baseMinor!==proof.foodCashPaidMinor+proof.deliveryCashMinor ||
      proof.capturedMinor!==proof.baseMinor+proof.tipMinor ||
      proof.refundedFoodCashMinor>proof.foodCashPaidMinor) fail('INVALID_PAYMENT_ALLOCATION');
    const netFood = proof.foodCashPaidMinor-proof.refundedFoodCashMinor;
    if (netFood!==amountMinor) fail('PAID_FOOD_AMOUNT_MISMATCH');

    const entry = transfer(tx,account,checkId,'earn','paid_food',
      earned(netFood,proof.earnBpsAtSale),digest);
    entry.eligibleFoodMinor=proof.foodCashPaidMinor;
    entry.awardRefundedFoodMinor=proof.refundedFoodCashMinor;
    entry.earnBps=proof.earnBpsAtSale;
    await tx.append(entry); // zero earn is retained as a durable idempotent receipt
    return receipt(entry);
  });
}

/** Reserve available → held. NO spend and NO external call in this transaction. */
export async function reservePoints(
  tx: LoyaltyTx, accountId: string, checkId: string, pointsToSpend: bigint,
): Promise<Receipt> {
  return guarded(tx,async()=>{
    context(tx,checkId,accountId); minor(pointsToSpend,true);
    if (tx.scope.actor.kind!=='customer') fail('CUSTOMER_REQUIRED');
    await tx.lockCheck(checkId);
    const proof = await tx.evidence.redemption(checkId);
    const account = await tx.lockAccount(accountId);
    verifyProof(tx,proof,account,checkId);
    if (proof.ownerUserId!==tx.scope.actor.userId || account.ownerUserId!==tx.scope.actor.userId)
      fail('NOT_YOUR_LOYALTY_ACCOUNT');
    const digest=hash(tx,'reserve',accountId,checkId,[pointsToSpend]);
    const replay=await tx.operation(`op:${tx.scope.operationId}`);
    if (replay) return verifyReplay(tx,replay,accountId,checkId,digest);
    if (!account.active || !proof.reservationAllowed) fail('REDEMPTION_NOT_ALLOWED');
    if (pointsToSpend>minor(proof.maxRedeemableFoodMinor)) fail('REDEMPTION_EXCEEDS_FOOD_SHARE');
    if (await tx.unresolvedHold(accountId,checkId,proof.sourceRef)) fail('SHARE_ALREADY_HAS_HOLD');
    const balance=await tx.balance(accountId);
    if (pointsToSpend>balance.available) fail('INSUFFICIENT_POINTS');
    const entry=transfer(tx,account,checkId,'reserve','checkout_hold',pointsToSpend,digest);
    entry.reviewAfter=proof.reviewAfter; // advisory; only a confirmed outcome can close this hold
    await tx.append(entry);
    return receipt(entry);
  });
}

/** Called inside the verified settlement transaction; exact full hold only in v1. */
export async function resolveReservation(
  tx:LoyaltyTx, accountId:string, checkId:string, reserveEntryId:string,
  action:'capture'|'release',
):Promise<Receipt> {
  return guarded(tx,async()=>{
    context(tx,checkId,accountId); worker(tx); uuid(reserveEntryId);
    if (action!=='capture' && action!=='release') fail('INVALID_RESOLUTION');
    await tx.lockCheck(checkId);
    const hold=await tx.entry(reserveEntryId);
    if (!hold || hold.kind!=='reserve' || hold.accountId!==accountId || hold.checkId!==checkId)
      fail('RESERVATION_NOT_FOUND');
    const proof=await tx.evidence.resolution(hold);
    const account=await tx.lockAccount(accountId);
    verifyProof(tx,proof,account,checkId,hold.sourceRef);
    const kind=action==='capture'?'spend':'release';
    const digest=hash(tx,kind,accountId,checkId,[reserveEntryId]);
    const replay=await tx.operation(`op:${tx.scope.operationId}`);
    if (replay) return verifyReplay(tx,replay,accountId,checkId,digest);
    const closed=await tx.resolution(hold.id);
    if (closed) {
      if (closed.kind!==kind) fail('RESERVATION_ALREADY_RESOLVED_DIFFERENTLY');
      return receipt(closed,true);
    }
    if (!proof.definitive || (action==='capture' ? proof.paymentState!=='captured'
      : !['failed','cancelled'].includes(proof.paymentState))) fail('PAYMENT_OUTCOME_NOT_FINAL');
    const entry=transfer(tx,account,checkId,kind,
      action==='capture'?'checkout_capture':'checkout_cancel',hold.points,digest);
    entry.sourceRef=hold.sourceRef;
    entry.resolvesReservationId=hold.id;
    await tx.append(entry);
    return receipt(entry);
  });
}

/** Cumulative refund arithmetic: floor(original net) minus floor(remaining net). */
export async function reverseEarnForRefund(
  tx:LoyaltyTx, accountId:string, checkId:string, earnEntryId:string,
):Promise<Receipt> {
  return guarded(tx,async()=>{
    context(tx,checkId,accountId); worker(tx); uuid(earnEntryId);
    await tx.lockCheck(checkId);
    const original=await tx.entry(earnEntryId);
    if (!original || original.kind!=='earn' || original.accountId!==accountId ||
      original.checkId!==checkId || original.eligibleFoodMinor===null ||
      original.awardRefundedFoodMinor===null || original.earnBps===null) fail('EARN_NOT_FOUND');
    const proof=await tx.evidence.refund(original);
    const account=await tx.lockAccount(accountId);
    verifyProof(tx,proof,account,checkId,original.sourceRef);
    const digest=hash(tx,'reverse_earn',accountId,checkId,[earnEntryId]);
    const replay=await tx.operation(`op:${tx.scope.operationId}`);
    if (replay) return verifyReplay(tx,replay,accountId,checkId,digest);
    if (!proof.confirmed) fail('REFUND_NOT_CONFIRMED');
    const cumulative=minor(proof.cumulativeFoodCashRefundedMinor);
    let previous=original.awardRefundedFoodMinor, reversed=0n;
    for (const r of await tx.refunds(original.id)) {
      reversed+=r.points;
      if (r.refundFoodCumulativeMinor!==null && r.refundFoodCumulativeMinor>previous)
        previous=r.refundFoodCumulativeMinor;
    }
    if (cumulative<previous || cumulative>original.eligibleFoodMinor) fail('INVALID_REFUND_CUMULATIVE');
    const target=original.points-earned(original.eligibleFoodMinor-cumulative,original.earnBps);
    const entry=transfer(tx,account,checkId,'refund','reverse_earn',minor(target-reversed),digest);
    entry.reversesEntryId=original.id;
    entry.refundFoodCumulativeMinor=cumulative;
    await tx.append(entry); // may create negative available debt, never hide it with max(0,...)
    return receipt(entry);
  });
}

/** Return previously redeemed points once; never mint a cash refund for these points. */
export async function restoreSpentPoints(
  tx:LoyaltyTx, accountId:string, checkId:string, spendEntryId:string,
):Promise<Receipt> {
  return guarded(tx,async()=>{
    context(tx,checkId,accountId); worker(tx); uuid(spendEntryId);
    await tx.lockCheck(checkId);
    const original=await tx.entry(spendEntryId);
    if (!original || original.kind!=='spend' || original.accountId!==accountId || original.checkId!==checkId)
      fail('SPEND_NOT_FOUND');
    const proof=await tx.evidence.refund(original);
    const account=await tx.lockAccount(accountId);
    verifyProof(tx,proof,account,checkId,original.sourceRef);
    const digest=hash(tx,'restore_spend',accountId,checkId,[spendEntryId]);
    const replay=await tx.operation(`op:${tx.scope.operationId}`);
    if (replay) return verifyReplay(tx,replay,accountId,checkId,digest);
    if (!proof.confirmed) fail('REFUND_NOT_CONFIRMED');
    const target=minor(proof.cumulativeRedeemedPointsReturned);
    let restored=0n;
    for (const r of await tx.refunds(original.id)) restored+=r.points;
    if (target>original.points || target<restored) fail('INVALID_REDEMPTION_REFUND');
    const entry=transfer(tx,account,checkId,'refund','restore_spend',target-restored,digest);
    entry.reversesEntryId=original.id;
    await tx.append(entry);
    return receipt(entry);
  });
}
