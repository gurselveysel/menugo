import { createBrowserClient } from '@supabase/ssr';
import type { SupabaseClient } from '@supabase/supabase-js';
let singleton: SupabaseClient | undefined;

/** Lazy browser-only singleton; never instantiate an authenticated SSR singleton. */
export function getBrowserClient(): SupabaseClient {
  if (typeof window === 'undefined') throw new Error('BROWSER_ONLY');
  if (!singleton) {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
    if (!url || !key) throw new Error('SUPABASE_CONFIGURATION_MISSING');
    singleton = createBrowserClient(url, key);
  }
  return singleton;
}
