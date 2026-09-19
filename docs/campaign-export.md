# Product-linked campaign graphics — acceptance slice

`/isletme/kampanya` creates 1080x1350 feed and 1080x1920 story PNGs with the existing original Sarıyer and MenüGO logo assets. This is an intentionally photo-free branded typography template, not AI photo generation. No hallucinated product photograph is used. A real public product QR is embedded; no visit secrets are added. Caption is plain text with a current approved price and the public product URL.

The data source is either the current catalogue or a **human-reviewed** campaign Studio draft. Read-only `ops.campaign_snapshot` uses manager authorization, verifies product eligibility and approved price, verifies a selected AI draft's exact source/product/version and review/expiry, and returns a fingerprint. Export compares that fingerprint on the server before and after rendering. A changed price, closed product or changed source blocks download instead of silently publishing outdated content. Explicit operator review is required after any selection/format change. Actual PNG output and QR decoding are covered by browser tests with authenticated API doubles.

All supplied text renders as canvas text, never HTML. Logos are static allowlisted first-party assets. No arbitrary URL fetch, social credentials, charged inference, customer data, catalogue mutation or social publish is part of this slice. The snapshot RPC is non-public and security-definer with a fixed empty search_path. All private HTTP responses remain no-store. PNG generation is local in the operator's browser, using the browser's fonts. A typed title that cannot fit is rejected rather than silently cropped.

Downloaded files are static: they **do not update** when a price changes later. Regenerate before sharing. This slice has no automatic social posting or schedule and no automatic credit purchase. It does not complete the broader campaign requirement (AI photos, multiple branded creative variants, actual authorized social integration).

Concurrent work on `feat/studio-publication-r20` is intentionally untouched. PR6 idempotent Studio create/recovery fixes are preserved. This feature adds its own files and one role-workspace link.

## Tests
`node --test tests/campaigns.test.mjs`
`node tests/campaigns.sql.integration.mjs`
`POSTGRES_TEST_URL=.../menugo_campaign_ci node tests/campaigns.sql.integration.mjs` (only disposable localhost accepted)
`npm run build && node tests/campaigns-ui.integration.mjs`

Production requires migration `20260919002100_ops_campaign_export.sql`, green test gates and Git deployment. Real provider acceptance remains separate; this slice makes zero model calls.
