# MenüGO LLM bridge — r16

## Operator flow
Owner: İşletme > LLM Asistanı > select OpenAI (GPT-4.1 mini / GPT-4.1) or Google Gemini (Gemini 2.5 Flash), enter the key in the password field, consent to the selected provider receiving context, save, explicitly test. Credentials are held in Supabase Vault; authenticated clients cannot read them back. No gateway credit, subscription purchase, auto-recharge or fabricated credential is provisioned. A working provider account/quota remains necessary. The explicit test is one small model request and counts as usage.

A configured, successfully tested direct provider is used by the AI Menu Studio as well. Otherwise the existing Gateway path remains available when no direct configuration is present. There is no silent fallback after a direct provider failure. Text assistant responses are drafts, never catalogue writes.

## Architecture and deployment order
1. Test all migrations, TypeScript, Next build and edge TypeScript.
2. Apply `20260919001800_ops_llm.sql` to existing Supabase ops schema. It uses the existing Vault extension. No seed records, menu/price modifications or credentials are included.
3. Deploy `supabase/functions/menugo-llm` as `menugo-llm`, entrypoint `index.ts`, config `deno.json`.
4. The function has explicit authentication with the Supabase Auth `/user` endpoint and requires owner/manager membership in every tenant operation. Gateway `verify_jwt=false` does NOT grant anonymous inference; missing/invalid user bearer is rejected before DB/provider calls. The anon or service key alone is not a user identity.
5. Deploy the matching Next application through existing main/Git integration.
6. Verify real endpoint boundaries, then have the owner enter their own API credential and run the explicit connection test.

## Trust boundaries
`llm_settings` and `llm_claim` can be called by authenticated users but enforce branch membership; configuration changes require owner. No direct SELECT grants on connections/runs. `llm_dispatch` and `llm_finish` are service-role only; service credentials remain in the edge runtime. `dispatch` reads the vault key, current connection generation, menu context or a locked import lease, marks sending, commits, and only then calls the provider. Fixed provider endpoints, bounded input/output and timeout, no arbitrary URL, no tools, no generated SQL, no billing or finance writes. Operation hash/fence make repeat requests retrieval-only. A lost result can remain unknown, and user-initiated NEW intent may incur new provider use.

The read-only assistant supports current-menu assessment, one-product description/translation/campaign draft and a fixed daily aggregate. No customer phone/address/CRM records are selected. User text may contain unintended personal data; UI explicitly asks not to include it. Sources are database records, not proof the model's explanation is correct. Prices are server-formatted BigInt strings; model is instructed to copy, not calculate or invent. A model may still err: all text is labelled draft and never auto-published. Shared customer upsell stays deterministic.

## Limits / retention
Default 30 attempted requests/day/branch (owner adjustable 1–100), 5/minute, 2 concurrent; failed/unknown count toward attempts. This is a REQUEST limit, not a monetary budget. Tokens are recorded when returned; unknown calls can incur unreported provider use. Provider billing dashboard is authoritative. Image/PDF extraction has existing 2 MB, 8-page and job limits. Text answers and request text stop being served after 24h and are purged by daily retention; operation hash and usage metadata persist for idempotency. Source import document retention remains the previous 30-day policy. Keys stay until replaced/disconnected. Disconnect cannot cancel a request already accepted by a provider.

## Testing
Provider unit tests use wire-compatible fake responses, never a real credential. SQL suites use a clearly identified test Vault contract (plaintext in isolated DB ONLY); they test privileges and no key-return behavior, not real Vault encryption. UI tests mock authorized backend state. Live tests are read-only, no key save/test/generation. A passing build is not a passing real inference test. No claim that an LLM is usable before owner key + successful real probe.

## Official contracts reviewed
- https://developers.openai.com/api/docs/models/gpt-4.1-mini
- https://developers.openai.com/api/docs/guides/file-inputs
- https://developers.openai.com/api/docs/guides/structured-outputs
- https://ai.google.dev/gemini-api/docs/structured-output
- https://ai.google.dev/gemini-api/docs/document-processing
- https://supabase.com/docs/guides/database/vault
