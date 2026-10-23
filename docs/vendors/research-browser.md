# M6 reference: research/search and browser/computer-use APIs

Checked on 23 Oct 2026 against official docs (WebFetch), plus live probes with deliberately invalid keys to confirm auth header names and error shapes. No real keys were used. Model ids that appear below are examples taken from the docs. They are data, not code (rule 8): fetch live model lists at runtime.

Legend: **[V]** verified in official docs or a live probe. **[V-sdk]** read from the vendor's official SDK source on npm. **[UNVERIFIED]** not confirmed; do not rely on it.

Results from the invalid-key probes [V]:

| API | Bad-key status | Error body shape |
|---|---|---|
| Perplexity | 401 | `{"error":{"message","type":"invalid_api_key","code":401}}` |
| OpenAI | 401 | `{"error":{"message","type",...}}` |
| xAI `/v1/api-key` | **400** (not 401) | `{"code":"invalid-argument","error":"Incorrect API key provided..."}` |
| Exa | 401 | `{"requestId","error"}` |
| Tavily | 401 | `{"detail":{"error":"..."}}` |
| Parallel | 401 | `{"code":16,"message":"Invalid API key (C.1)"}` |
| Brave | **422** (not 401) | `{"error":{"code":"SUBSCRIPTION_TOKEN_INVALID",...}}` |
| Firecrawl | 401 | `{"success":false,"error":"Unauthorized: Invalid token"}` |
| Jina | 401 | `{"data":null,"code":401,"name":"AuthenticationFailedError","status":40102,...}` |
| Browser Use | 401 | `{"detail":"Invalid API key"}` |
| Browserbase | 401 | `{"statusCode":401,"error":"Unauthorized","message":"Unauthorized"}` |
| Steel | 401 | `{"error":"Unauthorized","message":"Invalid Steel API key..."}` |

Adapters must treat **401, 403, 400 (xAI) and 422 (Brave)** as `auth_failed` when the body says so.

---

## 1. Perplexity

**Breaking change [V]:** support for Sonar Chat Completions **ended 27 Sep 2026**. Sync and streaming Sonar calls are now being reformulated as Agent API requests. Async Sonar is gone and is replaced by background mode. **Build against the Agent API only.**

- Base URL: `https://api.perplexity.ai` [V]
- Auth: `Authorization: Bearer $PERPLEXITY_API_KEY` [V, probe]

### Agent API

Endpoint: `POST /v1/agent` [V]. `POST /v1/responses` is an alias for the OpenAI SDK. You can also set the OpenAI SDK `baseURL` to `https://api.perplexity.ai/v1`.

```json
POST /v1/agent
{ "model": "openai/gpt-5.6-sol",
  "input": "What changed in EU AI Act enforcement this month?",
  "instructions": "Cite sources.",
  "tools": [{"type": "web_search"}],
  "effort": "low" }
```

- Web search is **opt-in** [V]. If you send only `model` and `input`, the answer has no citations.
- `effort` [V] takes `fast | low | medium | high | xhigh`. The docs map the old models this way: Sonar and Sonar Pro → `fast`, Sonar Reasoning Pro → `low`, Sonar Deep Research → `high`.
- The docs show `effort` alone, with no `model`, in one example. Whether `model` is required when `effort` is set: **[UNVERIFIED]**.
- Other tools [V]: `fetch_url`, `finance_search`, `people_search`, `image_search`, `sandbox`. Set `max_steps` ≥ 3 for finance search.
- Domain and recency filters on `web_search`: **[UNVERIFIED]**. The old Sonar fields `search_domain_filter` and `search_recency_filter` are not documented for the Agent API.

Response [V]:

```json
{ "id": "...", "object": "response", "model": "openai/gpt-5.6-luna", "status": "completed",
  "output": [
    { "type": "search_results", "queries": ["..."],
      "results": [{ "id": 1, "title": "...", "url": "...", "snippet": "...", "date": "...", "last_updated": "...", "source": "web" }] },
    { "type": "fetch_url_results", "contents": [{ "title": "...", "url": "...", "snippet": "..." }] },
    { "type": "message", "role": "assistant", "status": "completed",
      "content": [{ "type": "output_text", "text": "... [1][3]", "annotations": [] }] } ],
  "usage": { "input_tokens": 0, "output_tokens": 0, "total_tokens": 0,
    "input_tokens_details": { "cached_tokens": 0 }, "output_tokens_details": { "reasoning_tokens": 0 },
    "tool_calls_details": { "search_web": { "invocation": 1 } },
    "cost": { "currency": "USD", "input_cost": 0, "output_cost": 0, "tool_calls_cost": 0, "cache_read_cost": 0, "total_cost": 0 } } }
```

- Citations [V]: the `[n]` markers in the text refer to `output[type=search_results].results`. There is no `choices[]` array.
- `usage.cost.total_cost` is the **authoritative per-call cost**. Record it directly in the cost ledger.

Async (background mode) [V]:

1. `POST /v1/agent` with `"background": true`. The response comes back immediately with an `id`.
2. Poll `GET /v1/agent/{id}`.
   - Non-terminal statuses: `queued`, `in_progress`. An `in_progress` response that carries a `paused` object means an org token limit was hit. Keep polling and do not resubmit.
   - Terminal statuses: `completed`, `failed`, `cancelled`, `incomplete`.
3. Optional: resume a dropped stream with `GET /v1/agent/{id}?stream=true&starting_after=N`.
4. Cancel with `POST /v1/agent/{id}/cancel`. This is asynchronous.

`store:false` responses return 404 on GET [V via search excerpt].

Pricing [V]: per token at each model's rate, plus tool fees.

| Tool | Price |
|---|---|
| `web_search` | $2.50 / 1k (fast: $1 / 1k) |
| `fetch_url` | $0.0005 each |
| `people_search`, `finance_search` | $0.005 each |
| `sandbox` | $0.03 / session |
| Search API (`POST /search`) | $5 / 1k requests ($1 fast) |

Key check: `GET /v1/models` returns `{object:"list", data:[{id:"openai/gpt-5.5", owned_by}]}`. The docs declare `security: []`, so the endpoint may not validate keys [UNVERIFIED as a key check]. A bad bearer token returned 401 in the probe, so it does look like it checks auth. It is also not documented as free [UNVERIFIED].

Docs:
- https://docs.perplexity.ai/docs/agent-api
- https://docs.perplexity.ai/docs/agent-api/background-mode
- https://docs.perplexity.ai/docs/agent-api/migrate-from-sonar/overview
- https://docs.perplexity.ai/docs/getting-started/pricing
- https://docs.perplexity.ai/api-reference/models-get

---

## 2. OpenAI web search and deep research

- Base URL: `https://api.openai.com/v1`
- Auth: `Authorization: Bearer $OPENAI_API_KEY` [V, probe]

### Web search (Responses API)

Use tool type `web_search` [V]. `web_search_preview` is legacy: it has no `filters`, `external_web_access` or `return_token_budget`.

```json
POST /v1/responses
{ "model": "gpt-5.5",
  "input": "what was a positive news story from today?",
  "tools": [{ "type": "web_search",
              "filters": { "allowed_domains": ["openai.com"] },
              "user_location": { "type": "approximate", "country": "GB", "city": "London", "timezone": "Europe/London" },
              "search_context_size": "medium" }],
  "include": ["web_search_call.action.sources"] }
```

- `filters.allowed_domains` / `blocked_domains` [V]: up to 100 each, no protocol, subdomains included.
- Other options [V]: `external_web_access: false` (cache-only mode), `return_token_budget: "default" | "unlimited"`.
- Web search is not supported on `gpt-5` with `minimal` reasoning [V].

Response `output[]` [V]:
- `{type:"web_search_call", id, status, action:{type:"search"|"open_page"|"find_in_page", queries?, sources?}}`
- `{type:"message", content:[{type:"output_text", text, annotations:[{type:"url_citation", start_index, end_index, url, title}]}]}`

The full list of sources consulted is only returned when you pass `include: ["web_search_call.action.sources"]`.

Pricing [V]:
- `web_search`: $10 / 1k calls, plus search content tokens at model rates.
- `web_search_preview` on non-reasoning models: $25 / 1k calls, with free content tokens.

Chat Completions search model: `gpt-5-search-api` [V]. The `gpt-4o-*-search-preview` models were shut down on 23 Jul 2026.

### Deep research

**`o3-deep-research` and `o4-mini-deep-research` were shut down on 23 Jul 2026** [V, deprecations page]. The deprecations page names `gpt-5.6-sol` as the replacement. The web-search guide instead says deep research means "`gpt-5.5` with `high`/`xhigh` reasoning". Resolve the replacement model from the live model list.

Old deep-research rules [V]:
- At least one data source is required: web search, remote MCP (with `require_approval:"never"`), or `file_search`.
- Function tools were not supported.
- `max_tool_calls` caps cost.

Async [V]:
1. Create with `"background": true`.
2. Poll `client.responses.retrieve(id)`, i.e. `GET /v1/responses/{id}` (the standard Responses API path; the deep-research page only shows the SDK call), until the status is no longer `queued` or `in_progress`.
3. Webhooks are available for background requests.

Constraints [V]:
- Background mode keeps data for about 10 minutes for polling.
- Background mode is not ZDR-compatible.

Key check: `GET /v1/models`. It is free and well known; the probe returned 401 on a bad key.

Docs:
- https://developers.openai.com/api/docs/guides/tools-web-search
- https://developers.openai.com/api/docs/guides/deep-research
- https://developers.openai.com/api/docs/deprecations
- https://developers.openai.com/api/docs/pricing

---

## 3. xAI Grok search

- Base URL: `https://api.x.ai/v1`
- Auth: `Authorization: Bearer $XAI_API_KEY` [V, probe]

Live Search (`search_parameters` on chat completions) is **deprecated** in favour of server-side tools on `/v1/responses`. The xAI docs themselves no longer mention Live Search. The deprecation comes from an AI SDK release note (May 2026), and a third-party source says the old endpoint returns 410. **[Deprecation date UNVERIFIED; do not implement search_parameters.]**

```json
POST /v1/responses
{ "model": "grok-4.7",
  "input": "What has NASA posted about Artemis lately?",
  "tools": [
    { "type": "web_search", "filters": { "allowed_domains": ["nasa.gov"] } },
    { "type": "x_search", "allowed_x_handles": ["NASA"], "from_date": "2026-09-01", "to_date": "2026-10-01",
      "enable_image_understanding": true } ] }
```

`web_search` [V]:
- `filters.allowed_domains` or `filters.excluded_domains`, max 5 each. You cannot send both.
- `enable_image_understanding` and `enable_image_search` (booleans).

`x_search` [V]:
- `allowed_x_handles` or `excluded_x_handles`: max 20, no `@`, and you cannot send both.
- `from_date` / `to_date` as `YYYY-MM-DD`. `to_date` is exclusive.
- `enable_image_understanding` and `enable_video_understanding` (booleans).

Citations [V]:
- Top-level `citations`: a list of all URLs encountered. It is returned by default.
- Inline citations: each `output_text.annotations[]` entry is `{type:"url_citation", url, start_index, end_index, title:"1"}`.

Usage [V]: `server_side_tool_usage` reports per-tool counts.

Pricing [V]:
- `web_search`: $5 / 1k calls.
- `x_search`: billed per item fetched: $5 / 1k posts and $10 / 1k profiles. Parent and quoted posts count.
- Tokens are billed separately.

Key check [V]: `GET /v1/api-key` is free metadata. It returns `{api_key_id, name, redacted_api_key, acls[], api_key_blocked, api_key_disabled, team_blocked, team_id, user_id, create_time, modify_time}`. A bad key returns **400**. Treat `api_key_blocked`, `api_key_disabled` or `team_blocked` as unusable.

Docs:
- https://docs.x.ai/docs/guides/tools/search-tools
- https://docs.x.ai/developers/tools/x-search
- https://docs.x.ai/developers/tools/citations
- https://docs.x.ai/developers/pricing
- https://docs.x.ai/developers/rest-api-reference/inference/other

---

## 4. Exa

- Base URL: `https://api.exa.ai`
- Auth: `x-api-key: $EXA_API_KEY` **or** `Authorization: Bearer $EXA_API_KEY` [V, probe error text names both]

```json
POST /search
{ "query": "open-source agent orchestration frameworks", "type": "auto", "numResults": 10,
  "includeDomains": ["github.com"], "startPublishedDate": "2026-01-01T00:00:00Z",
  "contents": { "text": true, "highlights": true } }
```

- `type` [V]: `auto` (default), `lite`, `deep-lite`, `deep`. Legacy values: `instant` and `fast` → `lite`; `deep-reasoning` → `deep`.
- `numResults` [V]: 1–100.
- `includeDomains` [V]: up to 1,200 entries.

Response [V]:

```json
{ "requestId": "...", "searchTime": 0.0,
  "results": [{ "id": "...", "title": "...", "url": "...", "publishedDate": "...", "author": "...",
                "text": "...", "highlights": ["..."], "highlightScores": [0.9], "summary": "..." }],
  "costDollars": { "total": 0.009, "search": {...}, "contents": {...} } }
```

Record `costDollars.total` as the cost.

Pricing [V]:

| Item | Price |
|---|---|
| `lite` | $4 / 1k |
| `auto` / `fast` | $7 / 1k |
| `deep-lite` / `deep` | $12 / 1k |
| `deep-reasoning` | $15 / 1k |
| Answer | $5 / 1k |
| Contents | $1 / 1k pages, per content type |
| Results beyond 10 | $1 / 1k |
| Free credit | $10/month |

Key check: no free endpoint is documented **[UNVERIFIED]**. Cheapest option: a `lite` search with `numResults: 1`, costing $0.004.

Docs:
- https://exa.ai/docs/reference/search (was docs.exa.ai, which now 308-redirects)
- https://exa.ai/pricing

---

## 5. Tavily

- Base URL: `https://api.tavily.com`
- Auth: `Authorization: Bearer tvly-...` [V, probe]
- Optional `X-Project-ID` header.

```json
POST /search
{ "query": "Who is Leo Messi?", "search_depth": "basic", "topic": "general", "max_results": 5,
  "include_answer": "basic", "include_raw_content": false, "time_range": "week",
  "include_domains": [], "include_domains_mode": "restrict" }
```

- `search_depth` [V]: `advanced | basic | fast | ultra-fast`.
- `topic` [V]: `general | news | finance`.
- `max_results` [V]: 0–20.
- `time_range` [V]: `day | week | month | year`, or `d | w | m | y`.

Response [V]:

```json
{ "query": "...", "answer": "...", "images": [],
  "results": [{ "title": "...", "url": "...", "content": "...", "score": 0.0, "raw_content": null, "published_date": null, "favicon": "...", "id": "..." }],
  "response_time": 1.2, "usage": { "credits": 1 }, "request_id": "..." }
```

Pricing [V]: `advanced` costs 2 credits; `basic`, `fast` and `ultra-fast` cost 1. The dollar price per credit was not checked **[UNVERIFIED]**.

Key check [V]: `GET /usage` is free. It returns:
- `key{usage, limit, search_usage, extract_usage, ...}`
- `account{current_plan, plan_usage, plan_limit, paygo_usage, paygo_limit}`

Error shape [V]: `{"detail":{"error":"..."}}`. A 429 may carry `Retry-After`.

Docs:
- https://docs.tavily.com/documentation/api-reference/endpoint/search
- https://docs.tavily.com/documentation/api-reference/endpoint/usage

---

## 6. Parallel (parallel.ai)

- Base URL: `https://api.parallel.ai`
- Auth: `x-api-key: $PARALLEL_API_KEY` [V, probe]
- Optional `parallel-beta` header for beta features.

### Search (sync)

```json
POST /v1/search
{ "objective": "Find recent pricing changes for browser automation APIs",
  "search_queries": ["browserbase pricing 2026", "steel.dev pricing"],
  "mode": "fast",
  "advanced_settings": { "max_results": 5, "source_policy": { "include_domains": ["browserbase.com"] } } }
```

- `search_queries` is required [V]: at least one query.
- `mode` [V]: `turbo | fast | basic | advanced`. Default `advanced`.
- The body schema sets `additionalProperties:false`, so unknown fields cause a 422.

Response [V]: `{ search_id, results:[{url, title?, publish_date?, excerpts:[...]}], session_id, warnings, usage }`

### Task API (async)

1. Create a run [V]: `POST /v1/tasks/runs` returns **202**, e.g. `{run_id:"trun_...", status:"queued", is_active:true, processor, created_at, modified_at}`.

   ```json
   { "processor": "base", "input": "What was the GDP of France in 2023?",
     "task_spec": { "output_schema": { "type": "json", "json_schema": { "type": "object",
       "properties": { "gdp": { "type": "string" } }, "required": ["gdp"], "additionalProperties": false } } },
     "webhook": { "url": "https://brio.example/hooks/parallel", "event_types": ["task_run.status"] } }
   ```

   - Status values: `queued | action_required | running | completed | failed | cancelling | cancelled`.
   - Errors: 402 = no credit, 403 = invalid processor, 429 = quota.

2. Wait for the result [V]: `GET /v1/tasks/runs/{run_id}/result?timeout=600` blocks until the run finishes.
   - **408** = still running, retry.
   - **404** = failed or not found.

   200 response:

   ```json
   { "run": { "run_id": "...", "status": "completed", ... },
     "output": { "type": "json", "content": { "gdp": "$3.1 trillion (2023)" },
       "basis": [{ "field": "gdp", "reasoning": "...", "confidence": "high",
                   "citations": [{ "url": "...", "title": "...", "excerpts": ["..."] }] }] } }
   ```

   Citations live in `output.basis[].citations`, one basis entry per top-level field.

3. Status-only polling: `GET /v1/tasks/runs/{run_id}` (Retrieve Task Run) [V: path listed in llms.txt; schema not read].

Pricing [V]:

| Item | Price per 1k |
|---|---|
| Search `turbo` / `fast` | $1 |
| Search `basic` / `advanced` | $5 |
| Task `lite` | $5 |
| Task `base` | $10 |
| Task `core` | $25 |
| Task `core2x` | $50 |
| Task `pro` | $100 |
| Task `ultra` | $300 |
| Task `ultra2x` | $600 |
| Task `ultra4x` | $1,200 |
| Task `ultra8x` | $2,400 |
| Extract | $1 (per 1k URLs) |

Task runs are charged only when they complete successfully.

Key check: no free endpoint is documented **[UNVERIFIED]**. Cheapest option: a `turbo` search with 1 query, at about $0.001.

Docs:
- https://docs.parallel.ai/api-reference/search-api/search
- https://docs.parallel.ai/api-reference/tasks/create-task-run
- https://docs.parallel.ai/api-reference/tasks/retrieve-task-run-result
- https://docs.parallel.ai/getting-started/pricing

---

## 7. Brave Search API

- Base URL: `https://api.search.brave.com/res/v1`
- Auth: `X-Subscription-Token: $BRAVE_API_KEY` [V, probe]
- Also send `Accept: application/json`.

```
GET /web/search?q=brio+orchestrator&count=10&offset=0&freshness=pw&country=US
```

Parameters [V]:
- `count`: max 20.
- `offset`: 0–9.
- `freshness`: `pd | pw | pm | py`, or a range `YYYY-MM-DDtoYYYY-MM-DD`.

Response [V]: `web.results[]{title, url, description, extra_snippets?}`. Check `query.more_results_available` before paging.

Rate-limit headers: **[UNVERIFIED]**. Not on the fetched page.

Pricing [V]:
- Search: $5 / 1k requests, with $5 free credit per month, 50 QPS.
- Answers: $4 / 1k plus $5 per M tokens, 2 QPS.
- The hero banner says "up to $20 free"; this conflicts with the per-plan figures.

Bad key returns **422** `SUBSCRIPTION_TOKEN_INVALID` [V, probe].

Key check: no free endpoint is documented **[UNVERIFIED]**. Cheapest option: one `count=1` search, about $0.005.

Docs:
- https://api-dashboard.search.brave.com/app/documentation/web-search/get-started
- https://brave.com/search/api/

---

## 8. Firecrawl

- Base URL: `https://api.firecrawl.dev/v2`
- Auth: `Authorization: Bearer fc-...` [V, probe]

```json
POST /scrape
{ "url": "https://example.com", "formats": ["markdown"], "onlyMainContent": true, "maxAge": 172800000, "timeout": 60000 }
```

Parameters [V]:
- `maxAge`: milliseconds of cache age to accept (default 2 days).
- `timeout`: 1,000–300,000 ms.

Response [V]: `{ success: true, data: { markdown, metadata: { statusCode, sourceURL, url, contentType, ... } } }`

- Check `data.metadata.statusCode`: a 403 or 404 target still costs 1 credit.
- A `creditsUsed` field in the response: **[UNVERIFIED]**.

Pricing [V]:
- 1 credit per page. JSON format or the prompt-injection check adds 4 credits per page.
- PDF parsing: 1 credit per page.

| Plan | Credits / month | Price |
|---|---|---|
| Free | 1,000 | $0 |
| Hobby | 5,000 | $19 |
| Standard | 100,000 | $99 |

Key check [V]: `GET /team/credit-usage` is free. It returns `{success, data:{remainingCredits, planCredits, billingPeriodStart, billingPeriodEnd}}`.

Docs:
- https://docs.firecrawl.dev/api-reference/endpoint/scrape
- https://docs.firecrawl.dev/api-reference/endpoint/credit-usage
- https://www.firecrawl.dev/pricing

---

## 9. Jina Reader

- Base URL: `https://r.jina.ai/`
- Auth: `Authorization: Bearer jina_...` [V, probe]. A bad bearer returns 401 `AuthenticationFailedError`. The header is optional; without a key, limits are tracked per IP.

```
GET https://r.jina.ai/https://example.com
Accept: application/json
X-Timeout: 30
X-No-Cache: true
```

Headers [V]:
- `X-Return-Format`
- `X-Engine`: `direct` or `cf-browser-rendering`
- `X-Timeout`: seconds, max 180
- `X-No-Cache`: the cache lifetime is 3600 s
- `X-Target-Selector`
- `X-Retain-Images`
- `X-With-Generated-Alt`
- `X-Respond-With`

POST form [V, GitHub README]: `POST https://r.jina.ai/` with `url=...` as a form body, for hash-routed SPAs. A JSON body `{url}`: **[UNVERIFIED]**.

Response from a live call [V]:

```json
{ "code": 200, "status": 20000,
  "data": { "title": "Example Domain", "description": "", "url": "https://example.com/", "content": "...markdown...",
            "publishedTime": "...", "warning": "...", "metadata": {...}, "httpStatus": 200,
            "usage": { "tokens": 28 } },
  "meta": { "usage": { "tokens": 28 } } }
```

- Treat `data.warning` as non-fatal.
- `data.httpStatus` is the target page's HTTP status.

Rate limits [V]:

| Key | Reader RPM |
|---|---|
| None | 20 |
| Free or paid | 500 |
| Premium | 5,000 |

Search (`https://s.jina.ai/?q=`) allows 100 RPM.

Pricing [V]:
- Reader is billed on output tokens.
- Each search costs ≥ 10k tokens.
- New keys come with 10M free tokens.
- Failed requests are not charged.

Key check: no balance endpoint is documented **[UNVERIFIED]**. Use one Reader GET of `https://example.com`, about 30 tokens.

Docs:
- https://jina.ai/reader/
- https://github.com/jina-ai/reader
- https://jina.ai/api-dashboard/reader

---

## 10. Anthropic computer use

**Current version: `computer_toolset_20260801`** [V]. It is **GA on the Claude API with no beta header**.

Claude 5.5+ models (`claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-5-5`, and others) support computer use **only** through the toolset on the Claude API and Google-managed Vertex. They return an error for the older versions there.

Earlier versions, still in beta [V]:

| Tool version | Beta header | Models |
|---|---|---|
| `computer_20251124` | `anthropic-beta: computer-use-2025-11-24` | Fable/Mythos 5.x, Opus 5, Sonnet 5, Opus 4.5–4.8, Sonnet 4.6; on Bedrock also the 5.5 models |
| `computer_20250124` | `anthropic-beta: computer-use-2025-01-24` | Sonnet 4.5, Haiku 4.5, and others |

Bedrock, Foundry and Claude Platform on AWS offer only the earlier versions.

Tool entry [V]:

```json
{ "type": "computer_toolset_20260801", "configs": { "zoom": { "enabled": false } }, "cache_control": { "type": "ephemeral" } }
```

- Do **not** send `name`, `display_width_px`, `display_height_px`, `display_number` or `enable_zoom`; the toolset rejects them with `invalid_request_error`.
- Coordinates are in the pixel space of the screenshots you return.
- The toolset cannot be declared in the same request as `computer_20251124` or another tool named `computer`.
- Old format, for comparison: `{"type":"computer_20251124","name":"computer","display_width_px":1024,"display_height_px":768,"display_number":1}` plus the beta header.

What the model emits [V]: one or more `tool_use` blocks per turn. Each has `name` set to the member and `"toolset_name":"computer"`. The input has **no `action` field**.

```json
{ "type": "tool_use", "id": "toolu_...", "name": "scroll", "toolset_name": "computer",
  "input": { "coordinate": [500, 400], "scroll_direction": "down", "scroll_amount": 3 } }
```

The 17 members and their inputs [V]:

| Member | Input |
|---|---|
| `screenshot` | `{}` |
| `zoom` | `{region:[x0,y0,x1,y1]}` |
| `left_click`, `right_click`, `middle_click`, `double_click`, `triple_click` | `{coordinate?:[x,y], text?: modifiers}` |
| `left_click_drag` | `{start_coordinate, coordinate, text?}` |
| `mouse_move` | `{coordinate}` |
| `left_mouse_down`, `left_mouse_up` | `{}` |
| `cursor_position` | `{}` |
| `scroll` | `{scroll_direction: up\|down\|left\|right, scroll_amount, coordinate?, text?}` |
| `type` | `{text}` |
| `key` | `{text:"ctrl+s", repeat?: 1..100}` |
| `hold_key` | `{text, duration ≤ 300 s}` |
| `wait` | `{duration ≤ 300 s}` |

What we must execute and return [V]:
- Run the blocks **in order** and stop at the first failure.
- Send one `tool_result` per `tool_use`, all in a single `user` message. Each must echo `"toolset_name":"computer"`.
- Screenshot and zoom results: `content:[{type:"image", source:{type:"base64", media_type:"image/png", data}}]`.
- Other members: a short text result such as `"OK"`. For `cursor_position`, return `"X=512, Y=384"`.
- Errors: `is_error:true`.
- Blocks after a failure must be answered with `is_error:true` and the content `"Not executed: an earlier computer action in this turn failed."`.
- **If any `tool_use` is left unanswered, the request fails.**
- Results may contain only `text` and `image` content.

Image limits [V]: the toolset does **not** downscale.
- Toolset models: ≤ 2,576 px on the long edge and ≤ 4,784 visual tokens, where tokens = ⌈w/28⌉ × ⌈h/28⌉.
- Older models: 1,568 px and about 1.15 MP.
- Resize screenshots yourself and scale the model's coordinates back to the real screen.

Cost [V]:
- The toolset definition adds about 4,500 input tokens. Disabling zoom saves about 410.
- Each screenshot is about 1,000–1,800 input tokens.
- The earlier versions add 466–499 system-prompt tokens plus about 735 tokens per tool definition.
- Computer use is ZDR-eligible because it runs client-side.

Brio note: computer use runs inside our sandbox (a VNC/Xvfb container). The Messages API only plans the actions.

Docs:
- https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool (was docs.anthropic.com, which now 301-redirects)

---

## 11. Amazon Nova Act

**There is a REST API. It is an AWS service API with SigV4/IAM auth, not an API-key REST API** [V]. The API reference says: "The Nova Act service provides a REST API for managing AI-powered workflow automation."

- API version: `nova-act-2025-08-22`.
- SDKs: boto3 `boto3.client('nova-act')` [V] and **AWS SDK for JavaScript v3 `@aws-sdk/client-nova-act`** (v3.1156.0 on npm) [V]. This is the right path for TypeScript. Do not hand-roll SigV4.
- Endpoint: `https://nova-act.{region}.amazonaws.com` and a FIPS variant [V-sdk endpoint ruleset].
- Region: **us-east-1 only** [V, user guide].
- SigV4 signing name `nova-act`: [V-sdk, inferred].

The resource hierarchy is workflowDefinition → workflowRun → session → act. All operations are REST/JSON [V]:

| Operation | Request | Response |
|---|---|---|
| CreateWorkflowDefinition | | |
| CreateWorkflowRun | `PUT /workflow-definitions/{name}/workflow-runs` with body `{modelId, clientInfo:{compatibilityVersion, sdkVersion}, clientToken?, logGroupName?}` | 201 `{workflowRunId, status}`. Run status: `RUNNING \| SUCCEEDED \| FAILED \| TIMED_OUT \| DELETING` |
| CreateSession | | |
| CreateAct | `PUT .../sessions/{sessionId}/acts` with body `{task, toolSpecs?:[{name, description, inputSchema}], clientToken?}` | 201 `{actId, status}`. Act status: `RUNNING \| PENDING_CLIENT_ACTION \| PENDING_HUMAN_ACTION \| SUCCEEDED \| FAILED \| TIMED_OUT` |
| InvokeActStep | `PUT .../acts/{actId}/invoke-step/` with body `{callResults:[{callId, content:[...]}], previousStepId?}` | 200 `{stepId, calls:[{callId, name, input}]}` |
| UpdateAct, GetWorkflowRun, UpdateWorkflowRun, List\*, Delete\* | | |
| ListModels | `POST /models?clientCompatibilityVersion=N` | `{modelSummaries[], modelAliases[], compatibilityInformation}` |

The model is **client-actuated**. Like Anthropic computer use, `InvokeActStep` returns `calls` that **we** must execute in our own browser, then post back as `callResults`. The names of the built-in browser actuation calls, and the screenshot/observation content format, are **[UNVERIFIED]**. They are not in the API reference and are implemented inside the Python SDK.

The Python SDK (`nova-act`) plus a Playwright browser, or the AgentCore Browser, is still the documented developer path. A pure TS adapter would need to reimplement the actuator **[UNVERIFIED feasibility]**. The fallback is to run the Python SDK inside our runner sandbox.

The old free/dev API key from nova.amazon.com/act still working: **[UNVERIFIED]**. The AWS service uses IAM.

Pricing [V]: $4.75 per agent-hour, wall-clock while the agent works. Human-in-the-loop wait time is excluded, and parallel agents bill separately.

Key check: `ListModels` is a cheap, read-only call that needs the IAM permission. Its exact IAM action name: [V via the service authorization list; name not read].

Docs:
- https://docs.aws.amazon.com/nova-act/latest/APIReference/Welcome.html
- https://docs.aws.amazon.com/nova-act/latest/APIReference/API_InvokeActStep.html
- https://docs.aws.amazon.com/nova-act/latest/userguide/what-is-nova-act.html
- https://aws.amazon.com/nova/pricing

---

## 12. Browser Use Cloud

- Auth: `X-Browser-Use-API-Key: bu_...` with **no Bearer prefix** [V, probe]
- Recommended for new integrations: **API v4** (`https://api.browser-use.com/api/v4`) [V].
- v3 (`/api/v3/sessions`) is kept for existing integrations. v2 (`/api/v2/tasks`) is legacy.

### v4 runs

Read from the official OpenAPI at https://browser-use.com/openapi.json [V].

```json
POST /api/v4/runs
{ "task": "Find the current price of the top item on example.com",
  "model": "claude-sonnet-5-5",
  "outputSchema": { "type": "object", "properties": { "price": { "type": "string" } } },
  "maxCostUsd": 1.0,
  "keepAlive": 120 }
```

- `task` is required.
- `model` is an enum. The default is `gpt-6-luna`; the enum also includes claude, gemini and grok models plus `bu-fast` and `bu-ultrafast`.
- Other fields: `modelParams`, `sessionId`, `workspaceId`, `browserSettings`, `secretBindings`, `judge`, `attachedFileIds`.
- `keepAlive` is in seconds, 120–14,400.

Create response (200): `{id, status, model, sessionId, workspaceId, eventsUrl, missingFileIds?}`.

Run status values: `queued | dispatching | running | completed | failed | cancelled`.

Polling:
1. `GET /api/v4/runs/{id}/status` returns `{status}`. This is cheap; the docs suggest polling about every 2 s until a terminal status.
2. Then call `GET /api/v4/runs/{id}` once. It returns a RunSummary: `{id, task, title, model, status, result, output, error, sessionId, totalInputTokens, totalOutputTokens, totalCostUsd, judgement, createdAt, updatedAt}`.

Other endpoints: `GET /api/v4/runs/{id}/events` (event stream), `POST /api/v4/runs/{id}/cancel`.

v4 raw browsers (BaaS): `POST /api/v4/browsers` returns a BrowserSessionItemView `{id, status: active|stopped, cdpUrl, liveUrl, timeoutAt, startedAt, finishedAt, proxyCost, browserCost}`. Stop the browser with `PATCH /api/v4/browsers/{id}` and body `{"action":"stop"}`.

### v2 (legacy)

- `POST /api/v2/tasks` with body `{task, llm, startUrl, maxSteps, structuredOutput (stringified schema), sessionId, secrets, allowedDomains}` returns 202 `{id, sessionId}`.
- `GET /api/v2/tasks/{id}` returns `{status: created|started|finished|failed|stopped, output, steps[], isSuccess, judgeVerdict, cost}`.

### v3

`POST /api/v3/sessions` with `{task, model, outputSchema, keepAlive, maxCostUsd}`. Session status: `created | idle | running | stopped | timed_out | error`. Cost fields include `totalCostUsd`.

### Key check, pricing, docs

Key check [V]: `GET /api/v2/billing/account` returns projectId, concurrentSessionLimit, activeSessionCount and credit balance. The docs say it also applies to v4.

Pricing [V]:
- Pay as you go. Each run reports `totalCostUsd`.
- Concurrency tiers by spend: 10 / 50 / 250 / 500 / 1,000 concurrent browsers.
- Rates per step or per hour: **[UNVERIFIED]**. See https://browser-use.com/pricing.

Docs:
- https://docs.browser-use.com/cloud/api-reference
- https://docs.browser-use.com/llms.txt
- https://browser-use.com/openapi.json
- https://docs.browser-use.com/cloud/api-v2/tasks/create-task

---

## 13. Browserbase and Steel (session → CDP URL)

### Browserbase

- Base URL: `https://api.browserbase.com`
- Auth: `X-BB-API-Key` [V, probe]

```json
POST /v1/sessions
{ "timeout": 300, "region": "us-east-1", "keepAlive": false,
  "browserSettings": { "viewport": { "width": 1280, "height": 800 }, "blockAds": true },
  "proxies": true, "userMetadata": { "brioAttemptId": "..." } }
```

- `projectId` is optional; it is inferred from the key [V].
- `timeout`: 60–21,600 s.
- `region`: `us-west-2` (default), `us-east-1`, `eu-central-1`, `ap-southeast-1`.
- `keepAlive` needs the Hobby plan or above.

Response 201 [V]: `{ id, status: PENDING|RUNNING|ERROR|TIMED_OUT|COMPLETED, connectUrl (wss), seleniumRemoteUrl, signingKey, expiresAt, region, ... }`

CDP [V]: `chromium.connectOverCDP(session.connectUrl)`, or `puppeteer.connect({browserWSEndpoint: connectUrl})`.
- **You must connect within 5 minutes** or the session terminates.
- The internal format of `connectUrl` is undocumented. Treat it as opaque and a secret.

End a session [V]: `POST /v1/sessions/{id}` with body `{"status":"REQUEST_RELEASE"}`.

Key check [V]: `GET /v1/projects` returns `[{id, name, ownerId, defaultTimeout, concurrency, createdAt, updatedAt}]`.

Pricing [V]:

| Plan | Price | Browser hours included | Overage | Proxy |
|---|---|---|---|---|
| Free | $0 | 1 | | |
| Developer | $20 | 100 | $0.12/h | $12/GB |
| Startup | $99 | 500 | $0.10/h | $10/GB |

Docs:
- https://docs.browserbase.com/reference/api/create-a-session
- https://docs.browserbase.com/reference/api/update-a-session
- https://docs.browserbase.com/reference/api/list-projects.md
- https://docs.browserbase.com/platform/browser/getting-started/using-browser-session.md
- https://www.browserbase.com/pricing

### Steel

- Base URL: `https://api.steel.dev`
- Auth: `steel-api-key: $STEEL_API_KEY` [V, probe and `steel-sdk` 0.18.0 source]

The docs pages only show the SDK. The REST shape below comes from the official `steel-sdk` source [V-sdk].

```json
POST /v1/sessions
{ "timeout": 300000, "useProxy": false, "solveCaptcha": false, "blockAds": true,
  "dimensions": { "width": 1280, "height": 800 }, "region": "iad" }
```

- `timeout` is in **milliseconds** (the default is 5 minutes).
- Other options: `inactivityTimeout`, `headless`, `stealthConfig`, `sessionId`.

Response [V-sdk]: `{ id, status: "live"|"released"|"failed", websocketUrl, debugUrl, sessionViewerUrl, timeout, duration, creditsUsed, createdAt, dimensions, ... }`

CDP [V, docs]:
- Playwright docs: connect to `${session.websocketUrl}&apiKey=${STEEL_API_KEY}`.
- Puppeteer docs: connect to `wss://connect.steel.dev?apiKey=${KEY}&sessionId=${id}`.
- Both put the key in the URL query string. **Redact these URLs in logs and events (rule 7).**

Other endpoints [V-sdk]:
- Release: `POST /v1/sessions/{id}/release`. Release all: `POST /v1/sessions/release`.
- `GET /v1/sessions/{id}`
- `GET /v1/sessions/{id}/live-details`
- `POST /v1/sessions/{id}/computer` (a computer-actions endpoint; schema not read)
- One-shot `POST /v1/scrape`, `/v1/screenshot` and `/v1/pdf`.

Key check: `GET /v1/sessions` (list). A bad key gives 401 [V, probe]. The list shape: [UNVERIFIED].

Pricing [V]:

| Plan | Price | Browser rate | Max session | Concurrency |
|---|---|---|---|---|
| Launch | $0 + $30 one-time credit | $0.10/h | 15 min | 10 |
| Scale | $250/mo + $100 credit | $0.08/h | 1 h | 100 |

Usage is billed per minute, rounded up.

Docs:
- https://docs.steel.dev/overview/sessions-api/quickstart
- https://docs.steel.dev/integrations/playwright
- https://docs.steel.dev/overview/pricinglimits
- https://steel.apidocumentation.com/api-reference
- npm `steel-sdk`

---

## Adapter implications for Brio

- **Async patterns:**

  | API | Async pattern |
  |---|---|
  | Perplexity | background + GET poll |
  | OpenAI | background + GET `/responses/{id}` or webhook |
  | Parallel | 202 + long-poll `/result` (408 = retry) or webhook |
  | Browser Use v4 | 200 queued + `/status` poll |
  | Nova Act | client-driven step loop |

  Everything else is synchronous.
- **Authoritative cost fields:**
  - Perplexity: `usage.cost.total_cost`
  - Exa: `costDollars.total`
  - Tavily: `usage.credits`
  - Browser Use: `totalCostUsd`
  - Steel: `creditsUsed`
  - OpenAI and xAI: compute from usage × model rates plus the tool-call fee
- **Free key checks:**
  - OpenAI: `GET /v1/models`
  - xAI: `GET /v1/api-key`
  - Tavily: `GET /usage`
  - Firecrawl: `GET /v2/team/credit-usage`
  - Browser Use: `GET /api/v2/billing/account`
  - Browserbase: `GET /v1/projects`
  - Steel: `GET /v1/sessions`
  - Perplexity: `GET /v1/models` (auth behaviour UNVERIFIED)
  - Exa, Parallel, Brave and Jina: no free check. Use the cheapest paid call, or skip the check and validate on first use.
- **Retired paths to avoid:** Perplexity Sonar `/chat/completions` and `/v1/sonar`, xAI `search_parameters`, OpenAI `o3-deep-research` and `o4-mini-deep-research`, and Anthropic `computer_20250124` on 5.5+ models.
