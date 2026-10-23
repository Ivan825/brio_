// The hosted-agent contract (ADAPTER_SPEC §4) for every hosted adapter, against fakes built from each vendor's
// documented wire format (docs/vendors/hosted-agents.md): key check, a run to completion with messages, cost and
// outputs, a patch applied to the worktree, approvals (yes, and no answer = declined), cancel, the cost limit, and the
// key never leaking into what the run emits.
import { registry } from "@brio/registry";
import { describe, expect, it } from "vitest";
import { ADAPTERS } from "../src/index";
import type { AdapterEvent, AgentAdapter, AgentConfig, RunContext, RunInput } from "../src/types";
import { helloInput, secret } from "./contract";
import { bytesResponse, FakeService } from "./service-fakes";

// Built at runtime so no key-shaped literal sits in the repository.
const KEY = ["hosted", "key", "0123456789abcdefghijklmnop"].join("-");
const PATCH =
  "diff --git a/x.txt b/x.txt\nnew file mode 100644\n--- /dev/null\n+++ b/x.txt\n@@ -0,0 +1 @@\n+hi\n";
const AWS = JSON.stringify({ accessKeyId: "AKIDEXAMPLE", secretAccessKey: KEY });
const ENTRA = JSON.stringify({ tenantId: "t1", clientId: "c1", clientSecret: KEY });

type Script = "done" | "approval" | "forever" | "costly";

interface VendorCase {
  service: string;
  model: string;
  settings?: Record<string, string>;
  credential?: string;
  /** Header that carries the credential (a function of the request, for signed schemes). */
  authed: (h: Record<string, string>) => boolean;
  /** Installs the vendor's routes for a script; returns nothing (the fake records everything). */
  install: (f: FakeService, script: Script) => void;
  approvals: boolean;
  /** The request that answers an approval (to assert it was sent with the right decision). */
  approvalCall?: { method: string; path: RegExp; approved: (body: unknown) => boolean };
  cancelCall?: { method: string; path: RegExp };
  patch: boolean;
  files: boolean;
  /** The vendor reports cost (or tokens priced by the agent): the limit test applies. */
  costs: boolean;
  text: string;
}

const sessionEvents = (script: Script, n: number) => {
  const base = [{ id: "e1", type: "agent.message", content: [{ type: "text", text: "Hello from Claude" }] }];
  if (script === "approval" && n < 2)
    return [
      ...base,
      { id: "t1", type: "agent.tool_use", name: "bash", input: { command: "rm -rf build" } },
      { id: "i1", type: "session.status_idle", stop_reason: { type: "requires_action", event_ids: ["t1"] } },
    ];
  if (script === "forever") return base;
  if (script === "costly")
    return [
      ...base,
      {
        id: `u${n}`,
        type: "session.usage",
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          list_cost: { amount: String(50 * (n + 1)), currency: "USD" },
        },
      },
    ];
  return [
    ...base,
    {
      id: "u1",
      type: "session.usage",
      usage: { input_tokens: 1000, output_tokens: 200, list_cost: { amount: "12", currency: "USD" } },
    },
    { id: "i2", type: "session.status_idle", stop_reason: { type: "end_turn" } },
  ];
};

const CASES: VendorCase[] = [
  {
    service: "claude-managed-agents",
    model: "claude-model",
    authed: (h) => h["x-api-key"] === KEY && h["anthropic-beta"] === "managed-agents-2026-04-01",
    install(f, script) {
      f.on("GET", /^\/v1\/agents/, () => ({ data: [] }))
        .on("POST", /^\/v1\/agents$/, () => ({ id: "agent_1" }))
        .on("GET", /^\/v1\/environments/, () => ({ data: [{ id: "env_1", name: "brio" }] }))
        .on("POST", /^\/v1\/sessions$/, () => ({ id: "sesn_1" }))
        .on("GET", /^\/v1\/sessions\/sesn_1\/events/, (_r, n) => ({ data: sessionEvents(script, n) }))
        .on("POST", /^\/v1\/sessions\/sesn_1\/events/, () => ({}))
        .on("GET", /^\/v1\/files\?/, () => ({
          data: [
            { id: "f1", filename: "changes.patch" },
            { id: "f2", filename: "chart.png", mime_type: "image/png" },
          ],
        }))
        .on("GET", /^\/v1\/files\/f1\/content/, () => bytesResponse(PATCH))
        .on("GET", /^\/v1\/files\/f2\/content/, () => bytesResponse("PNG", "image/png"));
    },
    approvals: true,
    approvalCall: {
      method: "POST",
      path: /\/sessions\/sesn_1\/events/,
      approved: (b) => JSON.stringify(b).includes('"result":"allow"'),
    },
    cancelCall: { method: "POST", path: /\/sessions\/sesn_1\/events/ },
    patch: true,
    files: true,
    costs: true,
    text: "Hello from Claude",
  },
  {
    service: "openai-agents",
    model: "gpt-agent",
    authed: (h) => h.authorization === `Bearer ${KEY}` && h["openai-beta"] === "agents=v1",
    install(f, script) {
      let answered = false;
      f.on("POST", /^\/v1\/agents\/sessions$/, () => ({ id: "sess_1", status: "in_progress" }))
        .on("GET", /^\/v1\/agents\/sessions\/sess_1$/, (_r, n) => {
          const usage = {
            input_tokens: 1000,
            output_tokens: script === "costly" ? 10_000_000 * (n + 1) : 200,
          };
          if (script === "approval" && !answered)
            return {
              id: "sess_1",
              status: "requires_action",
              required_actions: [
                {
                  type: "computer_use_approval_request",
                  request_id: "REQ",
                  request: { type: "browser_origin_access", origin: "https://example.com" },
                },
              ],
              usage,
            };
          if (script === "forever" || script === "costly" || n === 0)
            return { id: "sess_1", status: "in_progress", usage };
          return { id: "sess_1", status: "idle", usage };
        })
        .on("GET", /^\/v1\/agents\/sessions\/sess_1\/items/, () => ({
          data: [
            {
              id: "it1",
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "Hello from OpenAI" }],
            },
          ],
        }))
        .on("GET", /^\/v1\/agents\/sessions\/sess_1\/turns/, () => ({
          data: [{ status: "completed", subagent_id: null }],
        }))
        .on("POST", /^\/v1\/agents\/sessions\/sess_1\/events/, (r) => {
          if (JSON.stringify(r.body).includes("approval_request_result")) answered = true;
          return {};
        })
        .on("GET", /^\/v1\/agents\/sessions\/sess_1\/artifacts\?/, () => ({
          data: [
            { id: "a1", path: "/workspace/outputs/changes.patch" },
            { id: "a2", path: "/workspace/outputs/report.pdf", mime_type: "application/pdf" },
          ],
        }))
        .on("GET", /^\/v1\/agents\/sessions\/sess_1\/artifacts\/a1\/content/, () => bytesResponse(PATCH))
        .on("GET", /^\/v1\/agents\/sessions\/sess_1\/artifacts\/a2\/content/, () =>
          bytesResponse("%PDF", "application/pdf"),
        );
    },
    approvals: true,
    approvalCall: {
      method: "POST",
      path: /\/sessions\/sess_1\/events/,
      approved: (b) => JSON.stringify(b).includes('"decision":"approve"'),
    },
    cancelCall: { method: "POST", path: /\/sessions\/sess_1\/events/ },
    patch: true,
    files: true,
    costs: true,
    text: "Hello from OpenAI",
  },
  {
    service: "gemini-managed-agents",
    model: "antigravity-preview",
    authed: (h) => h["x-goog-api-key"] === KEY,
    install(f, script) {
      f.on("POST", /^\/v1beta\/interactions$/, (r) => ({
        id: (r.body as { previous_interaction_id?: string }).previous_interaction_id ? "int_2" : "int_1",
        environment_id: "env1",
        status: "in_progress",
      }))
        .on("GET", /^\/v1beta\/interactions\/int_\d$/, (r, n) => {
          const usage = { total_input_tokens: script === "costly" ? 1e9 : 900, total_output_tokens: 100 };
          if (script === "approval" && r.path.endsWith("int_1"))
            return { id: "int_1", status: "requires_action", output_text: "Which branch?", usage };
          if (script === "forever" || script === "costly" || n === 0)
            return { id: "int_1", status: "in_progress", output_text: "Hello from Gemini", usage };
          return {
            id: "int_1",
            status: "completed",
            output_text: "Hello from Gemini",
            usage,
            environment_id: "env1",
          };
        })
        .on("POST", /\/interactions\/int_1(\/|:)cancel/, () => ({}))
        .on("GET", /^\/v1beta\/environments\/env1\/files\?/, () => ({
          files: [{ path: "outputs/changes.patch" }, { path: "outputs/plot.png", mime_type: "image/png" }],
        }))
        .on("GET", /^\/v1beta\/environments\/env1\/files\/outputs\/changes\.patch/, () =>
          bytesResponse(PATCH),
        )
        .on("GET", /^\/v1beta\/environments\/env1\/files\/outputs\/plot\.png/, () =>
          bytesResponse("PNG", "image/png"),
        );
    },
    approvals: false,
    cancelCall: { method: "POST", path: /\/interactions\/int_1(\/|:)cancel/ },
    patch: true,
    files: true,
    costs: true,
    text: "Hello from Gemini",
  },
  {
    service: "jules",
    model: "jules",
    settings: { source: "sources/github-acme-app" },
    authed: (h) => h["x-goog-api-key"] === KEY,
    install(f, script) {
      let approved = false;
      f.on("POST", /^\/v1alpha\/sessions$/, () => ({ name: "sessions/s1", id: "s1", state: "QUEUED" }))
        .on("GET", /^\/v1alpha\/sessions\/s1$/, (_r, n) => {
          if (script === "approval" && !approved) return { id: "s1", state: "AWAITING_PLAN_APPROVAL" };
          if (script === "forever" || n === 0) return { id: "s1", state: "IN_PROGRESS" };
          return {
            id: "s1",
            state: "COMPLETED",
            outputs: [{ pullRequest: { url: "https://github.com/acme/app/pull/7" } }],
          };
        })
        .on("GET", /^\/v1alpha\/sessions\/s1\/activities/, () => ({
          activities: [
            { id: "a1", planGenerated: { plan: { steps: [{ title: "Edit x" }] } } },
            { id: "a2", agentMessaged: { agentMessage: "Hello from Jules" } },
            { id: "a3", artifacts: [{ changeSet: { gitPatch: { unidiffPatch: PATCH } } }] },
          ],
        }))
        .on("POST", /^\/v1alpha\/sessions\/s1:approvePlan/, () => {
          approved = true;
          return {};
        })
        .on("POST", /^\/v1alpha\/sessions\/s1:sendMessage/, () => ({}));
    },
    approvals: true,
    approvalCall: { method: "POST", path: /:approvePlan/, approved: () => true },
    patch: true,
    files: false,
    costs: false,
    text: "Hello from Jules",
  },
  {
    service: "devin",
    model: "devin",
    settings: { orgId: "org-acme" },
    authed: (h) => h.authorization === `Bearer ${KEY}`,
    install(f, script) {
      f.on("POST", /^\/v3\/organizations\/org-acme\/sessions$/, () => ({
        session_id: "devin-abc",
        status: "new",
      }))
        .on("GET", /^\/v3\/organizations\/org-acme\/sessions\/devin-abc$/, (_r, n) => ({
          status: script === "forever" || script === "costly" || n === 0 ? "running" : "exit",
          status_detail: "working",
          acus_consumed: script === "costly" ? 100 * (n + 1) : 1.5,
          pull_requests: [{ pr_url: "https://github.com/acme/app/pull/9" }],
        }))
        .on("GET", /\/sessions\/devin-abc\/messages/, () => ({
          items: [{ event_id: "m1", source: "devin", message: "Hello from Devin" }],
          end_cursor: "c1",
        }))
        .on("GET", /\/sessions\/devin-abc\/attachments/, () => ({
          items: [{ name: "changes.patch", url: "https://files.devin.ai/p" }],
        }))
        .on("GET", /^\/p$/, () => bytesResponse(PATCH))
        .on("DELETE", /\/sessions\/devin-abc/, () => ({}));
    },
    approvals: false,
    cancelCall: { method: "DELETE", path: /\/sessions\/devin-abc/ },
    patch: true,
    files: false,
    costs: true,
    text: "Hello from Devin",
  },
  {
    service: "manus",
    model: "standard",
    authed: (h) => h["x-manus-api-key"] === KEY,
    install(f, script) {
      let confirmed = false;
      f.on("POST", /^\/v2\/task\.create$/, () => ({ ok: true, task_id: "t1" }))
        .on("GET", /^\/v2\/task\.detail/, (_r, n) => {
          if (script === "approval" && !confirmed)
            return {
              task: {
                status: "waiting",
                status_detail: { waiting_for_event_type: "deployAction", waiting_for_event_id: "ev1" },
                credit_usage: 3,
              },
            };
          if (script === "forever" || script === "costly" || n === 0)
            return { task: { status: "running", credit_usage: script === "costly" ? 1000 * (n + 1) : 3 } };
          return { task: { status: "stopped", credit_usage: 7, has_running_background_jobs: false } };
        })
        .on("GET", /^\/v2\/task\.listMessages/, () => ({
          messages: [{ type: "assistant_message", content: "Hello from Manus" }],
        }))
        .on("POST", /^\/v2\/task\.confirmAction/, () => {
          confirmed = true;
          return { ok: true };
        })
        .on("POST", /^\/v2\/task\.stop/, () => ({ ok: true }))
        .on("GET", /^\/v2\/artifact\.list/, () => ({
          artifacts: [
            { file_name: "slides.pdf", url: "https://cdn.manus.example/s", mime_type: "application/pdf" },
          ],
        }))
        .on("GET", /^\/s$/, () => bytesResponse("%PDF", "application/pdf"));
    },
    approvals: true,
    approvalCall: {
      method: "POST",
      path: /task\.confirmAction/,
      approved: (b) => (b as { input: { accept: boolean } }).input.accept === true,
    },
    cancelCall: { method: "POST", path: /task\.stop/ },
    patch: false,
    files: true,
    costs: true,
    text: "Hello from Manus",
  },
  {
    service: "bedrock-agentcore",
    model: "my-agent",
    settings: {
      region: "us-east-1",
      runtimeArn: "arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/brio-agent",
    },
    credential: AWS,
    authed: (h) =>
      (h.authorization ?? "").startsWith("AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/") &&
      /bedrock-agentcore\/aws4_request/.test(h.authorization ?? ""),
    install(f) {
      f.on(
        "POST",
        /^\/runtimes\/arn%3Aaws%3Abedrock-agentcore/,
        () =>
          new Response(
            'data: {"event":{"contentBlockDelta":{"delta":{"text":"Hello from "}}}}\n\ndata: {"event":{"contentBlockDelta":{"delta":{"text":"AgentCore"}}}}\n\n',
            {
              headers: { "content-type": "text/event-stream" },
            },
          ),
      );
    },
    approvals: false,
    patch: false,
    files: false,
    costs: false,
    text: "Hello from AgentCore",
  },
  {
    service: "foundry-agents",
    model: "gpt-deployment",
    settings: { endpoint: "https://acme.services.ai.azure.com/api/projects/brio", agentName: "brio-coder" },
    credential: ENTRA,
    authed: (h) => h.authorization === "Bearer entra-token",
    install(f, script) {
      let approvedRound = false;
      f.on("POST", /^\/t1\/oauth2\/v2\.0\/token$/, () => ({ access_token: "entra-token", expires_in: 3600 }))
        .on("POST", /^\/api\/projects\/brio\/openai\/v1\/responses$/, (r) => {
          if (JSON.stringify(r.body).includes("mcp_approval_response")) approvedRound = true;
          return { id: approvedRound ? "resp_2" : "resp_1", status: "queued" };
        })
        .on("GET", /^\/api\/projects\/brio\/openai\/v1\/responses\/resp_\d$/, (r, n) => {
          const usage = { input_tokens: script === "costly" ? 1e9 : 800, output_tokens: 100 };
          if (script === "approval" && r.path.endsWith("resp_1"))
            return {
              id: "resp_1",
              status: "completed",
              output: [
                {
                  type: "mcp_approval_request",
                  id: "apr_1",
                  server_label: "github",
                  name: "create_issue",
                  arguments: "{}",
                },
              ],
              usage,
            };
          if (script === "forever" || script === "costly" || n === 0)
            return { id: "resp_1", status: "in_progress", usage };
          return {
            id: "resp_1",
            status: "completed",
            output: [{ type: "message", content: [{ type: "output_text", text: "Hello from Foundry" }] }],
            usage,
          };
        })
        .on("POST", /\/responses\/resp_1\/cancel/, () => ({}));
    },
    approvals: true,
    approvalCall: {
      method: "POST",
      path: /\/openai\/v1\/responses$/,
      approved: (b) => JSON.stringify(b).includes('"approve":true'),
    },
    cancelCall: { method: "POST", path: /\/responses\/resp_1\/cancel/ },
    patch: false,
    files: false,
    costs: true,
    text: "Hello from Foundry",
  },
];

function setup(c: VendorCase, script: Script, opts: { reply?: string | null; maxCostUsd?: number } = {}) {
  const fake = new FakeService();
  c.install(fake, script);
  const sv = registry().service(c.service);
  if (!sv) throw new Error(`no service ${c.service}`);
  const config: AgentConfig = {
    agentId: "agent-1",
    name: "Hosted one",
    model: c.model,
    rolePrompt: "You are careful.",
    connector: {
      registryKey: sv.connector,
      serviceKey: c.service,
      service: sv,
      settings: c.settings ?? {},
      baseUrl: "",
    },
    price: { inputPerM: 1, outputPerM: 2, cachedInputPerM: null, cacheWritePerM: null },
    unitPrice: { unit: sv.pricing.unit, usd: 0.5 },
    options: { pollMs: 5 },
  };
  const events: AdapterEvent[] = [];
  const sandboxCalls: string[] = [];
  const asked: string[] = [];
  const controller = new AbortController();
  const ctx: RunContext = {
    credential: secret(c.credential ?? KEY),
    emit: (e) => events.push(e),
    signal: controller.signal,
    sandbox: {
      available: true,
      readFile: async () => "",
      writeFile: async (p) => void sandboxCalls.push(`write ${p}`),
      listFiles: async () => [],
      exec: async (cmd) => {
        sandboxCalls.push(cmd);
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      spawn: () => {
        throw new Error("no spawn");
      },
    },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    fetch: fake.fetch,
    tools: {
      mailbox: {
        askAgent: async () => "",
        askUser: async (q) => {
          asked.push(q);
          return opts.reply === undefined ? "yes" : opts.reply;
        },
        inbox: async () => [],
        answer: async () => {},
        reportBlocker: async () => {},
        requestReview: async () => {},
        reportProgress: async () => {},
        getContract: async () => "",
        getBrief: async () => "",
      },
    },
  };
  const input: RunInput = {
    ...helloInput(),
    repo: { url: "https://github.com/acme/app", branch: "main" },
    limits: { maxCostUsd: opts.maxCostUsd ?? 5, maxMinutes: 10, maxTurns: 10 },
  };
  const adapter = ADAPTERS[sv.adapter] as AgentAdapter;
  return { fake, config, ctx, events, sandboxCalls, asked, controller, input, adapter, sv };
}

/** Polling is fast in tests. */
const fast = <T>(p: Promise<T>) => p;

describe("hosted agents: the contract", () => {
  it("covers every hosted service in the registry", () => {
    const hosted = Object.entries(registry().services)
      .filter(([, s]) => s.kind === "hosted")
      .map(([k]) => k)
      .sort();
    expect(CASES.map((c) => c.service).sort()).toEqual(hosted);
    for (const k of hosted) expect(ADAPTERS[registry().service(k)!.adapter], k).toBeDefined();
  });

  for (const c of CASES) {
    describe(c.service, () => {
      it("checks the key for free (or says the first run will)", async () => {
        const s = setup(c, "done");
        const sv = s.sv;
        const health = new FakeService();
        if (sv.health)
          health.on(sv.health.method, /.*/, (r) =>
            c.authed(r.headers) ? { data: [] } : new Response("{}", { status: 401 }),
          );
        const good = await s.adapter.healthCheck(s.config.connector, { ...s.ctx, fetch: health.fetch });
        expect(good.ok).toBe(true);
        if (sv.health) {
          const bad = await s.adapter.healthCheck(s.config.connector, {
            ...s.ctx,
            fetch: health.fetch,
            credential: secret("wrong-key-value-0123456789"),
          });
          expect(bad).toMatchObject({ ok: false, code: "auth" });
        }
      });

      it("runs to completion: messages, cost, outputs, and the patch applied to the worktree", async () => {
        const s = setup(c, "done");
        const r = await fast(s.adapter.run(s.input, s.config, s.ctx));
        expect(r.status, r.error).toBe("completed");
        expect(r.output).toContain(c.text);
        expect(r.vendorRunId).toBeTruthy();
        // Every request carried the credential the vendor expects.
        for (const req of s.fake.requests.filter(
          (x) => !/^\/(p|s)$/.test(x.path) && !x.path.includes("oauth2"),
        ))
          expect(c.authed(req.headers), `${req.method} ${req.path}`).toBe(true);
        if (c.costs) expect(s.events.some((e) => e.kind === "cost")).toBe(true);
        if (c.patch)
          expect(s.sandboxCalls).toContain("git apply --whitespace=nowarn --recount .brio/job.patch");
        if (c.files) expect((r.files ?? []).length).toBeGreaterThan(0);
        // The key never appears in anything the run emits or returns.
        expect(JSON.stringify({ events: s.events, r: { ...r, files: undefined } })).not.toContain(KEY);
      });

      if (c.approvals) {
        it("puts an approval to a person; yes approves, and no answer declines", async () => {
          const yes = setup(c, "approval");
          const r = await yes.adapter.run(yes.input, yes.config, yes.ctx);
          expect(r.status, r.error).toBe("completed");
          expect(yes.asked).toHaveLength(1);
          const call = yes.fake
            .calls(c.approvalCall!.method, c.approvalCall!.path)
            .find((x) => c.approvalCall!.approved(x.body));
          expect(call, "the approval was sent").toBeDefined();
          const silent = setup(c, "approval", { reply: null });
          const r2 = await silent.adapter.run(silent.input, silent.config, silent.ctx);
          const approved = silent.fake
            .calls(c.approvalCall!.method, c.approvalCall!.path)
            .some((x) => c.approvalCall!.approved(x.body));
          expect(approved, "nothing was approved without an answer").toBe(false);
          expect(["completed", "failed"]).toContain(r2.status);
        });
      }

      if (c.cancelCall) {
        it("cancels at the vendor when the run is cancelled", async () => {
          const s = setup(c, "forever");
          setTimeout(() => s.controller.abort(), 50);
          const r = await s.adapter.run(s.input, s.config, s.ctx);
          expect(r.status).toBe("cancelled");
          expect(s.fake.calls(c.cancelCall!.method, c.cancelCall!.path).length).toBeGreaterThan(0);
        });
      }

      if (c.costs) {
        it("stops at the cost limit", async () => {
          const s = setup(c, "costly", { maxCostUsd: 0.5 });
          const r = await s.adapter.run(s.input, s.config, s.ctx);
          expect(r.status).toBe("limit_exceeded");
        });
      }
    });
  }
});
