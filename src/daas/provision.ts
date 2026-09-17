import { Database, type SqlConnection } from '../db/database.js';
import { DaasError, uuid, text, instant, readDeliveryRequest, type Scope, type PayloadVault, type DeliveryRequest } from './contracts.js';
export interface FulfillmentPermit {
    scope: Scope;
    routing: 'own' | 'daas';
    accountId: string | null;
    request: DeliveryRequest;
    authorizationRef: string;
    expiresAt: string;
}
/** Application bridge: implement against real settled payment/COD policy and verified address/zone.
 * No default success implementation. prepare() may do external work; assertStillValid is DB-ONLY.
 */
export interface FulfillmentGate {
    prepare(scope: Scope, identity: {
        jobId: string;
        dispatchKey: string;
    }): Promise<FulfillmentPermit>;
    assertStillValid(tx: SqlConnection, permit: FulfillmentPermit): Promise<void>;
}
export async function provisionDelivery(db: Database, vault: PayloadVault, gate: FulfillmentGate, scope: Scope, actorUserId: string) {
    for (const id of Object.values(scope))
        uuid(id);
    uuid(actorUserId);
    // Exactly one job per order in this increment; stable reference across producer retries.
    const jobId = scope.orderId;
    const dispatchKey = 'menugo:' + jobId;
    const permit = await gate.prepare(scope, { jobId, dispatchKey });
    if (JSON.stringify(permit.scope) !== JSON.stringify(scope)) {
        if (['businessId', 'branchId', 'checkId', 'orderId'].some(k => permit.scope[k as keyof Scope] !== scope[k as keyof Scope]))
            throw new DaasError('AUTHORIZATION_SCOPE_MISMATCH');
    }
    if ((permit.routing === 'daas') !== (permit.accountId !== null))
        throw new DaasError('INVALID_ROUTING');
    if (permit.accountId !== null)
        uuid(permit.accountId);
    text(permit.authorizationRef, 250);
    instant(permit.expiresAt);
    const request = readDeliveryRequest(permit.request);
    if (request.orderId !== scope.orderId || request.dispatchKey !== dispatchKey)
        throw new DaasError('REQUEST_SCOPE_MISMATCH');
    // Encryption/KMS I/O is OUTSIDE the order transaction.
    const sealed = await vault.seal(request, scope, jobId);
    return db.transaction(async (tx) => {
        await tx.query('SELECT * FROM ops.lock_check($1,$2,$3,NULL)', [scope.businessId, scope.branchId, scope.checkId]);
        const order = await tx.query(`SELECT o.status,c.service_mode,c.status AS check_status FROM ops.orders o
      JOIN ops.checks c ON c.id=o.check_id WHERE o.business_id=$1 AND o.branch_id=$2 AND o.check_id=$3 AND o.id=$4 FOR UPDATE OF o`, [scope.businessId, scope.branchId, scope.checkId, scope.orderId]);
        const staff = await tx.query(`SELECT 1 FROM ops.branch_staff WHERE business_id=$1 AND branch_id=$2 AND user_id=$3
      AND active AND role IN ('owner','manager','cashier','waiter','kitchen') FOR SHARE`, [scope.businessId, scope.branchId, actorUserId]);
        if (!order.rows[0] || !staff.rows.length)
            throw new DaasError('ORDER_NOT_FOUND');
        const old = await tx.query('SELECT id,request_sha256,routing,account_id FROM ops.delivery_jobs WHERE business_id=$1 AND branch_id=$2 AND order_id=$3 FOR UPDATE', [scope.businessId, scope.branchId, scope.orderId]);
        if (old.rows[0]) {
            if (old.rows[0].request_sha256 !== sealed.sha256 || old.rows[0].routing !== permit.routing || old.rows[0].account_id !== permit.accountId)
                throw new DaasError('DELIVERY_ALREADY_PLANNED');
            return { jobId: String(old.rows[0].id), replayed: true };
        }
        if (order.rows[0].status !== 'accepted' || order.rows[0].service_mode !== 'delivery' || order.rows[0].check_status === 'cancelled')
            throw new DaasError('ORDER_NOT_DELIVERY_READY');
        // This MUST verify settled allocations/COD authorization, address ownership,
        // polygon and quote versions. A mere payment-intent JSON is NOT evidence.
        await gate.assertStillValid(tx, permit);
        const valid = await tx.query('SELECT $1::timestamptz>clock_timestamp() AS valid', [permit.expiresAt]);
        if (valid.rows[0]?.valid !== true)
            throw new DaasError('AUTHORIZATION_EXPIRED');
        await tx.query(`INSERT INTO ops.delivery_jobs(id,business_id,branch_id,check_id,order_id,routing,account_id,
      dispatch_key,request_envelope,request_sha256,delivery_fee_minor,collect_on_delivery_minor,authorization_ref,authorization_expires_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::bigint,$12::bigint,$13,$14::timestamptz)`, [jobId, scope.businessId, scope.branchId, scope.checkId, scope.orderId, permit.routing, permit.accountId, dispatchKey,
            sealed.envelope, sealed.sha256, request.deliveryFeeMinor, request.collectOnDeliveryMinor, permit.authorizationRef, permit.expiresAt]);
        return { jobId, replayed: false };
    });
}
