import { object, readCommand, type Command, type Scope } from './cart-protocol';
export interface CommandJournal {
  load(): Command | null;
  save(command: Command): void;
  clear(): void;
}
/** Only one unresolved intent, not a price cache and not an offline order queue. */
export function sessionCommandJournal(scope: Scope): CommandJournal {
  const key = ['menugo', 'cart-command', 'v1', scope.businessId, scope.branchId,
    scope.checkId, scope.userId].join(':');
  // Access is delayed until start()/user action; never touch window during SSR/render.
  const storage = () => window.sessionStorage;
  return {
    load() {
      const text = storage().getItem(key);
      if (!text) return null;
      const value = object(JSON.parse(text));
      if (value.version !== 1) throw new Error('UNSUPPORTED_COMMAND_JOURNAL');
      return readCommand(value.command);
    },
    save(command) { storage().setItem(key, JSON.stringify({ version: 1, command })); },
    clear() { storage().removeItem(key); },
  };
}
