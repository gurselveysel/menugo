/** Yalnız backend'de import edin. PSP ve ağ çağrısı içermez. */
import { assertMinor, assertTipBps, MoneyError, tipFor } from '../money/split.js';

export type Currency = 'TRY';
export type IntentStatus =
  | 'created' | 'initiating' | 'pending' | 'unknown'
  | 'captured' | 'failed' | 'cancelled';

export const BLOCKING_INTENT_STATUSES: readonly IntentStatus[] = Object.freeze([
  'created', 'initiating', 'pending', 'unknown', 'captured',
]);

export class CheckoutError extends Error {
  constructor(public readonly code: string, cause?: unknown) {
    super(code, cause === undefined ? undefined : { cause });
    this.name = 'CheckoutError';
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function uuid(value: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw new CheckoutError('INVALID_UUID');
  }
  return value.toLowerCase();
}

export interface PaymentIntent {
  readonly paymentId: string;
  readonly checkId: string;
  readonly currency: Currency;
  readonly baseMinor: bigint;
  readonly tipMinor: bigint;
  readonly amountMinor: bigint;
  readonly lines: readonly Readonly<{ name: string; amountMinor: bigint }>[];
}

/** JSON sınırında sayılar değil, tam sayı kuruş metinleri kullanılır. */
export interface PaymentPayload {
  readonly paymentId: string;
  readonly checkId: string;
  readonly currency: Currency;
  readonly baseMinor: string;
  readonly tipMinor: string;
  readonly amountMinor: string;
  readonly lines: readonly Readonly<{ name: string; amountMinor: string }>[];
}

/** Saf oluşturucu. baseMinor yalnızca kilitli, yetkilendirilmiş DB payından gelir. */
export function buildPaymentIntent(input: {
  paymentId: string;
  checkId: string;
  currency: Currency;
  baseMinor: bigint;
  tipBps?: number;
}): PaymentIntent {
  const paymentId = uuid(input.paymentId);
  const checkId = uuid(input.checkId);
  if (input.currency !== 'TRY') throw new CheckoutError('UNSUPPORTED_CURRENCY');
  assertMinor(input.baseMinor);
  if (input.baseMinor === 0n) throw new CheckoutError('ZERO_SHARE_NO_PAYMENT');

  const tipMinor = tipFor(input.baseMinor, input.tipBps === undefined ? 0 : input.tipBps);
  const amountMinor = input.baseMinor + tipMinor;
  assertMinor(amountMinor); // BigInt sınırsız olsa da PostgreSQL bigint sınırlıdır.

  const lines = [{ name: 'Adisyon payı', amountMinor: input.baseMinor }];
  if (tipMinor > 0n) lines.push({ name: 'Gönüllü bahşiş', amountMinor: tipMinor });

  return Object.freeze({
    paymentId, checkId, currency: input.currency,
    baseMinor: input.baseMinor, tipMinor, amountMinor,
    lines: Object.freeze(lines.map(line => Object.freeze(line))),
  });
}

/** Saf JSON dönüştürücü; DB'den gelen tekrar yanıtını da doğrular. */
export function toPaymentPayload(intent: PaymentIntent): PaymentPayload {
  const paymentId = uuid(intent.paymentId);
  const checkId = uuid(intent.checkId);
  if (intent.currency !== 'TRY') throw new CheckoutError('UNSUPPORTED_CURRENCY');
  for (const value of [intent.baseMinor, intent.tipMinor, intent.amountMinor]) {
    assertMinor(value);
  }
  if (intent.baseMinor === 0n || intent.baseMinor + intent.tipMinor !== intent.amountMinor) {
    throw new CheckoutError('INVALID_INTENT_TOTAL');
  }
  const expected = [{ name: 'Adisyon payı', amountMinor: intent.baseMinor }];
  if (intent.tipMinor > 0n) expected.push({ name: 'Gönüllü bahşiş', amountMinor: intent.tipMinor });
  if (!Array.isArray(intent.lines) || intent.lines.length !== expected.length ||
      expected.some((line, i) => intent.lines[i]?.name !== line.name ||
        intent.lines[i]?.amountMinor !== line.amountMinor)) {
    throw new CheckoutError('INVALID_INTENT_LINES');
  }
  return Object.freeze({
    paymentId, checkId, currency: intent.currency,
    baseMinor: intent.baseMinor.toString(),
    tipMinor: intent.tipMinor.toString(),
    amountMinor: intent.amountMinor.toString(),
    lines: Object.freeze(expected.map(line => Object.freeze({
      name: line.name, amountMinor: line.amountMinor.toString(),
    }))),
  });
}

/** Bu kimlikler HTTP gövdesinden değil, doğrulanmış sunucu bağlamından gelir. */
export interface PaymentScope {
  readonly businessId: string;
  readonly branchId: string;
  readonly checkId: string;
  readonly shareId: string;
  readonly actorUserId: string;
}
export interface IntentRequest {
  readonly operationId: string;
  readonly tipBps?: number;
}
export interface LockedShare extends PaymentScope {
  readonly currency: Currency;
  readonly remainingBaseMinor: bigint;
  readonly payable: boolean;
}
export interface StoredIntent {
  readonly scope: PaymentScope;
  readonly operationId: string;
  readonly tipBps: number;
  readonly status: IntentStatus;
  readonly intent: PaymentIntent;
}
export interface IntentResult {
  readonly replayed: boolean;
  readonly status: IntentStatus;
  readonly payload: PaymentPayload;
}

/**
 * Gerçek PostgreSQL adapter sözleşmesi; bu dosya DB adapter'ı içermez.
 * Tüm metotlar AYNI connection ve transaction üzerinde çalışmalıdır.
 * SQL parametreleri bağlanmalı; sayılar metinden BigInt ile okunmalıdır.
 */
export interface IntentTransaction {
  /**
   * Yetkiyi doğrula; ops.lock_check(...) ile check, ardından share FOR UPDATE.
   * Check/pay durumunu replay'i engellemek için kullanma; yeni intent için payable dön.
   * Payı auth kullanıcısıyla, aktif planla ve ayrılmış borçlarla doğrula.
   */
  lockAndAuthorizeShare(scope: PaymentScope): Promise<LockedShare>;
  /** Aynı işlem başka check/share'de kullanıldıysa da bul: dar share filtresi EKLEME. */
  findByOperation(key: {
    businessId: string; actorUserId: string; operationId: string;
  }): Promise<StoredIntent | null>;
  /** BLOCKING_INTENT_STATUSES içindeki TÜM statüleri kontrol et. */
  findBlockingIntent(scope: PaymentScope): Promise<StoredIntent | null>;
  /** Persisted tutarlar bigint; başlangıç durumu created; unique index'ler zorunlu. */
  insertCreated(record: StoredIntent): Promise<void>;
}
export interface IntentRepository {
  /** Callback hatasında ROLLBACK; başarıda COMMIT. Dönüş ancak commit'ten sonra. */
  transaction<T>(work: (tx: IntentTransaction) => Promise<T>): Promise<T>;
}

const scopeKeys = ['businessId', 'branchId', 'checkId', 'shareId', 'actorUserId'] as const;
function sameScope(a: PaymentScope, b: PaymentScope): boolean {
  return scopeKeys.every(key => a[key] === b[key]);
}

/** Kullanıcı kimliği API'de doğrulanmış olsa da DB adapter yetkiyi tekrar kontrol eder. */
export async function createPaymentIntent(
  scopeInput: PaymentScope,
  request: IntentRequest,
  repository: IntentRepository,
  newPaymentId: () => string = () => globalThis.crypto.randomUUID(),
): Promise<IntentResult> {
  try {
    const scope = Object.freeze({
      businessId: uuid(scopeInput.businessId), branchId: uuid(scopeInput.branchId),
      checkId: uuid(scopeInput.checkId), shareId: uuid(scopeInput.shareId),
      actorUserId: uuid(scopeInput.actorUserId),
    });
    if (!request || typeof request !== 'object' || Array.isArray(request) ||
        Object.keys(request).some(k => k !== 'operationId' && k !== 'tipBps')) {
      throw new CheckoutError('INVALID_INTENT_REQUEST');
    }
    const operationId = uuid(request.operationId);
    // Null veya metin kabul etme; sadece gönderilmemiş oran varsayılan 0 olur.
    const tipBps = request.tipBps === undefined ? 0 : request.tipBps;
    assertTipBps(tipBps);

    return await repository.transaction(async tx => {
      const share = await tx.lockAndAuthorizeShare(scope);
      if (!sameScope(scope, share)) throw new CheckoutError('SHARE_SCOPE_MISMATCH');

      // Replay önce gelir: başarılı/kapalı paya ait eski niyet aynen dönmelidir.
      const existing = await tx.findByOperation({
        businessId: scope.businessId, actorUserId: scope.actorUserId, operationId,
      });
      if (existing) {
        if (!sameScope(existing.scope, scope) || existing.operationId !== operationId ||
            existing.tipBps !== tipBps || existing.intent.checkId !== scope.checkId) {
          throw new CheckoutError('IDEMPOTENCY_CONFLICT');
        }
        return { replayed: true, status: existing.status, payload: toPaymentPayload(existing.intent) };
      }

      if (await tx.findBlockingIntent(scope)) {
        throw new CheckoutError('LIVE_INTENT_EXISTS');
      }
      if (!share.payable) throw new CheckoutError('SHARE_NOT_PAYABLE');

      const intent = buildPaymentIntent({
        paymentId: newPaymentId(), checkId: scope.checkId, currency: share.currency,
        baseMinor: share.remainingBaseMinor, tipBps,
      });
      const payload = toPaymentPayload(intent);
      await tx.insertCreated(Object.freeze({ scope, operationId, tipBps, status: 'created', intent }));
      return { replayed: false, status: 'created', payload };
    });
  } catch (error: unknown) {
    if (error instanceof MoneyError || error instanceof CheckoutError) throw error;
    // Sadece tanıdığımız constraint'leri iş hatasına eşle.
    const db = error as { code?: unknown; constraint?: unknown } | null;
    if (db?.code === '23505' && db.constraint === 'one_live_intent_per_share') {
      throw new CheckoutError('LIVE_INTENT_EXISTS', error);
    }
    if (db?.code === '23505' && db.constraint === 'payment_intents_idempotency_key') {
      throw new CheckoutError('IDEMPOTENCY_CONFLICT', error);
    }
    // COMMIT yanıtı kaybolmuş olabilir. Burada failed yazma, yeni anahtar üretme.
    throw new CheckoutError('INTENT_RESULT_UNCONFIRMED_RETRY_SAME_KEY', error);
  }
}
