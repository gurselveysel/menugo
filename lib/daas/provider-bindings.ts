import 'server-only';
import { AdapterRegistry } from '../../src/daas/registry';
/** Supply only vendor-approved adapters. No fake Vigo/Fiyuu endpoints or default live stub. */
export function providers() {
    return new AdapterRegistry([
    // new VerifiedVigoAdapter(secretResolver, approvedContract),
    // new VerifiedFiyuuAdapter(secretResolver, approvedContract),
    ]);
}
