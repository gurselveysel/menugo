import 'server-only';
import { Pool } from 'pg';
import { Database, type SqlPool } from '../../src/db/database';
import { PgDaasRepository } from '../../src/daas/postgres';
import { AesPayloadVault } from '../../src/daas/vault';
import { DaasError, type WorkerDeps } from '../../src/daas/contracts';
import { providers } from './provider-bindings';
let singleton: WorkerDeps | undefined;
export function daasRuntime(): WorkerDeps {
    if (singleton)
        return singleton;
    const url = process.env.MENUGO_WORKER_DATABASE_URL;
    if (!url)
        throw new DaasError('WORKER_DATABASE_NOT_CONFIGURED');
    const pool = new Pool({ connectionString: url, max: 4, connectionTimeoutMillis: 4000,
        idleTimeoutMillis: 30000, ssl: { rejectUnauthorized: true } });
    // No parser converting PostgreSQL int8 to JavaScript Number.
    const port: SqlPool = { async connect() {
            const c = await pool.connect();
            return {
                async query<R extends object>(sql: string, values?: unknown[]) {
                    const r = await c.query(sql, values);
                    return { rows: r.rows as R[], rowCount: r.rowCount };
                }, release() { c.release(); }
            };
        } };
    const vault = new AesPayloadVault({
        activeId: process.env.MENUGO_PAYLOAD_ACTIVE_KEY_ID ?? '',
        async key(id) {
            // Replace with managed KMS/Vault in production. No network call in DB transaction.
            const data: unknown = JSON.parse(process.env.MENUGO_PAYLOAD_KEYRING_JSON ?? '{}');
            if (data === null || typeof data !== 'object' || Array.isArray(data))
                throw new DaasError('KEYRING_UNAVAILABLE');
            const key = (data as Record<string, unknown>)[id];
            if (typeof key !== 'string')
                throw new DaasError('KEYRING_UNAVAILABLE');
            return Buffer.from(key, 'base64');
        }
    });
    singleton = { repo: new PgDaasRepository(new Database(port)), vault, providers: providers(),
        allowCreate: () => process.env.MENUGO_DAAS_ENABLED === 'true',
        log: event => console.error(JSON.stringify({ subsystem: 'daas', ...event })) };
    return singleton;
}
