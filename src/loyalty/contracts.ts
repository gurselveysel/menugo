import type { CurrencyScope } from './scope.js';
export type { CurrencyScope } from './scope.js';

export interface QueryClient {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string, values?: unknown[],
  ): Promise<{ rows: Row[]; rowCount: number | null }>;
}
export interface PoolClient extends QueryClient { release(destroy?: boolean): void }
export interface PoolPort { connect(): Promise<PoolClient> }

export interface Account {
  id: string; customerId: string; ownerUserId: string | null;
  systemAccountId: string; active: boolean; earnBps: bigint;
}
export type Bucket = 'available' | 'held' | 'control';
export type Kind = 'earn' | 'reserve' | 'spend' | 'release' | 'refund' | 'expire';
export type Reason = 'paid_food' | 'checkout_hold' | 'checkout_capture' |
  'checkout_cancel' | 'reverse_earn' | 'restore_spend' | 'policy_expiry';
export interface Transfer {
  id: string; businessId: string; branchId: string; accountId: string;
  checkId: string; kind: Kind; reason: Reason;
  fromAccountId: string; fromBucket: Bucket;
  toAccountId: string; toBucket: Bucket; points: bigint;
  operationKey: string; requestHash: string; sourceRef: string;
  eligibleFoodMinor: bigint | null; awardRefundedFoodMinor: bigint | null;
  earnBps: bigint | null; resolvesReservationId: string | null;
  reversesEntryId: string | null; refundFoodCumulativeMinor: bigint | null;
  reviewAfter: string | null;
}
export interface ProofScope {
  businessId: string; branchId: string; checkId: string; customerId: string;
  sourceRef: string; // stable capture+share identity / stable checkout-share identity
}
export interface CapturedFoodProof extends ProofScope {
  paymentState: 'captured' | 'pending' | 'unknown' | 'failed';
  orderCompleted: boolean;
  shareFullySettled: boolean;
  currency: 'TRY';
  baseMinor: bigint;
  tipMinor: bigint;
  capturedMinor: bigint;
  deliveryCashMinor: bigint;
  // After discounts, EXCLUDING loyalty-funded value; already allocated to this payer.
  foodCashPaidMinor: bigint;
  refundedFoodCashMinor: bigint; // authoritative cumulative, may precede this award
  earnBpsAtSale: bigint; // persisted policy snapshot, never client supplied
}
export interface RedeemProof extends ProofScope {
  ownerUserId: string;
  reservationAllowed: boolean;
  maxRedeemableFoodMinor: bigint; // food only, after existing discounts/allocations
  reviewAfter: string;
}
export interface ResolutionProof extends ProofScope {
  paymentState: 'captured' | 'cancelled' | 'failed' | 'pending' | 'unknown';
  // For failure/cancellation, confirms no in-flight attempt can later capture.
  definitive: boolean;
}
export interface RefundProof extends ProofScope {
  confirmed: boolean;
  cumulativeFoodCashRefundedMinor: bigint;
  cumulativeRedeemedPointsReturned: bigint;
}

/**
 * REQUIRED integration boundary. Implement using ONLY verified payment/share/allocation rows.
 * Each method uses the supplied SQL client and locks financial rows AFTER the check lock,
 * BEFORE the loyalty account lock. Do not make network calls or trust request-body flags.
 * Must authorize the scope actor as well. Implementations must return DB bigint as bigint.
 * Actual payment tables are not assumed to exist by this module.
 */
export interface EvidencePort {
  capturedFood(db: QueryClient, scope: CurrencyScope, checkId: string): Promise<CapturedFoodProof>;
  redemption(db: QueryClient, scope: CurrencyScope, checkId: string): Promise<RedeemProof>;
  resolution(db: QueryClient, scope: CurrencyScope, hold: Transfer): Promise<ResolutionProof>;
  refund(db: QueryClient, scope: CurrencyScope, original: Transfer): Promise<RefundProof>;
}
export interface LoyaltyTx {
  readonly scope: CurrencyScope;
  readonly evidence: {
    capturedFood(checkId: string): Promise<CapturedFoodProof>;
    redemption(checkId: string): Promise<RedeemProof>;
    resolution(hold: Transfer): Promise<ResolutionProof>;
    refund(original: Transfer): Promise<RefundProof>;
  };
  markFailed(error: unknown): void;
  lockCheck(checkId: string): Promise<void>;
  lockAccount(accountId: string): Promise<Account>;
  balance(accountId: string): Promise<{ available: bigint; held: bigint }>;
  operation(operationKey: string): Promise<Transfer | null>;
  entry(entryId: string): Promise<Transfer | null>;
  earnBySource(sourceRef: string): Promise<Transfer | null>;
  unresolvedHold(accountId: string, checkId: string, sourceRef: string): Promise<Transfer | null>;
  resolution(holdId: string): Promise<Transfer | null>;
  refunds(originalId: string): Promise<readonly Transfer[]>;
  append(entry: Transfer): Promise<void>;
}
