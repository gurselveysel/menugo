import { ProviderFailure, DaasError, readObservation, type Lease, type WorkerDeps, type Account, type CourierAdapter } from './contracts.js';
import { backoff, bounded, canReplay, TERMINAL } from './policy.js';
function adapterFor(deps: WorkerDeps, account: Account): CourierAdapter {
    const adapter = deps.providers.resolve(account);
    if (adapter.provider !== account.provider || adapter.environment !== account.environment ||
        !Number.isSafeInteger(adapter.idempotencyWindowSeconds) || adapter.idempotencyWindowSeconds < 0 || adapter.idempotencyWindowSeconds > 604800)
        throw new DaasError('PROVIDER_BINDING_INVALID');
    return adapter;
}
export async function processOutbox(lease: Lease, deps: WorkerDeps): Promise<void> {
    const work = await deps.repo.load(lease);
    if (!work)
        return;
    const { job, account } = work;
    if (TERMINAL.has(job.status)) {
        await deps.repo.done(lease);
        return;
    }
    if (lease.expired || lease.attempts > lease.maxAttempts) {
        await deps.repo.review(lease, 'RETRY_BUDGET_EXHAUSTED');
        return;
    }
    if (lease.kind === 'dispatch' && job.providerRef !== null) {
        await deps.repo.done(lease);
        return;
    }
    let adapter: CourierAdapter;
    try {
        adapter = adapterFor(deps, account);
    }
    catch {
        await deps.repo.review(lease, 'PROVIDER_NOT_CONFIGURED');
        return;
    }
    if (lease.kind === 'poll' && job.firstSendAt === null) {
        await deps.repo.later(lease, 'AWAITING_DISPATCH', 60);
        return;
    }
    // Both polling and uncertain dispatch first reconcile by the SAME key/ref.
    if (lease.kind === 'poll' || job.dispatchState === 'sending' || job.dispatchState === 'unknown') {
        let lookup;
        try {
            lookup = await bounded(signal => adapter.lookup(account, { dispatchKey: job.dispatchKey, providerRef: job.providerRef }, signal));
        }
        catch {
            await deps.repo.later(lease, 'LOOKUP_UNAVAILABLE', backoff(lease.attempts));
            return;
        }
        if (lookup.kind === 'found') {
            const observation = readObservation(lookup.observation);
            await deps.repo.observe(lease, observation);
            return;
        }
        if (lease.kind === 'poll') {
            await deps.repo.later(lease, lookup.kind === 'unsupported' ? 'POLL_NOT_SUPPORTED' : 'NOT_YET_OBSERVED', 60);
            return;
        }
        // A not_found response is NOT proof an old POST won't complete later.
        if (!canReplay(job, work.now)) {
            await deps.repo.review(lease, 'UNKNOWN_REQUIRES_RECONCILIATION');
            return;
        }
    }
    if (job.status === 'waiting') {
        await deps.repo.later(lease, 'ORDER_NOT_RELEASED', 30);
        return;
    }
    if (job.reviewRequired) {
        await deps.repo.review(lease, 'MANUAL_REVIEW_REQUIRED');
        return;
    }
    if (!deps.allowCreate() || !account.enabled) {
        await deps.repo.later(lease, 'DISPATCH_PAUSED', 60);
        return;
    }
    if (job.authorizationRevoked || Date.parse(job.authorizationExpiresAt) <= Date.parse(work.now)) {
        await deps.repo.review(lease, 'AUTHORIZATION_EXPIRED_OR_REVOKED');
        return;
    }
    let payload;
    try {
        payload = await bounded(() => deps.vault.open(job));
    }
    catch {
        await deps.repo.review(lease, 'PAYLOAD_UNAVAILABLE');
        return;
    }
    // BeforeSend RECHECKS lease, job, account, authorization and replay deadline,
    // persists sending and first_send_at, then commits BEFORE any provider POST.
    const permit = await deps.repo.beforeSend(lease, adapter.idempotencyWindowSeconds);
    if (permit.action === 'skip')
        return;
    let observation;
    try {
        observation = readObservation(await bounded(signal => adapter.create(account, payload, signal)));
    }
    catch (error: unknown) {
        const effect = error instanceof ProviderFailure ? error.effect : 'uncertain';
        await deps.repo.attemptError(lease, effect, permit.initial, backoff(lease.attempts));
        return;
    }
    // A DB failure HERE leaves sending/lease intact. Never reclassify a known
    // remote success as no_effect and never start a new logical delivery.
    await deps.repo.observe(lease, observation);
}
export async function runOnce(queue: 'outbox' | 'inbox', deps: WorkerDeps): Promise<boolean> {
    const lease = await deps.repo.claim(queue);
    if (!lease)
        return false;
    try {
        if (queue === 'inbox')
            await deps.repo.processInbox(lease);
        else
            await processOutbox(lease, deps);
    }
    catch {
        // Claim remains durable. Next worker reclaims after expiry and reconciles.
        deps.log({ code: 'WORKER_ATTEMPT_UNCONFIRMED', queue, workId: lease.id });
    }
    return true;
}
/** Bounded runner for a protected tick endpoint. Claims only when a worker slot is free. */
export async function runTick(deps: WorkerDeps, budgetMs = 20000, maxJobs = 8) {
    if (!Number.isSafeInteger(budgetMs) || budgetMs < 1000 || budgetMs > 25000 || !Number.isSafeInteger(maxJobs) || maxJobs < 1 || maxJobs > 20)
        throw new DaasError('INVALID_WORKER_BUDGET');
    const end = Date.now() + budgetMs;
    let processed = 0;
    while (Date.now() < end && processed < maxJobs) {
        const inbox = await runOnce('inbox', deps);
        if (inbox)
            processed++;
        if (Date.now() >= end || processed >= maxJobs)
            break;
        const outbox = await runOnce('outbox', deps);
        if (outbox)
            processed++;
        if (!inbox && !outbox)
            break;
    }
    return { processed };
}
