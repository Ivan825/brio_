# Security review (M10)

24 Oct 2026. Covers the API (`apps/api`), the runners (`apps/runner`, cloud and local), the adapters and their network layer (`packages/adapters`), governance (`packages/governance`), and the self-host bundles (`deploy/`).

**Result:** no high or critical findings open. Every finding below was fixed, and a test proves each fix. The residuals at the end are accepted, each with its reason.

## Threat model

**What we protect, most valuable first:**
1. The vendor keys people bring (BYOK).
2. People's machines that run a local runner, which may be in host mode.
3. Each workspace's data: missions, code, results, memory.
4. Money: budgets, and Mandate holds.
5. The integrity of the audit ledger.
6. The cloud host and its network.

**Who might attack:**

| Actor | Can | Must not be able to |
|---|---|---|
| Someone on the internet | Reach the web app, `/api/auth`, the A2A card | Read or change anything; exhaust the service; reach internal networks through Brio |
| A member of another workspace | Everything in their own workspace | See or affect yours; set prices or scores everyone shares |
| A member of your workspace | Missions, agents, plans, approvals (by role) | Run anything on a colleague's machine; go around role rules; keep access after removal |
| A hostile agent, or content it reads (a web page, an issue, a dependency) | Write files in its sandbox, call allow-listed hosts, write text | Escape the sandbox; reach the host, other attempts, metadata or private networks; instruct the agents and reviewers that read its output; make itself look approved |
| A compromised local runner | Report on attempts it holds | Write events, results or spend for work it does not hold; forge approvals; act after being revoked |
| Someone with write access to Brio's database | — | Treated as owning the installation; out of scope except for ledger tamper evidence (below) |

**Trust boundaries:**
1. Browser ↔ web app and API.
2. API tokens and OAuth clients ↔ API.
3. API ↔ vendors and user-supplied URLs.
4. API ↔ runners (queue, WebSocket).
5. Runner ↔ sandbox (container, egress proxy).
6. Agent output ↔ the next prompt.

## Method

1. **Two code reviews of the whole attack surface**, each finding traced end to end:
   - authorization on every route, MCP tool and A2A method;
   - server-side request forgery (SSRF);
   - secret flow;
   - inbound signatures;
   - the runner protocol;
   - injection (SQL, shell);
   - CSRF, CORS and cookies.

   The first review found the original findings. The second checked every fix, found the follow-up findings, and those were fixed too.
2. **A sandbox escape suite** run against real containers (`apps/runner/test/sandbox-escape.test.ts`):
   - reaching the host's Docker;
   - gaining privileges (capabilities, setuid, no-new-privileges, seccomp);
   - kernel interfaces (mount, user namespaces, `/proc/sys`, `/sys`, hostname);
   - the process namespace;
   - exhaustion (fork bomb, memory hog, `/tmp`);
   - exfiltration (DNS, direct routes, private ranges, cloud metadata in IPv4 and IPv6 forms, off-allowlist hosts, the environment).
3. **A prompt-injection suite** (`packages/core/test/untrusted.test.ts`, `apps/api/test/injection.test.ts`): fence break-out as a property test over 2,000 generated inputs, an attack corpus, a benign corpus, and the end-to-end hold of a hostile result.
4. **Dependency audit:** `pnpm audit`.
5. **The self-host bundles, checked by running them:**
   - Compose: brought up and driven end to end.
   - Helm: rendered and validated, and its runner pod reproduced with Docker-in-Docker.
   - Both: the Docker engine listens only on loopback, and the egress proxy refuses private destinations even when they are allow-listed.

## Findings

| # | Severity | Finding | Fix | Test |
|---|---|---|---|---|
| H1 | High | One workspace could set the shared price table: a connector with an editable base URL served a model list with prices of its choosing | Prices from a model list are trusted only from the vendor's own address in the registry (D-103); viewers cannot trigger live listing | `price-integrity.test.ts` |
| H2 | High | Other members could run commands on a person's machine through a project on their local runner | Work runs there only for the owner's missions, on plan versions they approved, started by them (D-101) | `local-runner.test.ts` |
| N1 | High | A member could change the agent bound to someone's runner (its role prompt, options) and so steer that person's next run | Only the runner's owner changes or removes agents bound to it | `local-runner.test.ts` |
| N2 | High | A replan by a member, auto-approved, counted as the owner's approval | On runner projects only the owner edits, replans or approves plans; a quick start approves only the owner's own first version | `local-runner.test.ts` |
| H3 | Medium–high | A2A did not check membership or role; removed members kept their tokens | A2A requires a current member who may act; removal revokes the person's API tokens and local runners there | `roles.test.ts` |
| M-a | Medium | Any member could approve a push from the owner's machine, which would use the owner's git access | On runner projects only the owner decides deliveries | `local-runner.test.ts` |
| M-b | Medium | Members' review reasons and memory entries reached the owner's agents | On runner projects only the owner reviews or adds memory; both are fenced everywhere | `local-runner.test.ts` |
| M-c | Medium | Some untrusted text entered prompts unfenced, or in a fixed fence its content could close | Every such input goes through `fence`/`untrustedBlock` (D-104) | `untrusted.test.ts` |
| M1 | Medium | Admins could go around Brio's role rules, and the ledger, through Better Auth's own workspace endpoints | Those endpoints are closed; Brio's routes keep the rules | `roles.test.ts` |
| M-d | Medium | An admin could make admins by invitation | Only owners invite admins | `roles.test.ts` |
| M2 | Medium | The URL guard missed IPv6 disguises (`::`, the hex mapped form, NAT64, 6to4), could be beaten by DNS rebinding, and git followed redirects | Embedded IPv4 is judged as itself; connections are pinned to addresses checked in their own lookup (D-102); git follows no redirects; more reserved ranges refused | `net.test.ts` |
| M3 | Medium | A local runner could post any event (fake approval requests, a mission done) as anyone | Runners report only their attempts' own events, as the agent | `local-runner.test.ts` |
| M-e | Medium | With database access, a pre-chained row could jam a workspace's ledger, and one bad workspace stopped chaining for all | Rows can only be written pending; seq, prev_hash and hash are set together; chaining carries on per workspace | `ledger-db.test.ts` |
| — | Medium | Results could address the agents reading them (reviewers, judges, the next task) | Every result is scanned; findings hold it for a person (D-104) | `injection.test.ts` |
| L1 | Low | Runner socket accepted large frames before authentication; revocation was not seen by other API instances; X-Forwarded-For was trusted from anyone; GitHub owner/name accepted `..`; no general rate limit, then an exemption that a query string could fake; runners could lower reported spend or send arbitrary check states | Token checked in the WebSocket handshake; revocation re-checked before handing out work; only the nearest `BRIO_TRUST_PROXY_HOPS` proxies believed; dot segments refused; a per-address limit exempting only the health check, event streams and runner sockets, by path; spend only grows, check states validated | `local-runner.test.ts`, `rate-limit.test.ts`, `deliver.test.ts` |
| — | Low | A stale container left by a runner that died blocked the next sandbox with the same name | Stale same-named sandboxes are removed first | `sandbox.test.ts` |

**Found sound in both reviews:**
- workspace scoping on every REST route and MCP tool;
- API tokens pinned to their workspace and unable to decide approvals;
- the consented `brio:approve` scope for MCP;
- Slack and hosted-agent webhook signatures (raw body, time window, constant-time comparison);
- secrets kept as vault references in responses, dispatches and events, and redacted in logs;
- no string-built SQL from input;
- shell commands only inside sandboxes;
- CORS limited to `APP_URL`;
- cookies HttpOnly and SameSite=Lax;
- artifacts served inert;
- Mandate tokens kept in the vault, with its URL guarded;
- in the worker role, only `/health` exposed.

## Accepted residuals

- **Ledger tamper evidence assumes the database is not rewritten wholesale.**
  - Hashes are plain SHA-256 (Mandate-compatible). Someone who can rewrite every row can recompute a consistent chain.
  - Owners should keep exported chain heads (Governance → Ledger → Export) somewhere else.
  - Signed external anchors are the next step (SECURITY_GOVERNANCE §8).
- **`BRIO_TRUST_PROXY_HOPS` defaults to 1** (Caddy, an ingress, or the web app in front). An API exposed directly must set it to 0, or clients choose their own address for rate limits. Documented in SELF_HOST.md.
- **Plan approval through MCP or A2A approves the latest proposed version.** On runner projects only the owner can edit plans, so no one can swap a version under them. Elsewhere, a member editing a plan just before another member approves it is a collaboration hazard, not an escalation: both may act.
- **Runner event payloads can be up to 128 MB.** Only authenticated runners, reporting on their own attempts, can send them.
- **Two moderate dependency advisories, both build-time only:**
  - `esbuild` through `drizzle-kit`: concerns esbuild's dev server, which Brio never runs.
  - `postcss-selector-parser` through Tailwind 3: quadratic parsing of our own CSS. The fix is a major version Tailwind 3 cannot use.

  Neither is reachable at run time. No high or critical advisories.
- **A local runner in host mode** runs agents as the person, without a container, by their explicit consent (D-87). Everything it does is recorded, and only its owner can send it work.
