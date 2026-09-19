# Voice order draft slice — Issue #1

Status: **safe core implemented; full voice-provider acceptance pending**.

This slice is intentionally review-first and does not claim completion of the `voiceOrder` acceptance item in Issue #1.

## Implemented

- Guest-scoped `voice-draft` endpoint reads the live `ops.catalogue` result and never invents products or prices.
- Exact monetary arithmetic uses integer minor units with `BigInt`.
- Unapproved/unavailable products, duplicate names, missing/ambiguous options and quantity-limit violations fail closed into review issues.
- Browser speech recognition is started only after a customer gesture when the browser exposes `SpeechRecognition`/`webkitSpeechRecognition`; text entry remains the fallback.
- A recognised/transcribed line is a draft only. Nothing is auto-added, auto-submitted, paid or messaged.
- A customer can explicitly add a reviewed line through the existing idempotent guest cart mutation path; server price/orderability rules are rechecked there. Order submission remains a separate explicit action.

## Validation

Branch: `feat/voice-order-draft-core`
PR: #3

The repository `MenuGO checks` gate validates PostgreSQL/RLS/row-lock suites, unit tests (including `tests/voice-order.test.mjs`), production build and existing browser regressions. `Merchant release acceptance` is also required before merge. The PR is temporarily stacked on active PR #2 so its unrelated lazy-image acceptance fix is exercised without duplicating or conflicting with that work.

## Not accepted yet

- No external speech/LLM provider has been invoked or accepted for voice transcription in this slice.
- No live customer order, payment, message or social action is created for testing.
- Production verification must occur only after the accepted code reaches `main` and Vercel reports a READY production deployment.

Therefore Issue #1 `voiceOrder` must remain incomplete until real-provider and production acceptance requirements are met.
