import type { SupabaseClient } from '@supabase/supabase-js';
import type { RealtimePort } from './live-cart';

/** One bridge/store owner per check. Consumers share it through React context. */
export function createSupabaseCartRealtime(getClient: () => SupabaseClient): RealtimePort {
  let closing: Promise<void> = Promise.resolve();
  return {
    async listen(channelId, changed, status, signal) {
      await closing;
      if (signal.aborted) return;
      const client = getClient();
      // Read the CURRENT JWT from the SDK, not a captured earlier TOKEN_REFRESHED token.
      await client.realtime.setAuth();
      await closing;
      if (signal.aborted) return;
      const channel = client.channel(`check:${channelId}`, {
        config: { private: true, broadcast: { self: false } },
      });
      let removed = false;
      const remove = () => {
        if (removed) return;
        removed = true;
        signal.removeEventListener('abort', remove);
        // Serialize removal before a rejoin of the same Supabase topic.
        closing = closing.catch(() => {}).then(async () => {
          try { await client.removeChannel(channel); } catch { /* SDK reconnect/timeout path. */ }
        });
      };
      signal.addEventListener('abort', remove, { once: true });
      try {
        channel
          .on('broadcast', { event: 'changed' }, message => {
            if (!signal.aborted) changed(message.payload);
          })
          .subscribe(value => { if (!signal.aborted) status(value); });
      } catch (error) { remove(); throw error; }
    },
  };
}
