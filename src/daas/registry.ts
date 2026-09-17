import { DaasError, type Account, type CourierAdapter, type ProviderRegistry } from './contracts.js';
export class AdapterRegistry implements ProviderRegistry {
    private readonly adapters = new Map<string, CourierAdapter>();
    constructor(adapters: readonly CourierAdapter[]) {
        for (const a of adapters) {
            const key = a.provider + ':' + a.environment;
            if (this.adapters.has(key))
                throw new DaasError('DUPLICATE_PROVIDER_BINDING');
            this.adapters.set(key, a);
        }
    }
    resolve(account: Account) {
        const adapter = this.adapters.get(account.provider + ':' + account.environment);
        if (!adapter)
            throw new DaasError('PROVIDER_NOT_CONFIGURED');
        return adapter;
    }
}
