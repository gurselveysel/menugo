# Reviewed text publication (r20)

This slice adds explicit, reversible publication of reviewed Studio text. It does **not** complete AI Suite acceptance or demonstrate a live AI provider call.

## Apply path
A manager produces and reviews a draft in Studio, refreshes the publishing section, selects at most 20 product-copy/TR or translation/EN drafts, examines before/after, and confirms publication. The HTTP body contains only job IDs, version proofs and an operation UUID. The single RPC reloads persisted draft content, verifies current source/product-information fingerprints, locks jobs/products/overlays, and atomically writes all display overlays plus audit receipt. Exact retries return the existing receipt.

TR: description only. EN: display name and description only. Price, canonical product name, options, serving, allergens, ingredients, stock and financial records are not modified. Catalogue display uses ops overlays; original public rows stay unchanged. Stale-source overlays are suppressed automatically. Draft retention does not remove publication audit; published text remains until reverted or superseded.

Undo is a separate confirmed operation. It refuses to overwrite any later publication in the batch, and appends inverse audit entries. It restores prior overlay values without rolling version numbers backward. Applied jobs cannot be published again under another key, including after undo. Generate/review a new draft for a new publication intent.

## Safety boundaries
No public direct access to drafts, changes or receipts; manager-only command RPC. Public RPC exposes only current approved display fields. No model text/price is trusted from client inputs. No provider call, payment, message or live business-content publication occurs in tests/deployment. Lost write responses retain the same operation in the open browser page; unknown outcomes block new commands. Session destruction needs server history lookup, not fabricated success.

## Acceptance
New unit contract tests, named SQL lifecycle/RLS assertions (actual counts reported by CI), existing real PostgreSQL fixture, and browser tests using controlled API fixtures are required. Do not claim real-provider acceptance from synthetic drafts. Native concurrent publication tests additionally protect one-job-one-apply and same-key replay. Production rollout order: SQL first after green gates, then Git/Vercel, then read-only catalogue/auth/domain verification.

Remaining scope: real AI provider acceptance; image publication/storage and source preservation; translated options; social graphics/publishing; purchasing/recipe journals; broader AI Suite issue #1.
