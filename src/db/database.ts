/** Implemented by pg.Pool, with one checked-out client per transaction. */
export interface QueryResult<R extends object = Record<string, unknown>> {
    rows: R[];
    rowCount: number | null;
}
export interface SqlConnection {
    query<R extends object = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<R>>;
    release(): void;
}
export interface SqlPool {
    connect(): Promise<SqlConnection>;
}
export class Database {
    constructor(readonly pool: SqlPool) { }
    async transaction<T>(work: (tx: SqlConnection) => Promise<T>): Promise<T> {
        const tx = await this.pool.connect();
        let began = false;
        try {
            await tx.query('BEGIN');
            began = true;
            await tx.query("SET LOCAL lock_timeout='1500ms'");
            await tx.query("SET LOCAL statement_timeout='5s'");
            await tx.query("SET LOCAL idle_in_transaction_session_timeout='8s'");
            const result = await work(tx);
            await tx.query('COMMIT');
            began = false;
            return result;
        }
        catch (error) {
            if (began)
                try {
                    await tx.query('ROLLBACK');
                }
                catch { }
            throw error;
        }
        finally {
            tx.release();
        }
    }
    async read<T>(work: (tx: SqlConnection) => Promise<T>): Promise<T> { return this.transaction(work); }
}
