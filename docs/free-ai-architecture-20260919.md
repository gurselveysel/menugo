# MenüGO: zero paid-inference policy

## Scope and acceptance
User requires no paid AI services, no automatic credit purchases and no paid fallback. This revision adds a task/privacy/quota-gated router and company-only multi-provider configuration. It does not activate a subscription, open new infrastructure, modify customer prices or infer successful real-model acceptance from mocked tests.

At implementation start, production had 0 `ops.llm_connections`, 0 `ops.llm_runs`; no provider credential was available. Existing hosting/storage costs are separate from AI inference. Never call this unlimited/free infrastructure or claim perfect model accuracy.

## Providers reviewed (official sources; last re-review 2026-09-21)

| Provider | Decision | Primary evidence |
|---|---|---|
| NVIDIA NIM Developer Program | Evaluation only; not used to serve actual restaurant customers. No assumption that free prototype API grants production rights. | https://docs.api.nvidia.com/nim/docs/product |
| Google Gemini | Opt-in public menu/document + structured copy via an unbilled Free project. Private invoice/free-text reports excluded. Pinned 2.5 Flash/Flash-Lite, no paid image model. | https://ai.google.dev/gemini-api/docs/pricing and https://ai.google.dev/gemini-api/terms |
| Groq | Free-account text/JSON route with OpenAI gpt-oss-20b/120b. For private data, company operator must enable ZDR before approving this route. | https://console.groq.com/docs/billing-faqs and https://console.groq.com/docs/your-data and https://console.groq.com/docs/structured-outputs |
| OpenRouter | `openrouter/free`, max_price all zero, ZDR/data_collection deny, require_parameters true. No auto, tools, plugins, billed model IDs or account rotation. Availability not guaranteed. | https://openrouter.ai/docs/guides/routing/routers/free-router and https://openrouter.ai/docs/guides/routing/provider-selection |
| Cloudflare Workers AI | Workers Free credential provides FLUX.2 Klein 4B photo editing and a fixed text-only fallback on Cloudflare-hosted `@cf/google/gemma-4-26b-a4b-it`. Cloudflare lists Gemma 4 among models remaining available on Workers Free. Free allocation is 10,000 Neurons/day; on Workers Free, exceeding the allocation fails rather than billing overage. No third-party AI Gateway model is called. | https://developers.cloudflare.com/workers-ai/platform/pricing/ , https://developers.cloudflare.com/changelog/post/2026-07-28-models-require-workers-paid/ , https://developers.cloudflare.com/workers-ai/models/gemma-4-26b-a4b-it/ and https://developers.cloudflare.com/workers-ai/models/flux-2-klein-4b/ |
| OpenAI direct API | Disabled. Consumer ChatGPT access does not provide an application's recurring free API quota. OpenAI open-weight models via Groq are a different provider/service. | https://help.openai.com/en/articles/8264644-how-can-i-set-up-prepaid-billing |
| DeepSeek direct API | Disabled: official token pricing is paid. A model available under an approved zero-price hosted route is a separate offer; do not assume availability. | https://api-docs.deepseek.com/quick_start/pricing |
| Anthropic | Disabled: evaluation/promotional credits are not recurring free production service. | https://docs.anthropic.com/en/docs/about-claude/pricing |
| xAI | Disabled: direct API/image services priced; historical promotions not a recurring entitlement. | https://docs.x.ai/docs/models |
| Cohere | Trial/evaluation excluded from production; production key/plan requirements reviewed separately. | https://docs.cohere.com/docs/rate-limits |
| Mistral | Free mode remains excluded from the production router: official guidance describes Free as testing/prototyping, and Zero Data Retention is only available with pay-as-you-go. API keys follow the organization plan rather than being intrinsically free-only. | https://help.mistral.ai/en/articles/347488-understanding-mistral-ai-studio-plan-options and https://help.mistral.ai/en/articles/121681-how-can-i-activate-zero-data-retention |
| Together | No assumed recurring free quota; conditional promotional grants do not meet this user's zero-purchase baseline. | https://support.together.ai/articles/1867757214-does-together-ai-offer-free-trials |
| Fireworks | Trial credit is not a permanent allowance; not enabled. | https://fireworks.ai/pricing |
| Hugging Face | Very small monthly hosted credit, changing availability/provider terms; not part of guaranteed text/image route. | https://huggingface.co/docs/inference-providers/pricing |
| Cerebras | Trial/plan-specific access must be verified before enablement. No assumed free production tier from older tables. | https://www.cerebras.ai/inference |
| GitHub Models | Official docs say retired 2026-07-30; not integrated. | https://docs.github.com/en/github-models |

This is a scoped provider review, not every AI vendor in existence. Free web chat, free API, free trial and open model license are four distinct things.

## Routing
- Explicit provider priority, task capabilities and data permissions; at most 3 distinct configured providers per job, one attempt per provider.
- Quota/auth/capability rejection permits another eligible provider. Refusals, ambiguous transports, invalid output or 5xx do not trigger blind retries or weaker privacy filters.
- OpenRouter's internal free model choice is not deterministic; the outer provider order is. Model identity is retained after successful inference.
- A configured `cloudflare_free` route uses FLUX only for `photo-enhance`. For attachment-free assistant/product-copy/translation/campaign work it may use the separately pinned Gemma 4 text fallback. Menu images, PDFs and invoices are not silently forwarded through the Cloudflare chat fallback.
- Cloudflare text calls use the Workers AI OpenAI-compatible endpoint with structured JSON output and `rejectIfBusy`; a paid-plan-required response is treated as an explicit rejection, never as permission to upgrade.
- Inference budget is 45s inside a 90s existing run lease; no DB row lock during external HTTP.
- Durable attempt reservation before network call. Per-credential rolling-24h limit, 3/minute cap, uncertainty/rate cooldown; identical credentials across branches share this app's counter. Provider-wide quotas may be stricter.
- No automatic quota reset, key rotation, account multiplication, billing API, card entry, credit topup or paid fallback.
- When no eligible route/quota exists, return a recoverable quota/access state. Do not claim a scheduled automatic retry: no new retry daemon is installed by this change.

## Honest free-plan boundary
For Gemini/Groq/Cloudflare, a generation key alone cannot attest the account's billing plan. The company operator must use a dedicated Free/unbilled account, explicitly attest billing is disabled, and renew that declaration every 30 days. The app blocks after expiry and never enables billing. If the operator upgrades the provider outside MenüGO, disable its MenüGO connection first. App request limits are additional protection, not a substitute for the provider's hard free-plan cap.

Cloudflare documents 10,000 Neurons/day at no charge. On Workers Free, usage beyond that allocation fails; on Workers Paid, overage is billable. Therefore MenüGO's Cloudflare route requires an explicitly confirmed Workers Free account and does not invoke third-party AI Gateway models, prepaid credits or paid-only Workers AI models.

## Privacy
- Only assigned MenüGO company AI roles edit keys; restaurant owner/manager can use permitted product workflows but cannot configure provider credentials or routing. Secrets live in Supabase Vault, never returned in status/client storage or committed to Git.
- Free Gemini requires separate explicit permission for shareable menu material. Invoice and unstructured assistant requests are private by default and excluded.
- Groq private workloads require ZDR company confirmation; OpenRouter uses hard ZDR+deny filters. If no private-capable route exists, stop.
- Cloudflare states Workers AI Customer Content is not used to train models or improve Cloudflare/third-party services without explicit consent. Private-content routing still requires explicit company approval; this policy does not override any model/license terms.
- Original photo retained for comparison; model reference resized to <=511px and output re-decoded server-side. Both source attachments removed on discard/retention expiry.
- Image adapter outputs a draft only; no product/image publication or logo redraw automatically. No claims that these models always preserve ingredients/portion.

## Deployment order
1. Feature branch tests: unit, isolated SQL, native PostgreSQL17, Deno Edge typecheck, Next production build, mocked role/UI regression.
2. Apply additive ops migration if schema changes are required (no catalogue/customer/payment writes).
3. Deploy exact `menugo-llm` Edge source with existing custom auth (`verify_jwt=false` intentionally unchanged).
4. Merge tested frontend to main for Vercel automatic production build.
5. Verify public release and unauthenticated route rejection.
6. Company AI administrator enters Free provider keys only through authenticated `/platform/yapay-zeka`. Run explicit synthetic non-private probe then a real controlled menu/photo acceptance case before commercial AI use.

No live provider acceptance is claimed while credentials are missing. No guarantee of unlimited capacity or perfect results.
