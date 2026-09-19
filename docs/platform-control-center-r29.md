# MenüGO company control center — r29

## Company vs restaurant

`/platform` is separate from restaurant staff roles. Active, email-verified `ops.platform_staff` membership is required on each server request and RPC. `platform_owner`, `ai_admin`, `ops_admin`, `security_admin`, and `auditor` grant narrowly scoped capabilities. Restaurant `owner` never implies a company role.

Restaurant responsibilities remain: menu and prices, staff/branch assignments, hours/contact details, table names, kitchen capacity and busy pause, campaign drafts. AI credentials and model routing remain at `/platform/yapay-zeka`. Table admission policy moves from the restaurant editor to company security.

## Implemented controls

- Global policy and branch overrides: AI generation, menu import, reviewed text publication, new order creation, WhatsApp request preparation, CRM candidate evaluation.
- Global disable cannot be relaxed by a branch. Daily AI ceiling is the minimum of global, branch, connection and provider controls; hard configuration maximum 50 jobs/branch/day, paid AI fallback absent.
- Gates run in actual database writers, not only React. Stop new work without discarding existing orders, prior receipts, refunds, cancellations or publication undo.
- Company team management only by platform owner, verified pre-existing accounts, no automatic email promotion, no invite email or password creation. Last owner protected.
- All changes require reason, operation UUID, and expected version/previous membership. Row/advisory locks, atomic receipt, append-only audit, safe replay after unknown response. Client retains unknown command in same-tab session storage and never auto-replays it.
- Observability: safe readiness counts, payment/AI unknown counts, courier queue/dead counts, CRM evaluation timestamp. No customer documents, message bodies or decrypted keys in summary.
- Enforced values and observed readiness are distinguished from settings not configured.

## Infrastructure boundaries

MFA, SMTP, authentication redirect configuration, DNS/TLS, backup/restore and worker monitoring have accurate handoff links/status. They are not silently claimed configured. The center does not change infrastructure billing or automatically enable card payments, courier dispatch, points spending, or campaign SMS. No destructive financial-ledger reset, raw customer export, secret read-back or blind queue retry exists.

## Acceptance

Local isolated PostgreSQL engine runs the actual migration and authorization/gate tests. Native PostgreSQL17 runs the same fixture plus real two-connection policy conflicts and idempotent concurrency in CI. Browser tests use actual Next routes/SSR with isolated Auth/RPC fixtures. Production reads separately verify rollout and catalogue preservation. No real provider call or customer order is part of acceptance.

## Deployment

Apply `20260920003000_ops_platform_control_center.sql` before deploying r29. Defaults preserve all active services. Migration does not edit catalogue prices, create customers or grant company roles. Existing owner remains. API schema cache reload notification included.

New role edits are audited; schema downgrade must not remove owner protection or reopen legacy setters. UI rollback keeps server restrictions.
