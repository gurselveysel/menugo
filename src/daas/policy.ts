import { DaasError, type Job, type Observation, type DeliveryStatus } from './contracts.js';
export const EXTERNAL_TIMEOUT_MS = 8000;
export const REPLAY_SAFETY_MS = 30000;
export const TERMINAL = new Set<DeliveryStatus>(['delivered', 'cancelled', 'failed']);
const rank: Partial<Record<DeliveryStatus, number>> = { waiting: 0, queued: 1, requested: 2, assigned: 3, picked_up: 4, delivered: 5 };
export interface Decision {
    status: DeliveryStatus;
    sequence: string | null;
    decision: 'applied' | 'ignored' | 'quarantined';
    reason: string;
}
export function reduceObservation(job: Pick<Job, 'status' | 'lastSequence'>, e: Observation): Decision {
    const ignored = (reason: string): Decision => ({ status: job.status, sequence: job.lastSequence, decision: 'ignored', reason });
    const quarantine = (reason: string): Decision => ({ ...ignored(reason), decision: 'quarantined' });
    if (e.sequence !== null && job.lastSequence !== null) {
        if (BigInt(e.sequence) < BigInt(job.lastSequence))
            return ignored('OLDER_SEQUENCE');
        if (BigInt(e.sequence) === BigInt(job.lastSequence))
            return e.status === job.status ? ignored('DUPLICATE_SEQUENCE') : quarantine('SEQUENCE_STATUS_CONFLICT');
    }
    if (TERMINAL.has(job.status)) {
        if (e.status === job.status)
            return ignored('ALREADY_TERMINAL');
        return TERMINAL.has(e.status) ? quarantine('CONFLICTING_TERMINAL') : ignored('LATE_NON_TERMINAL');
    }
    if (e.status === 'cancelled' && job.status === 'picked_up')
        return quarantine('CANCEL_AFTER_PICKUP');
    const prev = rank[job.status], next = rank[e.status];
    if (prev !== undefined && next !== undefined && next < prev)
        return e.sequence !== null ? quarantine('SEQUENCED_REGRESSION') : ignored('LATE_STATUS');
    return { status: e.status, sequence: e.sequence ?? job.lastSequence, decision: 'applied', reason: 'PROVIDER_OBSERVATION' };
}
export function canReplay(job: Pick<Job, 'firstSendAt' | 'replayUntil'>, now: string): boolean {
    return job.firstSendAt !== null && job.replayUntil !== null &&
        Date.parse(job.replayUntil) > Date.parse(now) + REPLAY_SAFETY_MS;
}
export function backoff(attempt: number, random: () => number = Math.random): number {
    if (!Number.isSafeInteger(attempt) || attempt < 1)
        throw new DaasError('INVALID_ATTEMPT');
    const cap = Math.min(300, 2 ** Math.min(attempt, 9));
    const r = random();
    if (!Number.isFinite(r) || r < 0 || r >= 1)
        throw new DaasError('INVALID_RANDOM');
    return Math.max(1, Math.floor(cap / 2 + r * cap / 2)); // time duration, not money
}
/** Abort AND bound await. A timeout does NOT prove a remote operation did not happen. */
export async function bounded<T>(work: (signal: AbortSignal) => Promise<T>, ms = EXTERNAL_TIMEOUT_MS): Promise<T> {
    const ctl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            Promise.resolve().then(() => work(ctl.signal)),
            new Promise<never>((_, reject) => { timer = setTimeout(() => { ctl.abort(); reject(new DaasError('DEADLINE_EXCEEDED')); }, ms); })
        ]);
    }
    finally {
        if (timer !== undefined)
            clearTimeout(timer);
        ctl.abort();
    }
}
