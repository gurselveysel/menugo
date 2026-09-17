/** Server-only domain. No provider URLs, request secrets or money Number conversions. */
export const MAX_MINOR = 9223372036854775807n;
export class DaasError extends Error {
    constructor(readonly code: string, options?: ErrorOptions) { super(code, options); this.name = 'DaasError'; }
}
export class ProviderFailure extends Error {
    /** no_effect applies to the LOGICAL request, not merely the latest HTTP connection. */
    constructor(readonly effect: 'no_effect_retryable' | 'no_effect_terminal' | 'uncertain') {
        super(effect);
        this.name = 'ProviderFailure';
    }
}
export class SignatureError extends DaasError {
    constructor() { super('INVALID_WEBHOOK_SIGNATURE'); }
}
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function uuid(value: unknown): string {
    if (typeof value !== 'string' || !UUID.test(value))
        throw new DaasError('INVALID_UUID');
    return value.toLowerCase();
}
export function minor(value: unknown): string {
    if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,18})$/.test(value) || BigInt(value) > MAX_MINOR)
        throw new DaasError('INVALID_MINOR');
    return value;
}
export function text(value: unknown, max = 200): string {
    if (typeof value !== 'string' || value.length < 1 || value.length > max || /[\u0000-\u001f\u007f]/.test(value))
        throw new DaasError('INVALID_TEXT');
    return value;
}
export function record(value: unknown): Record<string, unknown> {
    if (value === null || typeof value !== 'object' || Array.isArray(value))
        throw new DaasError('INVALID_OBJECT');
    return value as Record<string, unknown>;
}
export function instant(value: unknown): string {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(value) || !Number.isFinite(Date.parse(value)))
        throw new DaasError('INVALID_TIMESTAMP');
    return new Date(value).toISOString();
}
export type DeliveryStatus = 'waiting' | 'queued' | 'requested' | 'assigned' | 'picked_up' | 'delivered' | 'cancelled' | 'failed';
export type ProviderStatus = Exclude<DeliveryStatus, 'waiting' | 'queued'>;
export type DispatchState = 'idle' | 'sending' | 'unknown' | 'confirmed' | 'rejected' | 'blocked';
export type Queue = 'outbox' | 'inbox';
export interface Scope {
    businessId: string;
    branchId: string;
    checkId: string;
    orderId: string;
}
export interface Account {
    id: string;
    businessId: string;
    branchId: string;
    provider: string;
    environment: 'sandbox' | 'live';
    remoteMerchantRef: string;
    credentialsRef: string;
    enabled: boolean;
    acceptWebhooks: boolean;
}
export interface Stop {
    name: string;
    phoneE164: string;
    address: string;
    latitudeE7: number;
    longitudeE7: number;
}
export interface DeliveryRequest {
    schemaVersion: 1;
    dispatchKey: string;
    orderId: string;
    currency: 'TRY';
    pickup: Stop;
    dropoff: Stop;
    readyAt: string;
    packageCount: number;
    deliveryFeeMinor: string;
    collectOnDeliveryMinor: string;
}
export function readDeliveryRequest(value: unknown): DeliveryRequest {
    const v = record(value);
    const stop = (value: unknown): Stop => {
        const s = record(value);
        const lat = s.latitudeE7, lon = s.longitudeE7;
        if (!Number.isSafeInteger(lat) || !Number.isSafeInteger(lon) || Math.abs(lat as number) > 900000000 || Math.abs(lon as number) > 1800000000)
            throw new DaasError('INVALID_COORDINATES');
        if (typeof s.phoneE164 !== 'string' || !/^\+[1-9][0-9]{7,14}$/.test(s.phoneE164))
            throw new DaasError('INVALID_PHONE');
        return { name: text(s.name, 150), phoneE164: s.phoneE164, address: text(s.address, 1200), latitudeE7: lat as number, longitudeE7: lon as number };
    };
    if (v.schemaVersion !== 1 || v.currency !== 'TRY' || !Number.isSafeInteger(v.packageCount) || (v.packageCount as number) < 1 || (v.packageCount as number) > 50)
        throw new DaasError('INVALID_DELIVERY_REQUEST');
    const dispatchKey = text(v.dispatchKey, 100);
    if (!dispatchKey.startsWith('menugo:'))
        throw new DaasError('INVALID_DISPATCH_KEY');
    uuid(dispatchKey.slice(7));
    return { schemaVersion: 1, dispatchKey, orderId: uuid(v.orderId), currency: 'TRY', pickup: stop(v.pickup), dropoff: stop(v.dropoff),
        readyAt: instant(v.readyAt), packageCount: v.packageCount as number, deliveryFeeMinor: minor(v.deliveryFeeMinor),
        collectOnDeliveryMinor: minor(v.collectOnDeliveryMinor) };
}
export interface Observation {
    providerRef: string;
    dispatchKey: string | null;
    status: ProviderStatus;
    /** Only supply sequence if documented monotonic PER DELIVERY, never arrival index. */
    sequence: string | null;
    occurredAt: string;
}
export interface CourierEvent extends Observation {
    eventId: string;
}
const PROVIDER_STATES: readonly string[] = ['requested', 'assigned', 'picked_up', 'delivered', 'cancelled', 'failed'];
export function readObservation(value: unknown): Observation {
    const e = record(value);
    if (typeof e.status !== 'string' || !PROVIDER_STATES.includes(e.status))
        throw new DaasError('INVALID_PROVIDER_STATUS');
    const dispatchKey = e.dispatchKey === null ? null : text(e.dispatchKey, 100);
    if (dispatchKey !== null) {
        if (!dispatchKey.startsWith('menugo:'))
            throw new DaasError('INVALID_DISPATCH_KEY');
        uuid(dispatchKey.slice(7));
    }
    return { providerRef: text(e.providerRef), dispatchKey, status: e.status as ProviderStatus,
        sequence: e.sequence === null ? null : minor(e.sequence), occurredAt: instant(e.occurredAt) };
}
export function readEvent(value: unknown): CourierEvent {
    const e = record(value);
    return { ...readObservation(e), eventId: text(e.eventId) };
}
export type LookupResult = {
    kind: 'found';
    observation: Observation;
} | {
    kind: 'not_found';
} | {
    kind: 'unsupported';
};
export interface CourierAdapter {
    readonly provider: string;
    readonly environment: 'sandbox' | 'live';
    /** From contractual documentation. 0 = NEVER auto-repeat an uncertain create. */
    readonly idempotencyWindowSeconds: number;
    create(account: Account, request: Readonly<DeliveryRequest>, signal: AbortSignal): Promise<Observation>;
    lookup(account: Account, identity: {
        dispatchKey: string;
        providerRef: string | null;
    }, signal: AbortSignal): Promise<LookupResult>;
    /** Verify raw bytes, replay protection and merchant/environment BEFORE returning an event. */
    verifyWebhook(account: Account, raw: Uint8Array, headers: Headers, signal: AbortSignal): Promise<CourierEvent>;
    /** Provider-specific success ACK, invoked only after inbox commit. */
    acknowledge(duplicate: boolean): Response;
}
export interface ProviderRegistry {
    resolve(account: Account): CourierAdapter;
}
export interface Job extends Scope {
    id: string;
    routing: 'daas' | 'own';
    accountId: string | null;
    dispatchKey: string;
    requestEnvelope: string;
    requestSha256: string;
    deliveryFeeMinor: string;
    collectOnDeliveryMinor: string;
    status: DeliveryStatus;
    dispatchState: DispatchState;
    providerRef: string | null;
    firstSendAt: string | null;
    replayUntil: string | null;
    lastSequence: string | null;
    authorizationExpiresAt: string;
    authorizationRevoked: boolean;
    reviewRequired: boolean;
}
export interface Lease {
    queue: Queue;
    id: string;
    token: string;
    businessId: string;
    branchId: string;
    attempts: number;
    maxAttempts: number;
    expired: boolean;
    kind: 'dispatch' | 'poll' | 'webhook';
}
export interface Work {
    lease: Lease;
    job: Job;
    account: Account;
    now: string;
}
export type BeforeSend = {
    action: 'send';
    initial: boolean;
} | {
    action: 'skip';
};
export interface DaasRepository {
    claim(queue: Queue): Promise<Lease | null>;
    load(lease: Lease): Promise<Work | null>;
    beforeSend(lease: Lease, idempotencyWindowSeconds: number): Promise<BeforeSend>;
    observe(lease: Lease, observation: Observation): Promise<void>;
    done(lease: Lease): Promise<void>;
    later(lease: Lease, code: string, delaySeconds: number): Promise<void>;
    review(lease: Lease, code: string): Promise<void>;
    attemptError(lease: Lease, effect: ProviderFailure['effect'], initial: boolean, delaySeconds: number): Promise<void>;
    processInbox(lease: Lease): Promise<void>;
    getWebhookAccount(id: string): Promise<Account | null>;
    acceptWebhook(account: Account, event: CourierEvent, rawSha256: string): Promise<{
        duplicate: boolean;
    }>;
}
export interface PayloadVault {
    seal(request: DeliveryRequest, scope: Scope, jobId: string): Promise<{
        envelope: string;
        sha256: string;
    }>;
    open(job: Job): Promise<DeliveryRequest>;
}
export interface WorkerDeps {
    repo: DaasRepository;
    providers: ProviderRegistry;
    vault: PayloadVault;
    /** true only after explicit staging->live activation; lookup/webhooks still run when false. */
    allowCreate: () => boolean;
    log: (event: {
        code: string;
        queue?: Queue;
        workId?: string;
    }) => void;
}
