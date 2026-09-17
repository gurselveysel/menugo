import 'server-only';
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { ApiError } from '@/lib/orders/errors';
import type { RpcDatabase } from './rpc-database';

/** One SSR client per request. Uses the user's JWT, never service_role. */
export async function requireUserClient() {
  const cookieStore = await cookies();
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key)
    throw new ApiError(500, 'SUPABASE_CONFIG_MISSING', 'Sunucu yapılandırması eksik.');

  const supabase = createServerClient<RpcDatabase>(url, key, {
    cookies: {
      getAll() { return cookieStore.getAll(); },
      setAll(values) {
        // Route Handlers may write cookies; do not silently swallow refresh failures.
        for (const { name, value, options } of values)
          cookieStore.set(name, value, options);
      },
    },
  });

  // getSession()'ın cookie içindeki user alanını yetki kanıtı olarak kullanma.
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error && (error.name === 'AuthRetryableFetchError' || error.status === 429 || (error.status ?? 0) >= 500))
    throw new ApiError(503, 'AUTH_UNAVAILABLE', 'Oturum doğrulama servisine ulaşılamıyor.');
  if (error || !user)
    throw new ApiError(401, 'UNAUTHENTICATED', 'Oturum açmanız gerekiyor.');

  return supabase;
}
