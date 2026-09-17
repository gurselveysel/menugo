import { Database, type SqlConnection } from '../db/database.js';
import { DaasError, readEvent, readObservation, text, uuid, minor, type Account, type Job, type Work, type Lease, type Queue, type DaasRepository, type BeforeSend, type CourierEvent, type Observation, type ProviderFailure, type DeliveryStatus, type DispatchState } from './contracts.js';
import { reduceObservation, TERMINAL } from './policy.js';
import { sha256 } from './vault.js';
type Row = Record<string, unknown>;
const table = (q: Queue) => q === 'outbox' ? 'ops.delivery_outbox' : 'ops.delivery_webhook_inbox';
const iso = (v: unknown) => v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString();
const nullableIso = (v: unknown) => v === null ? null : iso(v);
const nullableString = (v: unknown) => v === null ? null : String(v);
function account(r: Row): Account {
    return { id: String(r.id), businessId: String(r.business_id), branchId: String(r.branch_id), provider: String(r.provider),
        environment: r.environment as Account['environment'], remoteMerchantRef: String(r.remote_merchant_ref), credentialsRef: String(r.credentials_ref),
        enabled: r.enabled === true, acceptWebhooks: r.accept_webhooks === true };
}
function job(r: Row): Job {
    return { id: String(r.id), businessId: String(r.business_id), branchId: String(r.branch_id), checkId: String(r.check_id), orderId: String(r.order_id),
        routing: r.routing as Job['routing'], accountId: nullableString(r.account_id), dispatchKey: String(r.dispatch_key),
        requestEnvelope: String(r.request_envelope), requestSha256: String(r.request_sha256), deliveryFeeMinor: minor(r.delivery_fee_minor),
        collectOnDeliveryMinor: minor(r.collect_on_delivery_minor), status: r.status as DeliveryStatus, dispatchState: r.dispatch_state as DispatchState,
        providerRef: nullableString(r.provider_ref), firstSendAt: nullableIso(r.first_send_at), replayUntil: nullableIso(r.replay_until),
        lastSequence: r.last_provider_sequence === null ? null : minor(r.last_provider_sequence), authorizationExpiresAt: iso(r.authorization_expires_at),
        authorizationRevoked: r.authorization_revoked_at !== null, reviewRequired: r.review_required === true };
}
function leaseOf(r: Row, queue: Queue): Lease {
    return { queue, id: String(r.id), token: String(r.lease_token), businessId: String(r.business_id), branchId: String(r.branch_id),
        attempts: Number(r.attempts), maxAttempts: Number(r.max_attempts), expired: r.expired === true,
        kind: queue === 'inbox' ? 'webhook' : r.kind as Lease['kind'] };
}
export class PgDaasRepository implements DaasRepository {
    constructor(readonly db: Database) { }
    async claim(queue: Queue): Promise<Lease | null> {
        return this.db.transaction(async (tx) => {
            const t = table(queue), created = queue === 'outbox' ? 'created_at' : 'received_at';
            const result = await tx.query(`WITH candidate AS (
        SELECT id FROM ${t}
        WHERE (state='pending' AND available_at<=clock_timestamp())
           OR (state='leased' AND lease_until<=clock_timestamp())
        ORDER BY available_at,${created},id FOR UPDATE SKIP LOCKED LIMIT 1
      ) UPDATE ${t} q SET state='leased',lease_token=gen_random_uuid(),
          lease_until=clock_timestamp()+interval '60 seconds',attempts=q.attempts+1,updated_at=clock_timestamp()
        FROM candidate WHERE q.id=candidate.id
        RETURNING q.*,(q.deadline_at<=clock_timestamp()) AS expired`);
            return result.rows[0] ? leaseOf(result.rows[0], queue) : null;
        });
    }
    private async lockedQueue(tx: SqlConnection, l: Lease): Promise<Row | null> {
        const r = await tx.query(`SELECT *,clock_timestamp() AS db_now,deadline_at<=clock_timestamp() AS expired FROM ${table(l.queue)}
      WHERE id=$1 AND business_id=$2 AND branch_id=$3 AND state='leased' AND lease_token=$4
        AND lease_until>clock_timestamp() FOR UPDATE`, [l.id, l.businessId, l.branchId, l.token]);
        return r.rows[0] ?? null;
    }
    private async lockedJob(tx: SqlConnection, l: Lease, jobId: string): Promise<Job> {
        const r = await tx.query(`SELECT * FROM ops.delivery_jobs WHERE id=$1 AND business_id=$2 AND branch_id=$3 FOR UPDATE`, [jobId, l.businessId, l.branchId]);
        if (!r.rows[0])
            throw new DaasError('JOB_SCOPE_NOT_FOUND');
        return job(r.rows[0]);
    }
    private async accountFor(tx: SqlConnection, id: string): Promise<Account> {
        const r = await tx.query('SELECT * FROM ops.delivery_accounts WHERE id=$1 FOR SHARE', [id]);
        if (!r.rows[0])
            throw new DaasError('ACCOUNT_NOT_FOUND');
        return account(r.rows[0]);
    }
    private async finish(tx: SqlConnection, l: Lease, state: 'pending' | 'done' | 'dead', code: string | null, delay = 0) {
        if (!Number.isSafeInteger(delay) || delay < 0 || delay > 3600)
            throw new DaasError('INVALID_RETRY_DELAY');
        await tx.query(`UPDATE ${table(l.queue)} SET state=$5,last_error_code=$6,
      lease_token=NULL,lease_until=NULL,available_at=clock_timestamp()+($7::integer*interval '1 second'),updated_at=clock_timestamp()
      WHERE id=$1 AND business_id=$2 AND branch_id=$3 AND state='leased' AND lease_token=$4`, [l.id, l.businessId, l.branchId, l.token, state, code, delay]);
    }
    private async audit(tx: SqlConnection, l: Lease, j: Job, source: string, to: DeliveryStatus, decision: string, reason: string, key = l.id + ':' + l.token) {
        await tx.query(`INSERT INTO ops.delivery_events(business_id,branch_id,job_id,source,source_key,from_status,to_status,decision,reason_code)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(job_id,source,source_key) DO NOTHING`, [j.businessId, j.branchId, j.id, source, key, j.status, to, decision, reason]);
    }
    private async reviewLocked(tx: SqlConnection, l: Lease, j: Job, code: string) {
        await tx.query(`UPDATE ops.delivery_jobs SET review_required=true,review_reason=$2,
      dispatch_state=CASE WHEN provider_ref IS NOT NULL OR dispatch_state='rejected' THEN dispatch_state
        WHEN first_send_at IS NULL THEN 'blocked' ELSE 'unknown' END WHERE id=$1`, [j.id, code]);
        await this.audit(tx, l, j, 'worker', j.status, 'review', code);
        await this.finish(tx, l, 'dead', code);
    }
    async load(l: Lease): Promise<Work | null> {
        return this.db.transaction(async (tx) => {
            const q = await this.lockedQueue(tx, l);
            if (!q)
                return null;
            const j = await this.lockedJob(tx, l, String(q.job_id));
            if (j.routing !== 'daas' || j.accountId === null)
                throw new DaasError('NOT_DAAS_JOB');
            const a = await this.accountFor(tx, j.accountId);
            if (a.businessId !== j.businessId || a.branchId !== j.branchId)
                throw new DaasError('ACCOUNT_SCOPE_MISMATCH');
            return { lease: { ...l, expired: q.expired === true }, job: j, account: a, now: iso(q.db_now) };
        });
    }
    async beforeSend(l: Lease, windowSeconds: number): Promise<BeforeSend> {
        if (!Number.isSafeInteger(windowSeconds) || windowSeconds < 0 || windowSeconds > 604800)
            throw new DaasError('INVALID_IDEMPOTENCY_WINDOW');
        return this.db.transaction(async (tx) => {
            const q = await this.lockedQueue(tx, l);
            if (!q)
                return { action: 'skip' };
            const j = await this.lockedJob(tx, l, String(q.job_id));
            if (q.expired === true || l.attempts > l.maxAttempts) {
                await this.reviewLocked(tx, l, j, 'RETRY_BUDGET_EXHAUSTED');
                return { action: 'skip' };
            }
            if (j.providerRef || TERMINAL.has(j.status)) {
                await this.finish(tx, l, 'done', null);
                return { action: 'skip' };
            }
            const a = await this.accountFor(tx, j.accountId!);
            if (!a.enabled) {
                await this.finish(tx, l, 'pending', 'DISPATCH_PAUSED', 60);
                return { action: 'skip' };
            }
            const checks = await tx.query(`SELECT o.status AS order_status,c.status AS check_status,
        j.authorization_expires_at>clock_timestamp() AS authorized,
        j.replay_until>clock_timestamp()+interval '30 seconds' AS replay_safe
        FROM ops.delivery_jobs j JOIN ops.orders o ON o.id=j.order_id
        JOIN ops.checks c ON c.id=j.check_id WHERE j.id=$1`, [j.id]);
            const c = checks.rows[0];
            if (!c || c.authorized !== true || j.authorizationRevoked || c.check_status === 'cancelled' || !['preparing', 'ready'].includes(String(c.order_status)) || j.reviewRequired) {
                await this.reviewLocked(tx, l, j, 'DISPATCH_REQUIRES_REVIEW');
                return { action: 'skip' };
            }
            const initial = j.dispatchState === 'idle';
            if (!initial && c.replay_safe !== true) {
                await this.reviewLocked(tx, l, j, 'IDEMPOTENCY_WINDOW_CLOSED');
                return { action: 'skip' };
            }
            // first_send_at stays immutable across attempts; its window is never extended.
            await tx.query(`UPDATE ops.delivery_jobs SET dispatch_state='sending',
        first_send_at=coalesce(first_send_at,clock_timestamp()),
        replay_until=CASE WHEN first_send_at IS NULL AND $2::integer>0
          THEN clock_timestamp()+($2::integer*interval '1 second') ELSE replay_until END WHERE id=$1`, [j.id, windowSeconds]);
            // Renew lease before network call, within the same short transaction.
            await tx.query(`UPDATE ops.delivery_outbox SET lease_until=clock_timestamp()+interval '60 seconds' WHERE id=$1 AND lease_token=$2`, [l.id, l.token]);
            return { action: 'send', initial };
        });
    }
    private async apply(tx: SqlConnection, l: Lease, j: Job, o: Observation, source: 'receipt' | 'poll' | 'webhook', key: string) {
        if ((o.dispatchKey !== null && o.dispatchKey !== j.dispatchKey) || (j.providerRef !== null && j.providerRef !== o.providerRef) || j.firstSendAt === null) {
            await this.reviewLocked(tx, l, j, 'PROVIDER_IDENTITY_CONFLICT');
            return 'quarantined' as const;
        }
        const d = reduceObservation(j, o);
        // Global uniqueness within account also prevents binding a ref owned by another job.
        const conflict = await tx.query('SELECT id FROM ops.delivery_jobs WHERE account_id=$1 AND provider_ref=$2 AND id<>$3', [j.accountId, o.providerRef, j.id]);
        if (conflict.rows.length) {
            await this.reviewLocked(tx, l, j, 'PROVIDER_REF_COLLISION');
            return 'quarantined' as const;
        }
        await tx.query(`UPDATE ops.delivery_jobs SET provider_ref=coalesce(provider_ref,$2),dispatch_state='confirmed',
      status=$3,last_provider_sequence=$4::bigint,last_provider_at=CASE WHEN $8::boolean THEN $5::timestamptz ELSE last_provider_at END,last_checked_at=clock_timestamp(),
      review_required=review_required OR $6::boolean,
      review_reason=CASE WHEN $6::boolean THEN $7 ELSE review_reason END WHERE id=$1`, [j.id, o.providerRef, d.status, d.sequence, o.occurredAt, d.decision === 'quarantined', d.reason, d.decision === 'applied']);
        await this.audit(tx, l, j, source, d.status, d.decision, d.reason, key);
        return d;
    }
    async observe(l: Lease, value: Observation) {
        const o = readObservation(value);
        await this.db.transaction(async (tx) => {
            const q = await this.lockedQueue(tx, l);
            if (!q)
                return;
            const j = await this.lockedJob(tx, l, String(q.job_id));
            const d = await this.apply(tx, l, j, o, l.kind === 'poll' ? 'poll' : 'receipt', l.id + ':' + l.token);
            if (d === 'quarantined')
                return;
            if (d.decision === 'quarantined') {
                await this.finish(tx, l, 'dead', d.reason);
                return;
            }
            await this.finish(tx, l, l.kind === 'poll' && !TERMINAL.has(d.status) ? 'pending' : 'done', null, 60);
        });
    }
    async done(l: Lease) { await this.db.transaction(async (tx) => { if (await this.lockedQueue(tx, l))
        await this.finish(tx, l, 'done', null); }); }
    async later(l: Lease, code: string, seconds: number) {
        await this.db.transaction(async (tx) => {
            const q = await this.lockedQueue(tx, l);
            if (!q)
                return;
            if (q.expired === true || l.attempts >= l.maxAttempts) {
                const j = await this.lockedJob(tx, l, String(q.job_id));
                await this.reviewLocked(tx, l, j, code);
                return;
            }
            await this.finish(tx, l, 'pending', text(code, 100), seconds);
        });
    }
    async review(l: Lease, code: string) {
        await this.db.transaction(async (tx) => {
            const q = await this.lockedQueue(tx, l);
            if (!q)
                return;
            const j = await this.lockedJob(tx, l, String(q.job_id));
            await this.reviewLocked(tx, l, j, text(code, 100));
        });
    }
    async attemptError(l: Lease, effect: ProviderFailure['effect'], initial: boolean, seconds: number) {
        await this.db.transaction(async (tx) => {
            const q = await this.lockedQueue(tx, l);
            if (!q)
                return;
            const j = await this.lockedJob(tx, l, String(q.job_id));
            // Callback may have confirmed delivery while POST timed out.
            if (j.providerRef !== null || TERMINAL.has(j.status)) {
                await this.finish(tx, l, 'done', null);
                return;
            }
            const certain = initial && effect !== 'uncertain';
            if (certain && effect === 'no_effect_terminal') {
                await tx.query("UPDATE ops.delivery_jobs SET dispatch_state='rejected',status='failed',review_required=true,review_reason='PROVIDER_REJECTED' WHERE id=$1", [j.id]);
                await this.audit(tx, l, j, 'worker', 'failed', 'review', 'PROVIDER_REJECTED');
                await this.finish(tx, l, 'dead', 'PROVIDER_REJECTED');
                return;
            }
            await tx.query('UPDATE ops.delivery_jobs SET dispatch_state=$2 WHERE id=$1', [j.id, certain ? 'idle' : 'unknown']);
            const code = certain ? 'NOT_ACCEPTED_RETRYABLE' : 'CREATE_RESULT_UNKNOWN';
            if (l.attempts >= l.maxAttempts || q.expired === true) {
                await this.reviewLocked(tx, l, j, code);
                return;
            }
            await this.finish(tx, l, 'pending', code, seconds);
        });
    }
    async getWebhookAccount(id: string): Promise<Account | null> {
        return this.db.read(async (tx) => {
            const r = await tx.query('SELECT * FROM ops.delivery_accounts WHERE id=$1', [uuid(id)]);
            return r.rows[0] ? account(r.rows[0]) : null;
        });
    }
    async acceptWebhook(a: Account, value: CourierEvent, rawSha256: string) {
        const e = readEvent(value);
        const canonical = JSON.stringify(e);
        const semantic = sha256(canonical);
        if (!/^[a-f0-9]{64}$/.test(rawSha256))
            throw new DaasError('INVALID_HASH');
        return this.db.transaction(async (tx) => {
            // A successfully verified callback remains acceptable if new creates are disabled.
            const current = await this.accountFor(tx, a.id);
            if (!current.acceptWebhooks || current.businessId !== a.businessId || current.branchId !== a.branchId || current.remoteMerchantRef !== a.remoteMerchantRef)
                throw new DaasError('ACCOUNT_BINDING_CHANGED');
            const r = await tx.query(`INSERT INTO ops.delivery_webhook_inbox(business_id,branch_id,account_id,event_id,raw_sha256,event_sha256,event)
        VALUES($1,$2,$3,$4,$5,$6,$7::jsonb) ON CONFLICT(account_id,event_id) DO NOTHING RETURNING id`, [a.businessId, a.branchId, a.id, e.eventId, rawSha256, semantic, canonical]);
            if (r.rows.length)
                return { duplicate: false };
            const old = await tx.query('SELECT event_sha256 FROM ops.delivery_webhook_inbox WHERE account_id=$1 AND event_id=$2', [a.id, e.eventId]);
            if (old.rows[0]?.event_sha256 !== semantic)
                throw new DaasError('EVENT_ID_REUSED');
            return { duplicate: true };
        });
    }
    async processInbox(l: Lease) {
        await this.db.transaction(async (tx) => {
            const q = await this.lockedQueue(tx, l);
            if (!q)
                return;
            const e = readEvent(q.event), accountId = String(q.account_id);
            if (l.attempts > l.maxAttempts || q.expired === true) {
                await this.finish(tx, l, 'dead', 'UNMATCHED_OR_EXHAUSTED_WEBHOOK');
                return;
            }
            // accountId fixes tenant/env. Match signed request key OR known provider ref.
            const candidates = await tx.query(`SELECT id FROM ops.delivery_jobs WHERE account_id=$1 AND business_id=$2 AND branch_id=$3
        AND (provider_ref=$4 OR ($5::text IS NOT NULL AND dispatch_key=$5)) ORDER BY id`, [accountId, l.businessId, l.branchId, e.providerRef, e.dispatchKey]);
            if (candidates.rows.length === 0) {
                await this.finish(tx, l, l.attempts >= l.maxAttempts ? 'dead' : 'pending', 'WEBHOOK_AWAITING_CORRELATION', 30);
                return;
            }
            if (candidates.rows.length !== 1) {
                await this.finish(tx, l, 'dead', 'WEBHOOK_CORRELATION_CONFLICT');
                return;
            }
            const j = await this.lockedJob(tx, l, String(candidates.rows[0]!.id));
            const d = await this.apply(tx, l, j, e, 'webhook', l.id);
            if (d === 'quarantined')
                return;
            await this.finish(tx, l, d.decision === 'quarantined' ? 'dead' : 'done', d.decision === 'quarantined' ? d.reason : null);
        });
    }
}
