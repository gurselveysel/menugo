import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { DaasError, readDeliveryRequest, type DeliveryRequest, type PayloadVault, type Scope, type Job, text } from './contracts.js';
export const sha256 = (b: string | Uint8Array) => createHash('sha256').update(b).digest('hex');
const aad = (s: Scope, id: string) => Buffer.from([s.businessId, s.branchId, s.checkId, s.orderId, id].join(':'));
export interface Keyring {
    activeId: string;
    key(id: string): Promise<Uint8Array>;
}
/** AES-256-GCM with scope-bound AAD. Keys belong in KMS/Vault, not in SQL or public env. */
export class AesPayloadVault implements PayloadVault {
    constructor(private readonly keys: Keyring) { }
    async seal(request: DeliveryRequest, scope: Scope, jobId: string) {
        const normalized = readDeliveryRequest(request);
        const body = JSON.stringify(normalized);
        const keyId = text(this.keys.activeId, 100);
        if (keyId.includes('.'))
            throw new DaasError('INVALID_KEY_ID');
        const key = await this.keys.key(keyId);
        if (key.length !== 32)
            throw new DaasError('INVALID_KEY_LENGTH');
        const iv = randomBytes(12);
        const cipher = createCipheriv('aes-256-gcm', key, iv);
        cipher.setAAD(aad(scope, jobId));
        const ciphertext = Buffer.concat([cipher.update(body, 'utf8'), cipher.final()]);
        return { envelope: ['v1', keyId, iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ciphertext.toString('base64url')].join('.'), sha256: sha256(body) };
    }
    async open(job: Job) {
        try {
            const parts = job.requestEnvelope.split('.');
            if (parts.length !== 5 || parts[0] !== 'v1')
                throw new Error('version');
            const key = await this.keys.key(parts[1]!);
            if (key.length !== 32)
                throw new Error('key');
            const iv = Buffer.from(parts[2]!, 'base64url'), tag = Buffer.from(parts[3]!, 'base64url');
            if (iv.length !== 12 || tag.length !== 16)
                throw new Error('envelope');
            const dec = createDecipheriv('aes-256-gcm', key, iv);
            dec.setAAD(aad(job, job.id));
            dec.setAuthTag(tag);
            const plain = Buffer.concat([dec.update(Buffer.from(parts[4]!, 'base64url')), dec.final()]);
            if (sha256(plain) !== job.requestSha256)
                throw new Error('hash');
            const request = readDeliveryRequest(JSON.parse(plain.toString('utf8')));
            if (request.dispatchKey !== job.dispatchKey || request.orderId !== job.orderId || request.deliveryFeeMinor !== job.deliveryFeeMinor || request.collectOnDeliveryMinor !== job.collectOnDeliveryMinor)
                throw new Error('binding');
            return request;
        }
        catch {
            throw new DaasError('PAYLOAD_DECRYPT_OR_BINDING_FAILED');
        }
    }
}
