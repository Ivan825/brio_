# M6 hosted-agent adapters: wire-level reference (verified 23 Oct 2026)

Sources are the vendors' own docs, fetched on 23 Oct 2026. Items marked **UNVERIFIED** were not confirmed on an official page. Model and agent IDs shown in examples (`claude-opus-5-5`, `gpt-6-astra`, `antigravity-preview-09-2026`, and so on) are only doc examples. Per rule 8, treat them as data and never hard-code them.

Quick matrix:

| Service | Auth | Progress | Needs-input signal | Cancel | Usage |
|---|---|---|---|---|---|
| Claude Managed Agents | `x-api-key` + `anthropic-beta: managed-agents-2026-04-01` | SSE `/events/stream` + list events | `session.status_idle` with `stop_reason.type=requires_action` | `user.interrupt` event; archive/delete | `session.usage` (tokens + `list_cost` cents) |
| OpenAI Agents API | Bearer + `OpenAI-Beta: agents=v1` | SSE `/events?stream=true`; webhooks | `agent.session.requires_action` → `session.required_actions[]` | event `agent.session.input.cancel` | `session.usage` TokenUsage (best effort) |
| Gemini managed agents (Interactions) | `x-goog-api-key` | SSE (`stream:true`) or poll GET | `status: requires_action` | `POST /interactions/{id}/cancel` | `usage.total_tokens` etc. |
| Jules | `x-goog-api-key` | poll sessions + activities | `AWAITING_PLAN_APPROVAL`, `AWAITING_USER_FEEDBACK` | none documented (DELETE is documented on one page only) | none |
| Devin v3 | Bearer `cog_...` | poll GET session | `status_detail: waiting_for_user / waiting_for_approval` | `DELETE` session (terminate) | `acus_consumed` |
| Manus v2 | `x-manus-api-key` | poll `task.listMessages`; webhooks | `agent_status: waiting` | `POST /v2/task.stop` | `credit_usage` |
| AWS AgentCore Runtime | SigV4 (or JWT bearer) | streaming HTTP response (SSE or JSON, agent-defined) | agent-defined | `StopRuntimeSession` | none in API (CloudWatch) |
| Azure Foundry Agent Service | Entra bearer (`https://ai.azure.com/.default`) | Responses SSE or background poll | `function_call` / `mcp_approval_request` output items | session `:stop`; per-response cancel UNVERIFIED | Responses `usage` (UNVERIFIED for agents) |

---

## 1. Claude Managed Agents (Anthropic): verified, beta

- **Base URL:** `https://api.anthropic.com/v1`
- **Headers (every call):** `x-api-key: $KEY`, `anthropic-version: 2023-06-01`, `anthropic-beta: managed-agents-2026-04-01`, `content-type: application/json`. The beta header you were given is correct.
- **Resources:** agent (`POST /v1/agents`, versioned), environment (`POST /v1/environments`), session (`POST /v1/sessions`, id prefix `sesn_`), events.
- **Rate limits:** create endpoints 300 rpm per org, read/stream endpoints 1,200 rpm.

**Setup (one-off):**
```http
POST /v1/agents
{"name":"Coder","model":"claude-opus-5-5","system":"...","tools":[{"type":"agent_toolset_20260401"}]}

POST /v1/environments
{"name":"env","config":{"type":"cloud","networking":{"type":"limited","allow_package_managers":true}}}
```

**Create a session and start work in one call.** `initial_events` accepts up to 50 `user.message` or `user.define_outcome` events. The session starts in `running`.
```http
POST /v1/sessions
{
  "agent": "agent_...",                     // or {"type":"agent","id":"...","version":1}
                                            // or {"type":"agent_with_overrides","id":"...","model":{"id":"..."},"system":null}
  "environment_id": "env_...",
  "title": "Brio task T-123",
  "resources": [
    {"type":"github_repository","url":"https://github.com/org/repo","mount_path":"/workspace/repo",
     "authorization_token":"<redacted>","checkout":{"type":"branch","name":"main"}},
    {"type":"file","file_id":"file_...","mount_path":"/spec.md"}
  ],
  "budget": {"type":"limit","max_list_cost":{"amount":"125","currency":"USD"}},   // cents as a string
  "vault_ids": ["vlt_..."],
  "initial_events": [{"type":"user.message","content":[{"type":"text","text":"..."}]}]
}
```
Without `initial_events` the session starts `idle`. Start it with `POST /v1/sessions/{id}/events`.

**Follow progress (SSE).** Open the stream before you send events, because the stream does not replay past events.
```http
GET /v1/sessions/{id}/events/stream?beta=true
accept: text/event-stream
```
- To reconnect: open a new stream, call `GET /v1/sessions/{id}/events` (paginated, supports `types[]=` filter), then dedupe by event `id`.
- **Events received:**
  - `agent.message` (content blocks), `agent.thinking` (a progress signal only), `agent.tool_use` / `agent.tool_result`, `agent.mcp_tool_use` / `agent.mcp_tool_result`, `agent.custom_tool_use`, `agent.thread_context_compacted`.
  - `session.status_running`, `session.status_idle` (has `stop_reason`), `session.status_rescheduled`, `session.status_terminated`, `session.deleted`, `session.updated`, `session.error` (`error.retry_status`), `session.usage`.
  - `span.model_request_start`, `span.model_request_end` (`model_usage`).
  - Multi-agent sessions add `session.thread_*` and `workflow_run.*` events.
- **`stop_reason.type` on `session.status_idle`:**
  - `end_turn`: done, or interrupted.
  - `requires_action`: answer each id in `stop_reason.event_ids`.
  - `budget_reached`: raise or remove the budget, because no event resumes it.
- **Session statuses (GET):** `idle | running | rescheduling | terminated`. A finished session goes `idle`, never `terminated`. `idle` can also mean workflow runs are still open.
- **Webhooks:** event names differ from the stream, for example `session.status_idled` and `session.status_terminated`.

**Follow-up, approval, interrupt.** All of these go through `POST /v1/sessions/{id}/events` with body `{"events":[...]}`:
```json
{"type":"user.message","content":[{"type":"text","text":"Now run the tests"}]}
{"type":"user.tool_confirmation","tool_use_id":"<event id>","result":"allow"}        // or "deny"
{"type":"user.custom_tool_result","custom_tool_use_id":"<event id>","content":[{"type":"text","text":"..."}]}
{"type":"user.interrupt"}                                                           // then optional user.message to redirect
{"type":"system.message","content":[{"type":"text","text":"..."}]}                  // model-dependent
```

**Outputs:**
- Final text is in the `agent.message` events.
- Files the agent writes to `/mnt/session/outputs/` show up through the Files API. They can take a few seconds after idle to appear.
  ```http
  GET /v1/files?scope_id=sesn_...          (needs the managed-agents beta header)
  GET /v1/files/{file_id}/content
  ```
- **PRs:** there is no PR field. The agent pushes and opens PRs through the GitHub MCP server (`https://api.githubcopilot.com/mcp/`) plus a token on the repo resource. Parse the PR URL from `agent.mcp_tool_result` or `agent.message`. **UNVERIFIED:** whether any structured PR output exists.

**Cancel / cleanup:**
- `user.interrupt` stops the current turn.
- `POST /v1/sessions/{id}/archive` and `DELETE /v1/sessions/{id}` both require the session to be `idle` first. Delete also removes session-produced files.

**Cost:** the session's `usage` field, also emitted as the `session.usage` event just before every idle:
```json
{"input_tokens":5000,"output_tokens":3200,"cache_read_input_tokens":20000,
 "cache_creation":{"ephemeral_5m_input_tokens":2000,"ephemeral_1h_input_tokens":0},
 "list_cost":{"amount":"187","currency":"USD"},"active_seconds":342.5,
 "server_tool_use":{"web_search_requests":3,"web_fetch_requests":0}}
```
A hard cap is available through `budget` at create time. It maps directly to Brio governance.

**Key check:** `GET /v1/sessions?limit=1`, or `GET /v1/agents`.

**Docs:**
- https://platform.claude.com/docs/en/managed-agents/sessions
- https://platform.claude.com/docs/en/managed-agents/events-and-streaming
- https://platform.claude.com/docs/en/managed-agents/session-operations
- https://platform.claude.com/docs/en/managed-agents/session-observability
- https://platform.claude.com/docs/en/managed-agents/reference
- https://platform.claude.com/docs/en/managed-agents/quickstart
- https://platform.claude.com/docs/en/managed-agents/files
- https://platform.claude.com/docs/en/managed-agents/github

---

## 2. OpenAI Agents API (hosted sessions): verified, public beta since 10 Sep 2026

The changelog confirms both dates: Agents API public beta on **Sep 10 2026**, and computer use in an OpenAI-hosted browser on **Sep 29 2026**. Your event name is slightly off, as noted below.

- **Base URL:** `https://api.openai.com/v1`
- **Headers:** `Authorization: Bearer $OPENAI_API_KEY`, `OpenAI-Beta: agents=v1`, `Content-Type: application/json`, and optionally `Idempotency-Key` on event POSTs.
- **Key scopes:** `api.agents.read`, `api.agents.write`, and `api.responses.write` (from the beta FAQ).
- **Data controls:** US data residency only. No Zero Data Retention support.

**Endpoints (from the API reference):**
- Agents: `POST /agents`, `GET /agents`, `GET|POST|DELETE /agents/{id}`
- Environments: `POST|GET /agents/environments`, plus `/files` and `/templates`
- Sessions: `POST|GET /agents/sessions`, `GET|POST|DELETE /agents/sessions/{id}`
- Session events: `POST /agents/sessions/{id}/events`, `GET /agents/sessions/{id}/events?stream=true`
- Session history: `GET .../items`, `.../turns`, `.../turns/{turn_id}`, `.../subagents...`, `.../traces`
- Artifacts: `GET .../artifacts`, `GET .../artifacts/{artifact_id}`, `GET .../artifacts/{artifact_id}/content`, `DELETE .../artifacts/{artifact_id}`

**Create a session (inline agent, hosted sandbox, first turn streamed):**
```http
POST /v1/agents/sessions
{
  "agent": {"model":"gpt-6-astra","instructions":"...",
            "tools":[{"type":"computer_use","include_screenshots":true}]},   // optional
  "environment": {"type":"openai_hosted"},     // or "none" | "self_hosted"; browser: add "desktop":{"enabled":true},"network":{"access":"enabled"}
  "input": "Do X",                             // string or [{role:"user",content:[{type:"input_text",text}]}]
  "stream": true
}
```
The request limit is 4 MiB. Store `session_id` (form `sess_...`).

**Follow progress (SSE):**
```http
GET /v1/agents/sessions/{id}/events?stream=true
Accept: text/event-stream
```
- Streams do **not** replay. After a disconnect, call `GET` on the session and its `items` and `turns`.
- **Lifecycle events:**
  - `agent.session.created`, `agent.session.in_progress`, `agent.session.idle`
  - `agent.session.requires_action`, `agent.session.failed`
  - `agent.session.environment.connected`, `agent.session.environment.failed`
  - `agent.session.turn.created`, `agent.session.turn.in_progress`, `agent.session.turn.item.added`
  - `agent.session.turn.output_text.delta`, `agent.session.turn.output_text.done`
  - `agent.session.turn.completed`, `agent.session.turn.failed`, `agent.session.turn.cancelled`
  - `error`
- **Terminal states:** treat turn `completed`, `failed`, or `cancelled` on a turn with `subagent_id === null` as the end of the root turn. `idle` alone does **not** mean success.
- **Webhooks:** a separate stream that uses `agent.session.action_required`, not `requires_action`.
- **Session `status`:** `idle | in_progress | requires_action | failed`.

**Needs input.** On `agent.session.requires_action`, read `event.session.required_actions[]`, or GET the session. Entry types and how to answer them:
- `function_call` (`turn_id`, `call_id`, `name`, `arguments`): answer with `agent.session.input.tool_result`.
- `environment_connection` (`environment_id`): connect the environment.
- `computer_use_approval_request` (`request_id`, `turn_id`, `request.type` = `browser_origin_access` | `browser_authentication`): answer with `agent.session.input.computer_use_approval_request_result`.

**Follow-up, approval, cancel.** All of these go through `POST /v1/agents/sessions/{id}/events`:
```json
{"events":[{"type":"agent.session.input.message","input":[{"role":"user","content":[{"type":"input_text","text":"..."}]}]}]}
{"events":[{"type":"agent.session.input.tool_result","turn_id":"turn_123","call_id":"call_123","success":true,"output":"<string>"}]}
{"events":[{"type":"agent.session.input.computer_use_approval_request_result","request_id":"REQ","response":{"type":"browser_origin_access","decision":"approve"}}]}   // approve|deny|cancel
{"events":[{"type":"agent.session.input.cancel"}]}
```
- A message sent while a turn is active steers that turn. A message sent while idle starts a new turn.
- `browser_authentication` answers use `{"type":"browser_authentication","action":"submit","fields":[{field_id,value}],"selected_option":...}` or `{"action":"cancel"}`.

**Outputs:**
- Final text comes from `output_text` deltas and items (`GET .../items?order=asc&limit=100`).
- Files under `/workspace/outputs` are published as immutable **artifacts** when a turn completes: `GET .../artifacts`, then `.../artifacts/{id}/content`.
- PRs: no PR primitive. **UNVERIFIED:** git/PR flow.

**Cancel / cleanup:**
- `agent.session.input.cancel` stops the current turn.
- `DELETE /v1/agents/sessions/{id}` deletes the session. Closing a stream does not cancel work.

**Cost:**
- `session.usage` is a TokenUsage object (`input_tokens`, `input_tokens_details.cached_tokens`, `output_tokens`, and more). It is "best effort, may change". Turns also carry usage.
- Hosted sandboxes bill at container rates, and since 9 Oct 2026 only during active turns.
- **UNVERIFIED:** any dollar figure in the API.

**Key check:** `GET /v1/agents/sessions?limit=1&order=desc`, or `GET /v1/agents`.

**Docs:**
- https://developers.openai.com/api/docs/guides/agents-api/overview
- https://developers.openai.com/api/docs/guides/agents-api/quickstart
- https://developers.openai.com/api/docs/guides/agents-api/sessions
- https://developers.openai.com/api/docs/guides/agents-api/sessions/events
- https://developers.openai.com/api/docs/guides/agents-api/sessions/manage
- https://developers.openai.com/api/docs/guides/agents-api/sessions/webhooks
- https://developers.openai.com/api/docs/guides/agents-api/tools/functions
- https://developers.openai.com/api/docs/guides/agents-api/tools/computer-use
- https://developers.openai.com/api/docs/guides/agents-api/environments/openai-hosted
- https://developers.openai.com/api/docs/guides/agents-api/environments/files
- https://developers.openai.com/api/docs/guides/agents-api/observability
- https://developers.openai.com/api/reference/resources/beta/subresources/agents
- https://developers.openai.com/api/docs/changelog
- https://help.openai.com/en/articles/20001551

The OpenAI docs also list "Bedrock Managed Agents" as an AWS service built on this API. That is separate from AgentCore below and was not researched.

---

## 3. Gemini managed agents via the Interactions API: verified, managed agents in Public Preview

- The Interactions API itself has been **GA since June 2026**, per the overview page. One older page still says "Beta".
- Managed agents (the "Antigravity" agent, custom agents, Deep Research) are **Public Preview**.
- **Base URL:** `https://generativelanguage.googleapis.com/v1beta`
- **Headers:** `x-goog-api-key: $GEMINI_API_KEY`, `Content-Type: application/json`. Some examples also send `Api-Revision: 2026-05-20`. **UNVERIFIED:** whether that header is required, so pin it to be safe.

**Create a run (an "interaction"):**
```http
POST /v1beta/interactions
{
  "agent": "antigravity-preview-09-2026",        // or a saved agent id, or "deep-research-preview-04-2026"
  "input": [{"type":"text","text":"..."}],       // or a plain string
  "environment": {"type":"remote"},              // new sandbox; or "<environment_id>" to reuse files
  "background": true,                            // async; requires store=true (default)
  "stream": false,
  "agent_config": {"type":"antigravity","model":"<gemini model>","max_total_tokens":50000}  // optional
}
```
- The response is an `Interaction` with `id`, `environment_id`, `status`, `output_text`, `steps[]`, and `usage`.
- Saved agents: `POST /v1beta/agents` with `{id, base_agent, agent_config, system_instruction, base_environment:{type:"remote",sources:[...]}}`. Also `GET /v1beta/agents`, `GET/DELETE /v1beta/agents/{id}`.

**Follow progress, by polling:**
- `GET /v1beta/interactions/{id}`
- `status` values: `in_progress | requires_action | completed | failed | cancelled`, plus `incomplete` when `max_total_tokens` is hit.
- Terminal: `completed | failed | cancelled | incomplete`.
- Needs input: `requires_action`, which covers a tool confirmation, a question, or a client `function_call` step.

**Follow progress, by SSE:** set `"stream": true` on create, or resume with `GET /v1beta/interactions/{id}?stream=true&last_event_id=...`.
```
event: interaction.created         data: {"interaction":{"id":"v1_...","status":"in_progress",...}}
event: interaction.status_update   data: {"interaction_id":"...","status":"in_progress"}
event: step.start / step.delta / step.stop   (step.stop carries running "usage" and "step_usage")
event: interaction.completed       data: {"interaction":{"status":"completed"|"requires_action",...,"usage":{...}}}
```

**Follow-up or tool result.** Send a new `POST /v1beta/interactions` that chains to the previous one:
```json
{"agent":"...","previous_interaction_id":"<id>","environment":"<environment_id>",
 "input":[{"type":"function_result","name":"get_weather","call_id":"<function_call step id>","result":{...}}]}
```
- Chaining onto an `in_progress` interaction returns 400.
- **UNVERIFIED:** the exact input shape for answering a confirmation or question in `requires_action`, beyond `function_result`.

**Outputs:**
- Final text: `interaction.output_text`. Steps: `steps[]`.
- Files:
  ```http
  GET /v1beta/environments/{env}/files?recursive=true
  GET /v1beta/environments/{env}/files/{path}?alt=media
  GET /v1beta/files/environment-{env}:download?alt=media        (tar snapshot)
  ```
- PRs: no PR primitive.

**Cancel / cleanup:**
- Cancel: `POST /v1beta/interactions/{id}/cancel`. The background-execution page uses `/cancel`, while the Antigravity page shows `:cancel`, so the docs are inconsistent. Prefer `/cancel` and fall back to `:cancel`.
- Delete: `DELETE /v1beta/interactions/{id}`.
- Environments are deleted after 7 days idle. `DELETE /v1beta/environments/{id}`.

**Cost:**
- `usage`: `{total_tokens,total_input_tokens,total_output_tokens,total_cached_tokens,total_thought_tokens,total_tool_use_tokens,input_tokens_by_modality}`. No dollar figure.
- Environment compute is not billed during preview.
- Cap spend with `agent_config.max_total_tokens`.

**Key check:** `GET /v1beta/agents`, or `GET /v1beta/models`.

**Docs:**
- https://ai.google.dev/gemini-api/docs/interactions-overview
- https://ai.google.dev/gemini-api/docs/interactions/agents
- https://ai.google.dev/gemini-api/docs/managed-agents-quickstart
- https://ai.google.dev/gemini-api/docs/antigravity-agent
- https://ai.google.dev/gemini-api/docs/custom-agents
- https://ai.google.dev/gemini-api/docs/agent-environment
- https://ai.google.dev/gemini-api/docs/background-execution
- https://ai.google.dev/gemini-api/docs/streaming
- https://ai.google.dev/gemini-api/docs/deep-research

---

## 4. Jules REST API (v1alpha): verified

- **Base URL:** `https://jules.googleapis.com/v1alpha`
- **Header:** `x-goog-api-key: $JULES_API_KEY`
- **Sources (repos):** `GET /v1alpha/sources`, `GET /v1alpha/sources/{id}` (ids like `sources/github-org-repo`).

**Create a session:**
```http
POST /v1alpha/sessions
{"prompt":"Add unit tests for auth","title":"Add auth tests",
 "sourceContext":{"source":"sources/github-myorg-myrepo","githubRepoContext":{"startingBranch":"main"}},
 "requirePlanApproval":true,
 "automationMode":"AUTO_CREATE_PR"}
```
`sourceContext` is optional for repoless sessions. The response looks like:
```json
{"name":"sessions/1234567","id":"abc123","state":"QUEUED","url":"https://jules.google.com/session/abc123",...}
```

**Follow progress (polling only, no streaming):**
- `GET /v1alpha/sessions/{id}` returns `state`:
  - `QUEUED | PLANNING | AWAITING_PLAN_APPROVAL | AWAITING_USER_FEEDBACK | IN_PROGRESS | PAUSED | COMPLETED | FAILED`
  - Terminal: `COMPLETED`, `FAILED`.
  - Needs input: `AWAITING_PLAN_APPROVAL`, `AWAITING_USER_FEEDBACK`.
- `GET /v1alpha/sessions/{id}/activities?pageSize=50&pageToken=...` (or `?createTime=<RFC3339>` for incremental reads), and `GET .../activities/{activityId}`.
- Each activity has exactly one of: `planGenerated{plan{id,steps[]}}`, `planApproved{planId}`, `userMessaged`, `agentMessaged{agentMessage}`, `progressUpdated{title,description}`, `sessionCompleted{}`, `sessionFailed{reason}`.
- Activities can also carry `artifacts[]` of three kinds: `changeSet{source,gitPatch{baseCommitId,unidiffPatch,suggestedCommitMessage}}`, `bashOutput{command,output,exitCode}`, and `media{mimeType,data}`.

**Follow-up and approval:**
```http
POST /v1alpha/sessions/{id}:sendMessage   {"prompt":"Please also add integration tests"}   -> {}
POST /v1alpha/sessions/{id}:approvePlan   {}                                                -> {}
```
The reply to `sendMessage` arrives as a later `agentMessaged` activity.

**Outputs:**
- PR: `session.outputs[].pullRequest{url,title,description}` on GET. It appears with `AUTO_CREATE_PR`.
- Diff: the `changeSet.gitPatch.unidiffPatch` artifact.

**Cancel:**
- No cancel or stop method in the official REST reference.
- jules.google documents `DELETE /v1alpha/sessions/{id}`, but developers.google.com's method list omits it. Treat delete as **UNVERIFIED** and fail closed.

**Cost:** not reported.

**Key check:** `GET /v1alpha/sources?pageSize=1`, or `GET /v1alpha/sessions?pageSize=1`.

**Docs:**
- https://developers.google.com/jules/api/reference/rest
- https://developers.google.com/jules/api/reference/rest/v1alpha/sessions/sendMessage
- https://jules.google/docs/api/reference/sessions/
- https://jules.google/docs/api/reference/activities
- https://jules.google/docs/api/reference/types

---

## 5. Devin API (Cognition): verified; use v3, since v1/v2 are deprecated

- **Base URL:** `https://api.devin.ai/v3/organizations/{org_id}`. Org ids start with `org-`.
- **Header:** `Authorization: Bearer $DEVIN_API_KEY`. Keys are service-user or personal access tokens with prefix `cog_`. Creating sessions needs the `ManageOrgSessions` permission.
- **Session id in paths:** `devin_id`, which is `devin-<session_id>`.

**Create a session:**
```http
POST /v3/organizations/{org_id}/sessions
{"prompt":"Fix the login bug in issue #42",          // required
 "title":"...","repos":["org/repo"],"tags":["brio"],
 "max_acu_limit":10,"playbook_id":"...","knowledge_ids":[],"secret_ids":[],
 "structured_output_schema":{...},"bypass_approval":false,"devin_mode":"normal",   // normal|fast|fusion|lite|ultra
 "create_as_user_id":"user_..."}
```
The response includes `session_id`, `url`, `status`, `tags`, `org_id`, `created_at`, and `updated_at`.

**Follow progress (polling, no streaming documented):**
- `GET /v3/organizations/{org_id}/sessions/{devin_id}`
- `status`: `new | claimed | running | exit | error | suspended | resuming`. The docs list `exit`, `error`, and `suspended` as terminal. `suspended` can be resumed by sending a message.
- `status_detail` while `running`: `working | waiting_for_user | waiting_for_approval | finished`. While suspended it gives the reason: `inactivity`, `user_request`, `usage_limit_exceeded`, `out_of_credits`, and so on.
- Needs input: `waiting_for_user` and `waiting_for_approval`. Approval only happens in "safe mode".
- **UNVERIFIED:** an API call to approve an action. None was found; `bypass_approval` at create time is the only documented lever.
- Messages: `GET .../sessions/{devin_id}/messages?first=100&after=<cursor>` returns `items[]{event_id,message,source:"devin"|"user",created_at}`, `has_next_page`, and `end_cursor`.

**Follow-up:**
```http
POST /v3/organizations/{org_id}/sessions/{devin_id}/messages   {"message":"Please also add unit tests"}
```
This auto-resumes a suspended session.

**Outputs:**
- `pull_requests[]{pr_url,pr_state}` and `structured_output` from GET.
- Files: `GET .../sessions/{devin_id}/attachments` returns `{attachment_id,name,source,url,content_type}`.
- Final text: the last `source:"devin"` message.

**Cancel:**
- `DELETE /v3/organizations/{org_id}/sessions/{devin_id}?archive=false` terminates the session, and it cannot be resumed.
- `POST .../sessions/{devin_id}/archive` archives it and puts it to sleep.

**Cost:** `acus_consumed` (number) on the session. Cap it with `max_acu_limit`.

**Key check:** `GET /v3/self`.

**Docs:**
- https://docs.devin.ai/api-reference/overview
- https://docs.devin.ai/api-reference/v3/usage-examples
- https://docs.devin.ai/api-reference/v3/sessions/post-organizations-sessions
- https://docs.devin.ai/api-reference/v3/sessions/get-organizations-session
- https://docs.devin.ai/api-reference/v3/sessions/get-organizations-session-messages
- https://docs.devin.ai/api-reference/v3/sessions/post-organizations-sessions-messages
- https://docs.devin.ai/api-reference/v3/sessions/get-organizations-session-attachments
- https://docs.devin.ai/api-reference/v3/sessions/delete-organizations-sessions
- https://docs.devin.ai/api-reference/v3/self/self
- https://docs.devin.ai/_llms/en/api.md

---

## 6. Manus API: verified; use v2, since v1 (`API_KEY` header) is deprecated

- **Base URL:** `https://api.manus.ai`. The methods are RPC-style (`/v2/<resource>.<method>`).
- **Header:** `x-manus-api-key: $MANUS_API_KEY`. The alternative is `Authorization: Bearer <oauth token>` for OAuth apps.
- **Response envelope:** `{ok, request_id, ...}`.

**Create a task:**
```http
POST /v2/task.create
{"message":{"content":"Research X and produce a PDF"},       // content: string or ContentPart[]
 "title":"...","agent_profile":"standard",                    // standard|lite|max
 "interactive_mode":false,"structured_output_schema":{...},
 "project_id":"...","locale":"en","hide_in_task_list":true,"share_visibility":"private"}
```
The response is `{ok, request_id, task_id, task_title, task_url, share_url, share_visibility}`.

**Follow progress (polling):**
- `GET /v2/task.listMessages?task_id=...&order=desc&limit=10[&verbose=true&cursor=...&start_event_id=...]`
- Event `type` values: `user_message | assistant_message | error_message | status_update | tool_used | plan_update | new_plan_step | explanation | user_stop | structured_output_result`. Several of these need `verbose=true`.
- `status_update.agent_status`: `running | stopped | waiting | error`.
- `GET /v2/task.detail?task_id=...` returns `task.status` (`running|stopped|waiting|error|deleted`), `credit_usage`, and `has_running_background_jobs`.
- `stopped` is not final if `has_running_background_jobs` is true.

**Follow progress (webhooks):**
- Register with `POST /v2/webhook.create {"url":"https://..."}`.
- Events: `task_created`, `task_stopped` (`task_detail.stop_reason` is `"finish"` or `"ask"`, plus `message`, `attachments[]{file_name,url,size_bytes}`, `structured_output`), and `task_deleted`.
- Signatures: RSA-SHA256 in `X-Webhook-Signature` and `X-Webhook-Timestamp` headers, over `{timestamp}.{url}.{sha256_hex(body)}`. Get the public key from `webhook.publicKey`.

**Needs input (`agent_status: waiting`).** Read `status_detail.waiting_for_event_type`:
```http
# Agent question (messageAskUser / cascadeAskUser): reply with
POST /v2/task.sendMessage   {"task_id":"...","message":{"content":"Please export both PDF and DOCX."}}
# Action confirmation (gmailSendAction, deployAction, terminalExecute, ...):
POST /v2/task.confirmAction {"task_id":"...","event_id":"<waiting_for_event_id>","input":{"accept":true}}   // shape per confirm_input_schema
```
Any ordinary message skips a pending confirmation. A plain follow-up uses the same `task.sendMessage`.

**Outputs:**
- Final text: `assistant_message` events or `task_stopped.message`.
- Files: `attachments[]` URLs, and `GET /v2/artifact.list`.
- Structured output: `structured_output_result` / `structured_output`.
- PRs: no PR primitive.

**Cancel:** `POST /v2/task.stop {"task_id":"..."}` sets the status to `stopped`, and the task can still be resumed by a message. `POST /v2/task.delete` deletes it permanently.

**Cost:** `task.detail.credit_usage` (credits, not dollars). Also `GET /v2/usage.list`, `usage.availableCredits`, and `usage.teamStatistic`.

**Key check:** `GET /v2/user.me`.

**Docs:**
- https://open.manus.ai/docs/v2/authentication
- https://open.manus.ai/docs/v2/task-lifecycle
- https://open.manus.ai/docs/v2/webhooks-overview
- https://open.manus.ai/docs/v2/webhooks-security
- https://open.manus.ai/docs/v2/openapi_v2.json
- https://open.manus.ai/docs/llms.txt

---

## 7. AWS Bedrock AgentCore Runtime (InvokeAgentRuntime): verified

This is a host for **your own** agent container. It is not a turnkey agent, so the payload and output formats are whatever the deployed agent defines.

- **Data-plane host:** `https://bedrock-agentcore.{region}.amazonaws.com`
- **Control-plane host:** `bedrock-agentcore-control.{region}.amazonaws.com`. Its API version is 2023-06-05; the data plane is 2024-02-28.
- **Auth:** IAM **SigV4** by default. A runtime can instead be configured for a JWT `Authorization: Bearer` (OAuth inbound), but not both at once.
- **SigV4 signing name:** `bedrock-agentcore`. **UNVERIFIED** from the docs page; it is inferred from the SDK client name. Use a SigV4 library such as `@smithy/signature-v4` or `aws4fetch`, not hand-rolled signing.
- **IAM permission:** `bedrock-agentcore:InvokeAgentRuntime`, plus `...InvokeAgentRuntimeForUser` if you send the user-id header.

**Invoke.** This both creates and continues a session; there is no separate create call.
```http
POST /runtimes/{urlencoded agentRuntimeArn}/invocations?qualifier=DEFAULT      (or ?accountId=123456789012 when using the agent id)
Content-Type: application/json
Accept: text/event-stream            (or application/json)
X-Amzn-Bedrock-AgentCore-Runtime-Session-Id: <33-256 chars, e.g. a UUID>
X-Amzn-Bedrock-AgentCore-Runtime-User-Id: <optional>
X-Amzn-Trace-Id / traceparent / tracestate / baggage: <optional>
Mcp-Session-Id / Mcp-Protocol-Version / Mcp-Method / Mcp-Name: <MCP-protocol runtimes only>

{"prompt":"..."}                      // payload is agent-defined, up to 100 MB
```
The response echoes `X-Amzn-Bedrock-AgentCore-Runtime-Session-Id` and `Content-Type`. The body is either SSE (`data: ...` lines, with a framework-specific shape such as a Strands `event.contentBlockDelta.delta.text`) or JSON.

**Follow progress:** only the streaming response body. There is no status-polling or event-list API, and no standard "needs input" state; any such protocol is agent-defined.

**Follow-up:** call InvokeAgentRuntime again with the **same** session-id header. A 409 `RetryableConflictException` ("Session operation in progress, please retry") is transient, so retry with backoff.

**Outputs:** whatever the agent returns. Shell commands can run in the same session through `InvokeAgentRuntimeCommand`. **UNVERIFIED:** its wire format was not fetched.

**Cancel:**
```http
POST /runtimes/{arn}/stopruntimesession?qualifier=DEFAULT
X-Amzn-Bedrock-AgentCore-Runtime-Session-Id: <id>
Content-Type: application/json

{"clientToken":"<optional idempotency token, 33-256 chars>"}
```
Idle and max lifetimes are set per runtime (`lifecycleConfiguration.idleRuntimeSessionTimeout`, `maxLifetime`).

**Cost:** nothing in the API response. **UNVERIFIED:** usage via CloudWatch or billing.

**Key check:** the control-plane `POST /runtimes/?maxResults=1` (ListAgentRuntimes; the docs really do show POST). Or STS `GetCallerIdentity` to validate credentials.

**Errors:** 400 Validation, 402 ServiceQuotaExceeded, 403 AccessDenied, 404 NotFound, 409 RetryableConflict, 424 RuntimeClientError, 429 Throttling, 500 Internal.

**Docs:**
- https://docs.aws.amazon.com/bedrock-agentcore/latest/APIReference/API_InvokeAgentRuntime.html
- https://docs.aws.amazon.com/bedrock-agentcore/latest/APIReference/API_StopRuntimeSession.html
- https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-invoke-agent.html
- https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-oauth.html
- https://docs.aws.amazon.com/bedrock-agentcore-control/latest/APIReference/API_ListAgentRuntimes.html

---

## 8. Azure AI Foundry Agent Service (Responses-API format): mostly verified

The service is now branded "Microsoft Foundry". The classic Assistants-style API is being retired; that retirement date (26 Aug 2026, from a third-party blog) is **UNVERIFIED**.

- **Project endpoint:** `https://{resource}.services.ai.azure.com/api/projects/{project}`
- **Auth:** `Authorization: Bearer <Microsoft Entra token>`, scope `https://ai.azure.com/.default` (for example `az account get-access-token --scope https://ai.azure.com/.default`). For BYOK, use a service principal client-credentials token. **UNVERIFIED:** API-key auth on the agent endpoints; none was shown.
- **Versioning:** agent management uses `?api-version=v1`. The OpenAI-compatible routes live under `/openai/v1/...` with no api-version in the examples.

**Create an agent (versioned, by name):**
```http
POST {endpoint}/agents?api-version=v1
{"name":"brio-coder","definition":{"kind":"prompt","model":"<deployment name>","instructions":"...",
  "tools":[{"type":"function","name":"...","parameters":{...}}]}}
```
`DELETE {endpoint}/agents/{name}?api-version=v1` deletes it.

**Run (Responses API).** Optionally create a conversation first:
```http
POST {endpoint}/openai/v1/conversations   {"items":[{"type":"message","role":"user","content":[{"type":"input_text","text":"..."}]}]}   -> {"id":"conv_..."}

POST {endpoint}/openai/v1/responses
{"agent":{"type":"agent_reference","name":"brio-coder"},   // runtime-components page instead shows top-level "agent_reference":{...}
 "conversation":"conv_...",
 "input":[{"role":"user","content":"..."}],
 "stream":false, "background":true}
```
- There is also an agent-scoped route: `POST {endpoint}/agents/{name}/endpoint/protocols/openai/responses?api-version=v1` (and `/conversations`).
- The docs show both `agent` and `agent_reference` as the body key. Test both.

**Follow progress:**
- With `stream:true`: Responses SSE. **UNVERIFIED** for this service, but presumably the standard `response.created` / `response.output_text.delta` / `response.completed` events.
- With `background:true`: poll `GET {endpoint}/openai/v1/responses/{response_id}` while `status` is `queued` or `in_progress`. **UNVERIFIED:** the terminal values `completed | failed | cancelled | incomplete`, assumed from the standard Responses API.

**Needs input:**
- `output[]` contains `{"type":"function_call","call_id","name","arguments"}`. Answer with another `POST /openai/v1/responses` whose `input` is `[{"type":"function_call_output","call_id":"...","output":"<string>"}]`, on the same conversation.
- MCP tools with `require_approval:"always"` emit `mcp_approval_request`. Answer with `input:[{"type":"mcp_approval_response","approval_request_id":"<item id>","approve":true}]` plus `previous_response_id`.

**Outputs:**
- Final text: `output[].content[].text` (`output_text`).
- Hosted agents have session files: `PUT|GET|DELETE {endpoint}/agents/{name}/endpoint/sessions/{id}/files[/content]`.
- PRs: no PR primitive.

**Cancel:**
- Hosted-agent sessions: `POST {endpoint}/agents/{name}/endpoint/sessions/{id}:stop?api-version=v1`.
- **UNVERIFIED:** per-response `POST /openai/v1/responses/{id}/cancel` (the Responses-standard route; Foundry docs only mention a turn-scoped "cancel API contract" without the path).
- `DELETE {endpoint}/openai/v1/conversations/{id}` deletes a conversation.

**Cost:** **UNVERIFIED** in the agents docs, but presumably the Responses `usage` object (input, output, and total tokens).

**Key check:** `GET {endpoint}/agents?api-version=v1`. **UNVERIFIED:** the list route (only POST and DELETE were seen).

**Docs:**
- https://learn.microsoft.com/en-us/azure/foundry/agents/quickstarts/prompt-agent
- https://learn.microsoft.com/en-us/azure/foundry/agents/concepts/runtime-components
- https://learn.microsoft.com/en-us/azure/foundry/agents/how-to/tools/function-calling
- https://learn.microsoft.com/en-us/azure/foundry/agents/how-to/tools/model-context-protocol
- https://learn.microsoft.com/en-us/azure/foundry/agents/how-to/manage-hosted-sessions

---

## Adapter notes for Brio

- **Secrets in request bodies (rule 7):** redact `authorization_token` (Claude repo resource), `webdevRequestSecrets` (Manus), and any `x-*-api-key` header before logging or emitting events.
- **Approval gates that map to Brio governance:**
  - Claude: `requires_action` + `user.tool_confirmation`
  - OpenAI: `required_actions` (`function_call`, `computer_use_approval_request`)
  - Gemini: `requires_action`
  - Jules: `AWAITING_PLAN_APPROVAL` → `:approvePlan`
  - Devin: `waiting_for_approval` (approve call **UNVERIFIED**)
  - Manus: `task.confirmAction`
  - Foundry: `mcp_approval_request`
- **Native budget caps:**
  - Claude: `budget.max_list_cost`, in USD cents
  - Devin: `max_acu_limit`
  - Gemini: `max_total_tokens`
  - Others: enforce in Brio.
- **Streams that do not replay:** Claude (list history and dedupe), OpenAI (re-GET session, items, and turns), Gemini (`last_event_id` resumes). Poll-only: Jules, Devin, Manus (Manus also has webhooks).
