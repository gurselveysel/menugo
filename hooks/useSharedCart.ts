'use client';

import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { LiveCartStore } from '../src/live-cart';
import { scopeOf, type Scope } from '../src/cart-protocol';
import { createCartHttp } from '../src/cart-http';
import { sessionCommandJournal } from '../src/cart-journal';
import { createSupabaseCartRealtime } from '../src/supabase-cart-realtime';
import { getBrowserClient } from '../lib/supabase/browser';

/** Mount ONCE in SharedCartProvider; child components consume the context. */
export function useSharedCart({ businessId, branchId, checkId, userId }: Scope) {
  const store = useMemo(() => {
    const scope = scopeOf({ businessId, branchId, checkId, userId });
    const http = createCartHttp(scope.checkId);
    return new LiveCartStore(scope, {
      ...http,
      realtime: createSupabaseCartRealtime(getBrowserClient),
      journal: sessionCommandJournal(scope),
      newOperationId: () => crypto.randomUUID(),
      pollMs: 30000,
    });
  }, [businessId, branchId, checkId, userId]);

  const state = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getServerSnapshot,
  );

  useEffect(() => {
    const client = getBrowserClient();
    let alive = true;
    let authTimer: ReturnType<typeof setTimeout> | undefined;
    let lastToken: string | null = null;
    store.start(navigator.onLine, document.visibilityState === 'visible');

    const online = () => store.setOnline(true);
    const offline = () => store.setOnline(false);
    const visibility = () => store.setVisible(document.visibilityState === 'visible');
    const focus = () => { if (document.visibilityState === 'visible') store.wake(); };
    const pageHide = () => store.setVisible(false);
    const pageShow = () => {
      store.setOnline(navigator.onLine);
      store.setVisible(document.visibilityState === 'visible');
    };

    window.addEventListener('online', online);
    window.addEventListener('offline', offline);
    window.addEventListener('focus', focus);
    window.addEventListener('pagehide', pageHide);
    window.addEventListener('pageshow', pageShow);
    document.addEventListener('visibilitychange', visibility);

    const { data: { subscription } } = client.auth.onAuthStateChange((event, session) => {
      if (!alive) return;
      if (event === 'SIGNED_OUT' || !session || session.user.id.toLowerCase() !== userId.toLowerCase()) {
        if (authTimer !== undefined) clearTimeout(authTimer);
        lastToken = null;
        store.denyAccess('AUTH_CHANGED');
        return;
      }
      if (session.access_token === lastToken && event !== 'USER_UPDATED') return;
      lastToken = session.access_token;
      if (authTimer !== undefined) clearTimeout(authTimer);
      // Callback stays synchronous; no await / nested Supabase Auth call here.
      authTimer = setTimeout(() => {
        if (alive) store.reauthenticate();
      }, 0);
    });

    return () => {
      alive = false;
      if (authTimer !== undefined) clearTimeout(authTimer);
      subscription.unsubscribe();
      window.removeEventListener('online', online);
      window.removeEventListener('offline', offline);
      window.removeEventListener('focus', focus);
      window.removeEventListener('pagehide', pageHide);
      window.removeEventListener('pageshow', pageShow);
      document.removeEventListener('visibilitychange', visibility);
      store.stop(); // Safe for StrictMode's start -> stop -> start sequence.
    };
  }, [store, userId]);

  return useMemo(() => ({
    ...state,
    canMutate: store.canMutate(),
    mutateCart: store.mutateCart,
    retryPending: store.retryPending,
    refresh: store.refresh,
  }), [state, store]);
}
export type SharedCart = ReturnType<typeof useSharedCart>;
