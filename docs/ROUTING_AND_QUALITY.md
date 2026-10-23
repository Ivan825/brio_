# Planning, Routing, Verification, Learning

This is Brio's brain and its moat. Keep the logic in `packages/core` as pure, tested functions; I/O is injected.

## 1. Task taxonomy (fixed, versioned)

Every task gets exactly one `type`. Scores are kept per type, so the list must be stable. Add types only with a migration that seeds priors.

| Group | Types |
|---|---|
| Code | `code.feature`, `code.bugfix`, `code.refactor`, `code.tests`, `code.review`, `code.migration`, `code.frontend_ui`, `code.infra_devops`, `code.data_pipeline`, `code.merge_resolve` |
| Design & contracts | `design.api_contract`, `design.schema`, `design.architecture`, `design.ui_mockup` |
| Research | `research.web`, `research.deep_report`, `research.market_chatter` (live social, e.g. X via Grok), `research.academic`, `research.fact_check` |
| Writing | `write.doc`, `write.marketing_copy`, `write.email`, `write.summary`, `write.translation_indic` |
| Data | `data.analysis`, `data.extraction`, `data.sql` |
| Media | `media.image`, `media.video`, `media.voice`, `media.music` |
| Browser | `browser.task`, `browser.form_fill`, `browser.scrape_public` |
| Meta | `plan.decompose`, `judge.pairwise`, `review.rubric`, `merge.integrate` |

## 2. Planner

Input: mission goal, attachments, project memory brief, available agents (from workspace connectors), budget, policies.
Output (Zod `PlanProposal`): tasks with `key`, `type`, `title`, `contract`, `depends_on`, `suggested_mode`, `estimate`, plus `assumptions[]` and `questions[]` (≤3, only blocking).

Implementation:
1. **Decompose** with a strong planner model (configurable; default the workspace's best `plan.decompose` scorer). Structured output against the schema; retry with validator errors on failure.
2. **Contract-first pass**: detect shared interfaces (API between frontend/backend, DB schema, shared component props, file formats). Insert `design.api_contract` / `design.schema` tasks that all dependants depend on.
3. **Lease inference**: for code tasks, predict resource footprint (paths/globs/symbols) from repo map + memory; store on contract as `expectedFootprint`. Two parallel tasks with overlapping footprints get either a dependency edge or a split.
4. **Estimate** cost/time per task from scoreboard averages for (type, candidate agents) × size heuristic.
5. **Lint the plan**: no cycles, every task has acceptance checks, every leaf contributes to the mission goal, budget fits (or flag).

### TaskContract (summary; full Zod in `packages/schema`)
```ts
{
  objective: string;
  inputs: { kind: "file"|"artifact"|"contract"|"text"|"url"; ref: string }[];
  outputs: { kind: "diff"|"file"|"doc"|"image"|"video"|"audio"|"dataset"|"report"|"url"; description: string; path?: string }[];
  acceptance: AcceptanceCheck[];      // see §4
  constraints: string[];              // style, libraries, "do not touch X"
  expectedFootprint?: { paths: string[]; symbols?: string[] };
  sensitivity: "public"|"internal"|"confidential";   // drives data-routing policy
  budget?: { usd?: number; minutes?: number };
}
```

## 3. Router

Input: task, candidate agents (filtered by capability for `type`, policy allow-list for `sensitivity`, health, budget), scoreboard, user pins.
Output: `RouteDecision { mode, agents: {agentId, role}[], rationale: string, estUsd, estMinutes }`.

### 3.1 Scoring candidates
For each candidate agent *a* and task type *t*:
- Quality posterior `Beta(α, β)` from verification outcomes (pass = α+1, fail/revise = β+1; revise counts 0.5).
- Pairwise strength `elo[a,t]` from best-of-N and debate judgments.
- Cost `c[a,t]` (EMA of USD per attempt), latency `l[a,t]` (p50 seconds).

Selection (Thompson sampling with a cost-aware utility):
```
sample q ~ Beta(α, β)
utility = q + λ_elo * norm(elo) - λ_cost * norm(c) - λ_time * norm(l)
```
λ values come from the mission's priority setting: `quality` (λ_cost 0.05), `balanced` (0.2), `cheap` (0.5), `fast` (λ_time 0.5). Cold start: priors from global scoreboard (opt-in data) or registry `defaultPrior`, else Beta(1,1).
Always log the rationale: "Codex chosen: 0.82 pass rate on code.tests (n=41), $0.31 avg, beats Claude Code on cost at similar quality."

### 3.2 Mode selection (default rules; user/planner can override)
| Condition | Mode |
|---|---|
| `design.*`, `plan.*`, high-stakes contract | `debate` (2 vendors propose, judge picks + merges) |
| `code.*` with tests available, budget allows | `best_of_n` (n=2–3, different vendors), tests decide, judge breaks ties |
| `code.*` without tests | `maker_checker` (maker from one vendor, reviewer from another) |
| `research.deep_report` | `ensemble` (2–3 researchers, merger agent dedupes and reconciles with citations) |
| `write.*`, `media.*` | `single` + rubric review; `best_of_n` for hero assets |
| cheap/utility types (`write.summary`, `data.extraction`) | `cascade` (cheap model → escalate on failed check) |
| user-defined template | `pipeline` |

Diversity rule: in multi-agent modes, prefer agents from **different vendors** (errors correlate less).

## 4. Verifier

Runs after every attempt; produces `reviews` rows and a verdict.

### 4.1 Acceptance check kinds
| Kind | How |
|---|---|
| `tests` | run command in sandbox (`pnpm test -- <scope>`); pass = exit 0; parse counts |
| `typecheck`, `lint`, `build` | run commands; pass = exit 0 |
| `contract_conformance` | validate output against contract spec (OpenAPI diff, TS type check against contract types, JSON Schema) |
| `diff_scope` | changed files ⊆ lease footprint (+ allowed extras); flags out-of-scope edits |
| `rubric_review` | different-vendor model reviews artifact against objective + constraints, returns scores 1–5 per criterion + verdict |
| `fact_check` | extract claims; verify each against cited sources (fetch); unsupported claims fail |
| `citation_present` | every factual paragraph has a source |
| `media_spec` | dimensions/duration/format; optional vision-model check against brief |
| `link_check`, `a11y`, `lighthouse` | for web outputs |
| `human` | approval gate |

### 4.2 Verdict logic
- Any hard check fails → `revise` (attempt ≤2) with the failures fed back to the same agent; third failure → reroute to next-best agent; then `failed` → replan proposal.
- All hard checks pass and rubric ≥ threshold → `pass`.
- Rubric reviewer must be a different vendor than the maker (enforced).

### 4.3 Judge (best-of-N, debate)
Pairwise comparison, randomized order, both orders evaluated to cancel position bias; tests outrank judge opinion; judge model ≠ any candidate's vendor where possible. Record winner/loser pairs → Elo update per task type.

## 5. Scoreboard updates
On every verdict: update `scores` (α/β, Elo, cost EMA, latency EMA, n). On user ratings: thumbs up = +0.5 α, down = +1 β. Scores decay slowly (half-life 60 days) so new model versions can climb. Each (connector, model) pair is its own `agent_key`; when a vendor ships a new model, it starts from the old model's prior scaled to weight 5.

## 6. Coordination rules (enforced by core)
- **Leases**: acquired at `leased` state for the task's footprint; heartbeat every 30 s; expire at 2 min without heartbeat; renewed for the whole task (not per edit). Overlap → task stays `blocked` or planner splits. Out-of-footprint writes are denied by hooks for CLI agents and flagged by `diff_scope` for all.
- **Contracts**: dependants receive the contract in `.brio/contract.json`; any change to a published contract bumps its version, emits `contract.changed`, and marks dependants not yet verified as `revise`.
- **Mailbox**: `ask_agent` to a running task is delivered to that attempt (CLI agents via MCP tool polling; API agents via injected message on next turn). Unanswered after 5 min → planner answers from memory/contract or escalates to user.

## 7. Eval harness (`apps/evals`)
- **Golden missions**: 30 at launch across groups — e.g. "Add OAuth login + tests to sample Next.js app", "Write a 1,500-word cited market report on Indian EV two-wheelers", "Build a landing page + hero image + 30-s voiceover", "Fix 5 seeded bugs in a Python repo", "Translate and localise product copy to Hindi and Marathi".
- Each mission has automatic scoring (tests, rubric with a fixed judge, fact checks) and cost/time capture.
- Baselines: best single agent per mission (Claude Code alone, Codex alone, …) vs Brio (static routing) vs Brio (learned routing).
- Runs nightly; results feed the PRD success metrics dashboard and global priors.
