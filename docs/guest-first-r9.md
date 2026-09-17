# Guest-first merchant release r9

The website no longer needs a registered customer account to use a staff-issued table invitation.
Supabase native anonymous Auth is disabled in the connected project. This release DOES NOT pretend to enable it or create fabricated Auth users. It uses an independent 256-bit table-visit capability stored in a host-only HttpOnly cookie. PostgreSQL stores only its SHA-256 hash. The visit expires after eight hours and cannot access the next visit at the same table.

Public menu browsing creates no visit. Joining requires the existing staff-issued ten-minute invitation. Every guest has a separate session and personal draft; submitted table orders are shared read-only. A different guest or authenticated user cannot submit or edit these drafts. Orders are accepted by staff before preparation. An explicit cancellation request requires an authorized decision and audit reason; captured/active financial allocations block automatic cancellation.

Realtime uses PRIVATE, individually generated read-only signal capabilities. These are not cookie/write secrets. Anonymous Realtime receives only the revision, and no public Broadcast write policy is introduced. Private read capability possession is the authorization for that channel; server snapshots additionally require the HttpOnly visit secret. Expired/revoked visits stop receiving signals; revocation rotates the signal capability. Requests/financial snapshots are never stored in the service-worker cache. The visible-tab HTTP fallback refreshes every fifteen seconds. No offline POST queue or automatic unknown-operation resubmission exists.

A signed-in, email-verified user may explicitly save their own visit to their account while the visit capability is still valid. This does not grant payment ownership, loyalty points or marketing consent. Cookie loss is not a recovery proof. The archive returns only that linked visitor's submitted orders.

Operational additions: delayed acceptance notification after three minutes, per-branch optional kitchen admission capacity, cancellation decisions, ending guest visits and clearing only unsent selections, structured ingredients/allergens/portion/energy/English-copy editor with explicit publish confirmation, and deterministic maximum-two complementary offers.

No unverified opening hours, address, nutrition, translation, profit margin or market lift statistics were fabricated. No real payment, loyalty spending, courier dispatch or campaign SMS is activated. Digital payment and guest payment attribution remain separate gated integration work; the guest 'my amount' is an ordered-goods subtotal, not proof of who paid. Group-wide submission is deliberately not enabled. Existing staff Auth and role policies remain mandatory.

## Acceptance
- `npm run test:sql`: all migrations and guest ownership/metadata/capacity assertions, isolated PostgreSQL WASM.
- `node tests/native-postgres.integration.mjs`: disposable PostgreSQL 17, including real competing guest revision/row-lock tests.
- `node tests/guest-e2e.integration.mjs`: four isolated browser contexts, actual Next API routes, actual HttpOnly cookies and PostgreSQL WASM. Auth/PostgREST/WebSocket transport is simulated locally. No production transaction is created.
- Standard merchant, cashier and transparent branding browser suites.
- Production verification must separately confirm deployment, no-session API denial, read-only capabilities, private live channels and database catalogue checksum.

`SUPABASE_SERVER_URL` is an optional trusted server deployment setting to route server RPC transport; used by isolated local tests. It is not a browser or request-supplied option. In production it is unset and defaults to the existing public Supabase project URL.

Rollback: preserve additive DB migrations and restore reviewed application build only after evaluating changed personal-draft semantics. Never revert financial data. Re-enable legacy merging of guest drafts is prohibited. Global ordering can be paused from the operator controls.
