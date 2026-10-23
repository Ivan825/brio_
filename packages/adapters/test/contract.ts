// The adapter contract suite (ADAPTER_SPEC §4). Every adapter must pass it against recorded fixtures: health check,
// estimate, the hello task, the tool loop, cancel mid-run, limit breach and credential redaction.
import type { ModelPrice, TokenUsage } from "@brio/core";
import { Redactor } from "@brio/vault";
import { describe, expect, it } from "vitest";
import { LimitExceeded } from "../src/errors";
import { redactingLogger } from "../src/logger";
import { NO_SANDBOX } from "../src/tools";
import type {
  AdapterEvent,
  AgentAdapter,
  AgentConfig,
  ConnectorConfig,
  Mailbox,
  RunContext,
  RunInput,
  SecretHandle,
} from "../src/types";
import { FakeVendor } from "./fake-vendor";

export interface ContractFixtures {
  /** Model-list pages, in order. */
  models: unknown[];
  hello: unknown;
  toolCall: unknown;
  afterTool: unknown;
}

export interface ContractSpec {
  name: string;
  adapter: AgentAdapter;
  connector: ConnectorConfig;
  model: string;
  price: ModelPrice | null;
  fixtures: ContractFixtures;
  /** Normalised usage of the hello fixture. */
  helloUsage: TokenUsage;
  helloText: string;
  /** Number of chat models in the fixture list (non-chat models are filtered out). */
  modelCount: number;
  generationPath: RegExp;
  /** Header that must carry the credential, with the expected value given the key. */
  authHeader: (key: string) => [string, string] | null;
}

// Built at runtime so no key-shaped literal sits in the repository.
export const FAKE_KEY = ["sk", "contract", "0123456789abcdefghijklmnop"].join("-");

export const secret = (value = FAKE_KEY): SecretHandle => ({ reveal: () => value });

export const helloInput = (over: Partial<RunInput> = {}): RunInput => ({
  attemptId: "0192b3c4-5d6e-7f80-9a1b-2c3d4e5f6a7b",
  taskTitle: "Say hello",
  taskType: "write.summary",
  instructions: "Say hello and restate the goal: add a health endpoint.",
  contract: {
    objective: "Say hello",
    inputs: [],
    outputs: [{ kind: "report", description: "a greeting" }],
    acceptance: [{ kind: "human", hard: true }],
    constraints: [],
    sensitivity: "internal",
  },
  handoffs: [],
  brief: { summary: "", items: [] },
  attachments: [],
  limits: { maxCostUsd: 1, maxMinutes: 5, maxOutputTokens: 1024 },
  mcpServers: [],
  ...over,
});

export function harness(spec: ContractSpec, vendor: FakeVendor, over: Partial<RunContext> = {}) {
  const events: AdapterEvent[] = [];
  const logs: string[] = [];
  const redactor = new Redactor();
  redactor.register(FAKE_KEY);
  const logger = redactingLogger(
    (level, obj, msg) => logs.push(JSON.stringify({ level, obj, msg })),
    redactor,
  );
  const agent: AgentConfig = {
    agentId: "0192b3c4-5d6e-7f80-9a1b-000000000001",
    name: "fixture agent",
    model: spec.model,
    rolePrompt: "You are concise.",
    connector: spec.connector,
    price: spec.price,
  };
  const ctx: RunContext = {
    credential: secret(),
    emit: (e) => events.push(e),
    signal: new AbortController().signal,
    sandbox: NO_SANDBOX,
    logger,
    fetch: vendor.fetch,
    ...over,
  };
  return { events, logs, agent, ctx };
}

const progressMailbox = (notes: string[]): Mailbox => ({
  askAgent: async () => "no one is listening",
  inbox: async () => [],
  answer: async () => {},
  requestReview: async () => {},
  getBrief: async () => "",
  reportBlocker: async () => {},
  reportProgress: async (note) => {
    notes.push(note);
  },
  getContract: async () => "no contracts",
});

export function defineAdapterContract(spec: ContractSpec) {
  describe(`${spec.name}: adapter contract`, () => {
    it("health check passes against the live model list and reports a bad key as auth", async () => {
      const ok = new FakeVendor({ lists: spec.fixtures.models });
      const h = harness(spec, ok);
      const status = await spec.adapter.healthCheck(spec.connector, h.ctx);
      expect(status.ok).toBe(true);

      const unauthorised = async () =>
        new Response(JSON.stringify({ error: { message: "invalid x-api-key" } }), { status: 401 });
      const failed = await spec.adapter.healthCheck(
        spec.connector,
        harness(spec, new FakeVendor(), { fetch: unauthorised }).ctx,
      );
      expect(failed).toMatchObject({ ok: false, code: "auth" });
    });

    it("lists models live, following pagination", async () => {
      const vendor = new FakeVendor({ lists: spec.fixtures.models });
      const models = await spec.adapter.listModels?.(spec.connector, harness(spec, vendor).ctx);
      expect(models).toHaveLength(spec.modelCount);
      expect(models?.every((m) => typeof m.id === "string" && !m.id.startsWith("models/"))).toBe(true);
      const auth = spec.authHeader(FAKE_KEY);
      if (auth) expect(vendor.requests[0]?.headers[auth[0]]).toBe(auth[1]);
    });

    it("estimates a finite cost within the run's limits", async () => {
      const h = harness(spec, new FakeVendor());
      const est = await spec.adapter.estimate(helloInput(), h.agent);
      expect(Number.isFinite(est.usd)).toBe(true);
      expect(est.usd).toBeGreaterThanOrEqual(0);
      expect(est.minutes).toBeLessThanOrEqual(5);
    });

    it("runs the hello task: answer, usage and a cost event per call", async () => {
      const vendor = new FakeVendor({ generations: [{ body: spec.fixtures.hello }] });
      const h = harness(spec, vendor);
      const result = await spec.adapter.run(helloInput(), h.agent, h.ctx);
      expect(result.status).toBe("completed");
      expect(result.output).toBe(spec.helloText);
      expect(result.summary.length).toBeGreaterThan(0);
      expect(result.tokens).toEqual(spec.helloUsage);
      const costs = h.events.filter((e) => e.kind === "cost");
      expect(costs).toHaveLength(1);
      expect(result.usage.usd).toBeCloseTo(
        costs.reduce((s, e) => s + (e.kind === "cost" ? e.usd : 0), 0),
        6,
      );
      expect(h.events).toContainEqual({ kind: "message", role: "assistant", text: spec.helloText });

      const req = vendor.generationRequests[0];
      expect(req?.url).toMatch(spec.generationPath);
      const auth = spec.authHeader(FAKE_KEY);
      if (auth) expect(req?.headers[auth[0]]).toBe(auth[1]);
      expect(JSON.stringify(req?.body)).toContain("add a health endpoint");
      expect(`${req?.url} ${JSON.stringify(req?.body)}`).toContain(spec.model.replace(/^models\//, ""));
    });

    it("runs the internal tool loop: tool call, tool result fed back, final answer", async () => {
      const vendor = new FakeVendor({
        generations: [{ body: spec.fixtures.toolCall }, { body: spec.fixtures.afterTool }],
      });
      const notes: string[] = [];
      const h = harness(spec, vendor, { tools: { mailbox: progressMailbox(notes) } });
      const result = await spec.adapter.run(helloInput(), h.agent, h.ctx);
      expect(result.status).toBe("completed");
      expect(notes).toEqual(["halfway"]);
      expect(h.events).toContainEqual({
        kind: "tool_call",
        name: "report_progress",
        args: { note: "halfway" },
      });
      expect(h.events.filter((e) => e.kind === "cost")).toHaveLength(2);
      const second = JSON.stringify(vendor.generationRequests[1]?.body);
      expect(second).toContain("posted");
      expect(second).toContain("report_progress");
      expect(JSON.stringify(vendor.generationRequests[0]?.body)).toContain("report_progress");
    });

    it("offers no tools when nothing backs them (sandbox tools fail closed until M2)", async () => {
      const vendor = new FakeVendor({ generations: [{ body: spec.fixtures.hello }] });
      const h = harness(spec, vendor);
      await spec.adapter.run(helloInput(), h.agent, h.ctx);
      const body = JSON.stringify(vendor.generationRequests[0]?.body);
      expect(body).not.toContain("read_file");
      expect(body).not.toContain("run_command");
    });

    it("cancels mid-run promptly", async () => {
      const vendor = new FakeVendor({ generations: ["hang"] });
      const ac = new AbortController();
      const h = harness(spec, vendor, { signal: ac.signal });
      const started = Date.now();
      const running = spec.adapter.run(helloInput(), h.agent, h.ctx);
      setTimeout(() => ac.abort(), 20);
      const result = await running;
      expect(result.status).toBe("cancelled");
      expect(Date.now() - started).toBeLessThan(2000);
    });

    it("ends with limit_exceeded when the orchestrator aborts for a time limit", async () => {
      const vendor = new FakeVendor({ generations: ["hang"] });
      const ac = new AbortController();
      const h = harness(spec, vendor, { signal: ac.signal });
      const running = spec.adapter.run(helloInput(), h.agent, h.ctx);
      setTimeout(() => ac.abort(new LimitExceeded("ran past 5 minutes")), 20);
      const result = await running;
      expect(result.status).toBe("limit_exceeded");
      expect(result.error).toContain("5 minutes");
    });

    it("ends with limit_exceeded when the cost limit is crossed", async () => {
      if (!spec.price) return;
      const vendor = new FakeVendor({
        generations: [{ body: spec.fixtures.toolCall }, { body: spec.fixtures.afterTool }],
      });
      const h = harness(spec, vendor, { tools: { mailbox: progressMailbox([]) } });
      const result = await spec.adapter.run(
        helloInput({ limits: { maxCostUsd: 0.000001, maxMinutes: 5 } }),
        h.agent,
        h.ctx,
      );
      expect(result.status).toBe("limit_exceeded");
      expect(vendor.generationRequests).toHaveLength(1);
    });

    it("stops after maxTurns model calls", async () => {
      const vendor = new FakeVendor({
        generations: [{ body: spec.fixtures.toolCall }, { body: spec.fixtures.toolCall }],
      });
      const h = harness(spec, vendor, { tools: { mailbox: progressMailbox([]) } });
      const result = await spec.adapter.run(
        helloInput({ limits: { maxCostUsd: 1, maxMinutes: 5, maxTurns: 1 } }),
        h.agent,
        h.ctx,
      );
      expect(result.status).toBe("limit_exceeded");
    });

    it("fails (not throws) on vendor errors, retrying rate limits first", async () => {
      const vendor = new FakeVendor({
        generations: [
          { status: 429, body: { error: { message: "slow down" } }, headers: { "retry-after": "0" } },
          { status: 400, body: { error: { message: "bad model" } } },
        ],
      });
      const h = harness(spec, vendor);
      const result = await spec.adapter.run(helloInput(), h.agent, h.ctx);
      expect(result.status).toBe("failed");
      expect(result.error).toContain("bad model");
      expect(vendor.generationRequests).toHaveLength(2);
    });

    it("never lets the credential reach events, results or logs, even when the vendor echoes it", async () => {
      const echo = `Incorrect API key provided: ${FAKE_KEY}`;
      const vendor = new FakeVendor({ generations: [{ status: 401, body: { error: { message: echo } } }] });
      const h = harness(spec, vendor);
      const result = await spec.adapter.run(helloInput(), h.agent, h.ctx);
      h.ctx.logger.info({ apiKey: FAKE_KEY, note: `key was ${FAKE_KEY}` }, "logging the key on purpose");
      const everything = JSON.stringify({ result, events: h.events, logs: h.logs });
      expect(result.status).toBe("failed");
      expect(everything).not.toContain(FAKE_KEY);
      expect(everything).toContain("[redacted]");
    });
  });
}

export { FakeVendor } from "./fake-vendor";
