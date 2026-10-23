# Security, Governance and Vendor Terms

## 1. Vendor access policy (hard rules)

Brio only reaches AI vendors through channels they publish for programmatic use.

| Allowed | Not allowed |
|---|---|
| Official APIs with the user's own keys (BYOK) or Brio's platform keys | Driving consumer chat web apps (chatgpt.com, claude.ai, gemini.google.com, grok.com, perplexity.ai) |
| Official CLIs invoked with their documented headless flags | Reading or reusing OAuth/session tokens stored by any CLI or app (e.g. Antigravity's token file, Claude/Codex login stores) |
| Official SDKs (Claude Agent SDK, Codex SDK, Antigravity SDK, OpenAI Agents SDK, Nova Act) | Unofficial proxies for Midjourney, Suno, Udio, or any "reverse-engineered API" |
| Hosted agent APIs (Claude Managed Agents, OpenAI Agents API, Jules, Devin, Manus, Gemini Managed Agents) | Offering "log in with your ChatGPT/Claude subscription" inside Brio unless the vendor explicitly permits third-party use |
| A2A agents and MCP servers the user adds | Bypassing CAPTCHAs or bot detection in browser agents |

Subscription-backed use (e.g. a user's Claude Max or ChatGPT Pro) is only possible in the **local runner**, where the user runs the vendor's own CLI under their own login on their own machine. Before enabling each vendor in local-runner subscription mode, check the vendor's current terms and record the result in `registry/connectors.json` (`subscriptionUse` field). Known as of 23 Oct 2026:
- Anthropic: claude.ai login / subscription rate limits are not allowed for third-party agents; Agent SDK and `claude -p` subscription usage draws from a separate monthly Agent SDK credit. → Default to API keys; treat subscription mode as "user's own use only", off by default.
- Google Antigravity: reusing CLI login tokens in other software is forbidden; launching the official `agy` binary headless is the allowed path. Antigravity SDK requires an API key or Vertex (billed).
- OpenAI Codex: Codex Cloud requires a ChatGPT plan; API-key sessions run locally only.
- Meta Model API: public preview, US developers only.

## 2. Secrets (BYOK vault)
- Envelope encryption: per-secret data key (XChaCha20-Poly1305 via libsodium), wrapped by a KEK from a KMS (cloud: AWS KMS/GCP KMS; self-host: a master key file or env, rotatable).
- Secrets decrypted only inside the runner process for the attempt, held in memory, passed to the vendor via env or header, zeroed after.
- Redaction: every logger and event writer runs a redactor (known secret values + patterns: `sk-`, `xai-`, bearer tokens, AWS keys). Contract test asserts no secret leaks.
- Secrets never placed in prompts, handoff packets, memory, or artifacts. If an agent output contains a secret pattern, the artifact is quarantined.

## 3. Sandboxing
- One container per attempt; non-root; read-only base image; writable worktree + tmp only.
- Egress allowlist per sandbox profile + per agent vendor host; default deny.
- Resource limits (CPU, memory, disk, PIDs, wall-clock).
- No Docker socket, no host mounts beyond the worktree.
- Future: Firecracker/gVisor for stronger isolation in hosted multi-tenant mode.

## 4. Data-routing policies
- Each task carries `sensitivity` (public | internal | confidential).
- Workspace policy maps sensitivity → allowed connectors (e.g. confidential → only enterprise endpoints with ZDR, or local models).
- Claude Managed Agents is not ZDR/HIPAA eligible yet → excluded from `confidential` by default.
- Router filters candidates by policy before scoring; violations are impossible, not merely warned.

## 5. Budgets
- Budget scopes: workspace (monthly), mission, task, agent.
- Pre-dispatch: estimate must fit remaining budget at every scope, else task → `blocked` with `budget.stop`.
- Live: runner streams cost events; at soft threshold (default 80%) emit `budget.warn`; at 100% abort attempt with `limit_exceeded`.
- All spend recorded in ledger.

## 6. Approvals
Default policy (editable):
| Action | Default |
|---|---|
| Approve plan | required if est. cost > $5 or > 10 tasks |
| Push branch / open PR | required |
| Deploy, publish, send email/message, purchase | required, per action |
| Browser agent visiting a new domain | required (OpenAI Agents API `requires_action` routes here) |
| Delete files outside task footprint | always denied |
| Spend over mission budget | required |
Approvals are requested in-app, by email/Slack/push, and via the Brio MCP tool for users working inside an agent.

## 7. Mandate integration
Mandate (the owner's existing product: scoped, revocable spending authority for agents, hash-chained ledger, approvals inbox, API-key proxy with metering) is the reference design for `packages/governance`.
- Option A (default): `packages/governance` implements budgets/approvals/ledger natively with Mandate-compatible schemas, so a workspace can later connect Mandate.
- Option B: delegate spend authority and API-key proxying to a Mandate instance via its API/MCP server.
Decide in `docs/DECISIONS.md` (D-07). Either way the ledger format stays Mandate-compatible.

## 8. Audit ledger
- Append-only table with `seq`, `prev_hash`, `hash = sha256(prev_hash || canonical_json(payload))`.
- DB trigger blocks UPDATE/DELETE.
- Periodic anchor: daily root hash written to an external store (configurable).
- Ledger entries: dispatch, spend, approval decision, external side effect, policy change, key added/rotated.

## 9. Prompt-injection defence
- Treat all agent outputs, fetched pages, repo files and A2A responses as data. Agents never receive instructions from another agent's output as system-level text; handoff packets are wrapped and labelled as untrusted content.
- Tool permissions are least-privilege per task; browser and messaging actions go through approvals.
- The verifier flags outputs containing instructions aimed at other agents ("ignore previous…").

## 10. Compliance posture (later milestones)
SOC 2 controls mapping, data residency options (EU via Mistral/Bedrock EU/Foundry EU), DPA templates, SSO/SAML, SCIM.
