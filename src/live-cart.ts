import {
  ACCESS_HTTP, HttpError, ProtocolError, ROLLED_BACK_CODES,
  readCommand, readReceipt, readSnapshot, scopeOf, signalRevision,
  type CartSnapshot, type Command, type Scope,
} from './cart-protocol';
import type { CommandJournal } from './cart-journal';

export type ChannelStatus = 'SUBSCRIBED' | 'CHANNEL_ERROR' | 'TIMED_OUT' | 'CLOSED';
export type RealtimePort = {
  /** Resolve after registering listeners. Abort MUST detach and remove the channel. */
  listen(channelId: string, changed: (payload: unknown) => void,
    status: (status: ChannelStatus) => void, signal: AbortSignal): Promise<void>;
};
export type Clock = {
  now(): number;
  later(callback: () => void, delayMs: number): unknown;
  cancel(handle: unknown): void;
};
export type LiveCartPorts = {
  snapshot(signal: AbortSignal): Promise<unknown>;
  post(command: Command, signal: AbortSignal): Promise<unknown>;
  realtime: RealtimePort;
  journal: CommandJournal;
  newOperationId(): string;
  clock?: Clock;
  random?: () => number;
  pollMs?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
};
export type LiveCartState = Readonly<{
  cart: CartSnapshot | null;
  online: boolean;
  stale: boolean;
  fetching: boolean;
  connection: 'idle' | 'connecting' | 'subscribed' | 'retrying' | 'offline' | 'paused';
  accessDenied: boolean;
  mutation: 'idle' | 'sending' | 'unknown';
  pending: Command | null;
  syncError: string | null;
  mutationError: string | null;
  storageError: boolean;
  lastSyncedAt: number | null;
}>;
export type MutationResult =
  | { kind: 'committed'; operationId: string; snapshotFresh: boolean }
  | { kind: 'conflict' | 'rejected'; code: string }
  | { kind: 'unknown'; operationId: string };
const INITIAL: LiveCartState = Object.freeze({ cart: null, online: true, stale: true,
  fetching: false, connection: 'idle', accessDenied: false, mutation: 'idle',
  pending: null, syncError: null, mutationError: null, storageError: false, lastSyncedAt: null });
const systemClock: Clock = {
  now: () => Date.now(), later: (fn, ms) => setTimeout(fn, ms),
  cancel: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Framework-agnostic: no React, browser globals, money arithmetic or optimistic cart. */
export class LiveCartStore {
  readonly scope: Scope;
  private state = INITIAL;
  private readonly clock: Clock;
  private readonly listeners = new Set<() => void>();
  private active = false;
  private visible = true;
  private generation = 0;
  private readEpoch = 0;
  private loadedJournal = false;
  private wantedRevision = 0n;
  private dirty = false;
  private readTask: Promise<boolean> | null = null;
  private readAbort: AbortController | null = null;
  private postAbort: AbortController | null = null;
  private channel: { id: string; controller: AbortController } | null = null;
  private pollTimer: unknown = null;
  private readRetry: unknown = null;
  private channelRetry: unknown = null;
  private readAttempts = 0;
  private channelAttempts = 0;

  constructor(scope: Scope, private readonly ports: LiveCartPorts) {
    this.scope = scopeOf(scope);
    this.clock = ports.clock ?? systemClock;
  }
  getSnapshot = (): LiveCartState => this.state;
  getServerSnapshot = (): LiveCartState => INITIAL;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private patch(next: Partial<LiveCartState>) {
    if (Object.entries(next).every(([key, value]) => Object.is(this.state[key as keyof LiveCartState], value))) return;
    this.state = Object.freeze({ ...this.state, ...next });
    for (const notify of this.listeners) notify();
  }
  private readable() { return this.active && this.visible && this.state.online && !this.state.accessDenied; }
  private valid(generation: number) { return this.active && generation === this.generation; }
  private backoff(attempt: number) {
    const base = this.ports.retryBaseMs ?? 500, cap = this.ports.retryMaxMs ?? 15000;
    return Math.min(cap, base * 2 ** Math.min(attempt, 8) * (0.8 + (this.ports.random?.() ?? Math.random()) * 0.4));
  }
  private cancelTimer(which: 'pollTimer' | 'readRetry' | 'channelRetry') {
    if (this[which] !== null) this.clock.cancel(this[which]);
    this[which] = null;
  }
  private detachChannel() { this.channel?.controller.abort(); this.channel = null; }
  private pauseReads() {
    this.readEpoch++; this.readTask = null;
    this.readAbort?.abort(); this.readAbort = null;
    this.detachChannel();
    this.cancelTimer('readRetry'); this.cancelTimer('channelRetry'); this.cancelTimer('pollTimer');
    this.patch({ fetching: false, stale: true });
  }
  start(online = true, visible = true) {
    if (this.active) return;
    this.active = true; this.generation++; this.visible = visible;
    this.patch({ online, stale: true, connection: online ? (visible ? 'connecting' : 'paused') : 'offline' });
    if (!this.loadedJournal) {
      this.loadedJournal = true;
      try {
        const value = this.ports.journal.load();
        const pending = value ? readCommand(value) : null;
        this.patch({ pending, mutation: pending ? 'unknown' : 'idle' });
      } catch { this.patch({ storageError: true, mutationError: 'COMMAND_JOURNAL_UNAVAILABLE' }); }
    }
    this.wake();
  }
  stop() {
    this.active = false; this.generation++;
    this.pauseReads(); this.postAbort?.abort(); this.postAbort = null; this.readTask = null;
    this.patch({ connection: 'idle', mutation: this.state.pending ? 'unknown' : 'idle' });
  }
  setOnline(online: boolean) {
    this.patch({ online, stale: true });
    if (!online) {
      this.pauseReads(); this.postAbort?.abort();
      this.patch({ connection: 'offline' });
    } else this.wake();
  }
  setVisible(visible: boolean) {
    this.visible = visible;
    if (!visible) { this.pauseReads(); this.patch({ connection: 'paused' }); }
    else this.wake();
    // Hiding the tab does not abort an already intended POST.
  }
  /** Sign-out / another account / HTTP access denial: discard all rendered cart data. */
  denyAccess(code = 'AUTH_CHANGED') {
    this.generation++; this.pauseReads(); this.postAbort?.abort(); this.postAbort = null;
    this.readTask = null; this.wantedRevision = 0n;
    this.patch({ cart: null, accessDenied: true, syncError: code, lastSyncedAt: null,
      connection: 'idle', mutation: this.state.pending ? 'unknown' : 'idle' });
    // The unresolved command contains no tokens/prices. Keep it under the original user's journal key.
  }
  /** Called only when Auth reports the SAME user. Server still authorizes every GET/POST. */
  reauthenticate() {
    this.pauseReads(); // Invalidate old-token GETs, but do not abort an already sent POST.
    this.patch({ accessDenied: false, stale: true, syncError: null });
    this.detachChannel(); this.cancelTimer('channelRetry'); this.wake();
  }
  wake() {
    if (!this.readable()) return;
    this.ensurePoll(); void this.refresh();
  }
  private ensurePoll() {
    if (!this.readable() || this.pollTimer !== null) return;
    const delay = (this.ports.pollMs ?? 30000) * (0.9 + (this.ports.random?.() ?? Math.random()) * 0.2);
    this.pollTimer = this.clock.later(() => {
      this.pollTimer = null; void this.refresh(); this.ensurePoll();
    }, delay);
  }
  private retryRead() {
    if (!this.readable() || this.readRetry !== null) return;
    this.readRetry = this.clock.later(() => {
      this.readRetry = null; void this.refresh();
    }, this.backoff(this.readAttempts++));
  }
  private connect(channelId: string) {
    if (!this.readable() || this.channel?.id === channelId || this.channelRetry !== null) return;
    this.detachChannel();
    const controller = new AbortController(), generation = this.generation;
    const current = () => this.valid(generation) && !controller.signal.aborted;
    this.channel = { id: channelId, controller };
    this.patch({ connection: 'connecting' });
    const failed = () => {
      if (!current()) return;
      this.detachChannel(); this.patch({ connection: 'retrying', stale: true });
      if (this.readable() && this.channelRetry === null) {
        this.channelRetry = this.clock.later(() => {
          this.channelRetry = null;
          // Read current channelId from an authorized GET, not from an old closure.
          void this.refresh();
        }, this.backoff(this.channelAttempts++));
      }
      void this.refresh(); // API fallback immediately, even while WebSocket is unavailable.
    };
    void Promise.resolve().then(() => this.ports.realtime.listen(channelId, payload => {
      if (!current()) return;
      const revision = signalRevision(payload);
      if (revision === null || revision <= (this.state.cart?.revision ?? -1n)) return;
      if (revision > this.wantedRevision) this.wantedRevision = revision;
      void this.refresh();
    }, status => {
      if (!current()) return;
      if (status === 'SUBSCRIBED') {
        this.channelAttempts = 0;
        this.patch({ connection: 'subscribed' });
        void this.refresh(); // GET -> subscribe -> GET closes the initial race window.
      } else failed();
    }, controller.signal)).catch(failed);
  }
  /** Coalesces concurrent refresh signals and never lets an older GET roll the cart back. */
  refresh = (): Promise<boolean> => {
    if (!this.readable()) return Promise.resolve(false);
    this.dirty = true; this.patch({ stale: true });
    if (this.readTask) return this.readTask;
    this.cancelTimer('readRetry');
    const generation = this.generation, readEpoch = this.readEpoch;
    const currentRead = () => this.valid(generation) && readEpoch === this.readEpoch;
    const task = Promise.resolve().then(async () => {
      // Bound catch-up work: a forged/future signal cannot cause a tight infinite fetch loop.
      for (let pass = 0; pass < 2 && this.readable() && currentRead(); pass++) {
        this.dirty = false;
        const controller = new AbortController(); this.readAbort = controller;
        this.patch({ fetching: true });
        try {
          const raw = await this.ports.snapshot(controller.signal);
          if (!currentRead() || controller.signal.aborted) return false;
          const cart = readSnapshot(raw, this.scope), previous = this.state.cart;
          if (previous && cart.revision < previous.revision) {
            this.patch({ stale: true, syncError: 'STALE_SERVER_SNAPSHOT' }); this.retryRead(); return false;
          }
          if (previous && cart.revision === previous.revision && cart.channelId !== previous.channelId) {
            throw new ProtocolError(); // Channel rotation must also increment the check revision.
          }
          this.patch({ cart, syncError: null, lastSyncedAt: this.clock.now() });
          this.connect(cart.channelId);
          if (cart.revision < this.wantedRevision) {
            this.patch({ stale: true, syncError: 'WAITING_FOR_SERVER_REVISION' }); this.retryRead(); return false;
          }
          this.readAttempts = 0;
          if (!this.dirty) { this.patch({ stale: false }); return true; }
        } catch (error: unknown) {
          if (!currentRead() || controller.signal.aborted) return false;
          if (error instanceof HttpError && ACCESS_HTTP.has(error.status)) {
            this.denyAccess(error.status === 401 ? 'UNAUTHENTICATED' : 'CHECK_ACCESS_DENIED');
          } else {
            this.patch({ stale: true, syncError: error instanceof ProtocolError ? 'INVALID_SERVER_RESPONSE' : 'CART_SYNC_FAILED' });
            this.retryRead();
          }
          return false;
        } finally {
          if (this.readAbort === controller) { this.readAbort = null; this.patch({ fetching: false }); }
        }
      }
      if (this.readable() && currentRead()) this.retryRead();
      return false;
    }).finally(() => {
      if (this.readTask === task) {
        this.readTask = null;
        // Handle a signal arriving between loop return and promise finalization.
        if (this.dirty && this.readable() && this.readRetry === null) void this.refresh();
      }
    });
    this.readTask = task;
    return task;
  };
  canMutate = (): boolean => this.readable() && !this.state.stale && !this.state.storageError &&
    !this.state.pending && this.state.mutation === 'idle' && this.state.cart?.status === 'open' &&
    this.state.cart.canMutate;
  mutateCart = async (productId: string, delta: number): Promise<MutationResult> => {
    if (!this.canMutate()) return { kind: 'rejected', code: this.state.pending ? 'RESOLVE_PENDING_OPERATION' : 'CART_NOT_READY' };
    let command: Command;
    try {
      command = readCommand({ operationId: this.ports.newOperationId(), productId, delta,
        expectedRevision: this.state.cart!.revision.toString() });
    } catch { return { kind: 'rejected', code: 'INVALID_CART_INPUT' }; }
    try { this.ports.journal.save(command); } // Persist intent BEFORE attempting the POST.
    catch {
      this.patch({ storageError: true, mutationError: 'COMMAND_JOURNAL_UNAVAILABLE' });
      return { kind: 'rejected', code: 'COMMAND_JOURNAL_UNAVAILABLE' };
    }
    this.patch({ pending: command });
    return this.send(command);
  };
  /** User-triggered only. Never rebase a previous operation onto a new revision. */
  retryPending = async (): Promise<MutationResult> => {
    if (!this.active || !this.visible || !this.state.online || this.state.accessDenied ||
        !this.state.pending || this.state.mutation === 'sending' || this.postAbort) {
      return { kind: 'rejected', code: 'PENDING_RETRY_NOT_READY' };
    }
    return this.send(this.state.pending);
  };
  private clearPending() {
    try { this.ports.journal.clear(); }
    catch { this.patch({ storageError: true, mutationError: 'COMMAND_JOURNAL_UNAVAILABLE' }); }
    this.patch({ pending: null, mutation: 'idle' });
  }
  private async send(command: Command): Promise<MutationResult> {
    const generation = this.generation, controller = new AbortController();
    this.postAbort = controller;
    this.patch({ mutation: 'sending', mutationError: null });
    try {
      const raw = await this.ports.post(command, controller.signal);
      if (!this.valid(generation)) return { kind: 'unknown', operationId: command.operationId };
      const receipt = readReceipt(raw, this.scope, command);
      if (receipt.revision > this.wantedRevision) this.wantedRevision = receipt.revision;
      this.clearPending(); this.patch({ stale: true });
      const fresh = await this.refresh(); // Do NOT apply POST lines/total to the display.
      return { kind: 'committed', operationId: receipt.operationId, snapshotFresh: fresh && !this.state.stale };
    } catch (error: unknown) {
      if (!this.valid(generation)) return { kind: 'unknown', operationId: command.operationId };
      if (error instanceof HttpError && ACCESS_HTTP.has(error.status) && error.code !== 'PRODUCT_NOT_FOUND') {
        this.denyAccess(error.status === 401 ? 'UNAUTHENTICATED' : 'CHECK_ACCESS_DENIED');
        return { kind: 'rejected', code: 'CHECK_ACCESS_DENIED' };
      }
      if (error instanceof HttpError && [404, 409, 422].includes(error.status) && ROLLED_BACK_CODES.has(error.code)) {
        this.clearPending();
        if (error.currentRevision !== undefined && error.currentRevision > this.wantedRevision) {
          this.wantedRevision = error.currentRevision;
        }
        this.patch({ mutationError: error.code, stale: true });
        await this.refresh();
        // Conflict is refreshed, NOT automatically reapplied under a different key.
        return { kind: error.status === 409 ? 'conflict' : 'rejected', code: error.code };
      }
      this.patch({ mutation: 'unknown', mutationError: error instanceof HttpError && error.code === 'IDEMPOTENCY_CONFLICT'
        ? 'IDEMPOTENCY_CONFLICT' : 'OPERATION_RESULT_UNKNOWN', stale: true });
      await this.refresh();
      return { kind: 'unknown', operationId: command.operationId };
    } finally {
      if (this.postAbort === controller) this.postAbort = null;
    }
  }
}
