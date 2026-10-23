// Amazon Nova Act (docs/vendors/protocols.md §4): the AWS service API, signed with SigV4, drives an act step by step;
// Brio answers each step with call results and viewport observations, runs actions on the sandbox's browser, asks a
// person for approvals, refuses UI takeovers, and closes the act and the run either way.
import { registry } from "@brio/registry";
import { describe, expect, it } from "vitest";
import { ADAPTERS } from "../src/index";
import {
  boxCentre,
  createNovaAct,
  HUMAN_TOOLS,
  type NovaBrowser,
  VIEWPORT,
} from "../src/services/browser/index";
import type { AdapterEvent, AgentConfig, RunContext, RunInput } from "../src/types";
import { helloInput, secret } from "./contract";
import { FakeService } from "./service-fakes";

const AWS = JSON.stringify({
  accessKeyId: "AKIDEXAMPLE",
  secretAccessKey: ["nova", "secret", "0123456789abcdefghij"].join("-"),
});
const OBS = JSON.stringify({
  activeURL: "https://shop.example.com/",
  browserDimensions: { windowWidth: 1600, windowHeight: 813 },
  screenshotBase64: "data:image/jpeg;base64,/9j/AA==",
});
const RUN = "/workflow-definitions/brio/workflow-runs/run-1";
const ACT = `${RUN}/sessions/sess-1/acts/act-1`;

function fakeBrowser() {
  const log: string[] = [];
  const b: NovaBrowser = {
    open: async (url) => void log.push(`open ${url}`),
    observe: async () => (log.push("observe"), OBS),
    click: async (x, y, k) => void log.push(`click ${x},${y} ${k}`),
    hover: async (x, y) => void log.push(`hover ${x},${y}`),
    scroll: async (d, x, y) => void log.push(`scroll ${d} ${x},${y}`),
    type: async (x, y, t, e) => void log.push(`type ${x},${y} ${t} ${e}`),
    goto: async (u) => void log.push(`goto ${u}`),
    settle: async () => void log.push("settle"),
    close: async () => void log.push("close"),
  };
  return { b, log };
}

function setup(steps: Array<Array<{ name: string; input: unknown }>>, reply: string | null = "yes") {
  const f = new FakeService()
    .on(
      "PUT",
      /^\/workflow-definitions$/,
      () => new Response(JSON.stringify({ message: "exists" }), { status: 409 }),
    )
    .on("PUT", /^\/workflow-definitions\/brio\/workflow-runs$/, () => ({
      workflowRunId: "run-1",
      status: "RUNNING",
    }))
    .on("PUT", /\/sessions$/, () => ({ sessionId: "sess-1" }))
    .on("PUT", /\/acts$/, () => ({ actId: "act-1", status: "RUNNING" }))
    .on("PUT", /\/invoke-step\/$/, (_r, n) => ({
      stepId: `step-${n + 1}`,
      calls: (steps[n] ?? [{ name: "return", input: ["late"] }]).map((c, i) => ({
        callId: `c${n}-${i}`,
        ...c,
      })),
    }))
    .on("PUT", /\/acts\/act-1$/, () => ({}))
    .on("PUT", /\/workflow-runs\/run-1$/, () => ({}));
  const br = fakeBrowser();
  const sv = registry().service("nova-act");
  if (!sv) throw new Error("no service");
  const config: AgentConfig = {
    agentId: "a1",
    name: "Nova",
    model: "nova-act-latest",
    rolePrompt: "",
    connector: {
      registryKey: sv.connector,
      serviceKey: "nova-act",
      service: sv,
      settings: { region: "us-east-1" },
      baseUrl: "",
    },
    price: null,
    unitPrice: { unit: "second", usd: sv.pricing.usdPerUnit ?? 0 },
    options: {},
  };
  const events: AdapterEvent[] = [];
  const asked: string[] = [];
  const ctx = {
    credential: secret(AWS),
    emit: (e: AdapterEvent) => void events.push(e),
    signal: new AbortController().signal,
    sandbox: { available: true } as RunContext["sandbox"],
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    fetch: f.fetch,
    tools: {
      mailbox: { askUser: async (q: string) => (asked.push(q), reply) } as unknown as NonNullable<
        RunContext["tools"]
      >["mailbox"],
    },
  } satisfies RunContext;
  const input: RunInput = {
    ...helloInput(),
    taskType: "browser.task",
    instructions: "Find the price of the blue mug",
    contract: { ...helloInput().contract, inputs: [{ kind: "url", ref: "https://shop.example.com/" }] },
    limits: { maxCostUsd: 5, maxMinutes: 5, maxOutputTokens: 1024, maxTurns: 10 },
  };
  return { f, br, adapter: createNovaAct(() => br.b), config, ctx, events, asked, input };
}

const body = (f: FakeService, path: RegExp, i = 0) =>
  f.calls("PUT", path)[i]?.body as Record<string, unknown>;

describe("Nova Act", () => {
  it("runs an act step by step on the sandbox's browser and returns its answer", async () => {
    const s = setup([
      [
        { name: "browser.waitForPageToSettle", input: [] },
        { name: "browser.takeObservation", input: [] },
        { name: "browser.agentClick", input: ["<box>100,200,140,400</box>"] },
        {
          name: "browser.agentType",
          input: ["mug model 7", "<bbox>0,0,500,100</bbox>", { pressEnter: true }],
        },
      ],
      [{ name: "tool.human_Approve", input: { message: "Open the product page?" } }],
      [{ name: "return", input: ["The blue mug costs $12."] }],
    ]);
    const res = await s.adapter.run(s.input, s.config, s.ctx);
    expect(res.status, res.error).toBe("completed");
    expect(res.output).toBe("The blue mug costs $12.");
    expect(s.br.log).toEqual([
      "open https://shop.example.com/",
      "observe",
      "settle",
      "observe",
      "click 300,120 left",
      "type 400,40.65 mug model 7 true",
      "observe",
      "close",
    ]);
    // The act carries the human tools; the first step answers initiateAct and an observation.
    expect(body(s.f, /\/acts$/)).toMatchObject({ toolSpecs: HUMAN_TOOLS });
    expect(body(s.f, /\/workflow-runs$/)).toEqual({
      modelId: "nova-act-latest",
      clientInfo: { compatibilityVersion: 1 },
    });
    expect(body(s.f, /invoke-step/, 0)).toEqual({
      callResults: [
        { callId: "initiateAct", content: [{ text: "{}" }] },
        { callId: "takeObservation", content: [{ text: OBS }] },
      ],
    });
    expect(body(s.f, /invoke-step/, 1)).toEqual({
      previousStepId: "step-1",
      callResults: [
        { callId: "c0-0", content: [{ text: "null" }] },
        { callId: "c0-1", content: [{ text: OBS }] },
        { callId: "c0-2", content: [{ text: "null" }] },
        { callId: "c0-3", content: [{ text: "null" }] },
      ],
    });
    expect(body(s.f, /invoke-step/, 2)?.callResults).toEqual([
      { callId: "c1-0", content: [{ text: '"yes"' }] },
    ]);
    expect(s.asked[0]).toContain("Open the product page?");
    expect(body(s.f, /\/acts\/act-1$/)).toEqual({ status: "SUCCEEDED" });
    expect(body(s.f, /\/workflow-runs\/run-1$/)).toEqual({ status: "SUCCEEDED" });
    // Every request is SigV4-signed; the secret never travels or reaches events.
    for (const r of s.f.requests) {
      expect(r.headers.authorization).toMatch(
        /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/us-east-1\/nova-act\/aws4_request/,
      );
      expect(JSON.stringify(r)).not.toContain("nova-secret");
    }
    // What was typed stays out of events.
    expect(JSON.stringify(s.events)).not.toContain("mug model 7");
    expect(res.files?.[0]).toMatchObject({ kind: "image", contentType: "image/jpeg" });
  });

  it("fails the act on a declined approval, a UI takeover, a model giving up or a failing action", async () => {
    const cases: Array<[Array<Array<{ name: string; input: unknown }>>, string | null, RegExp]> = [
      [[[{ name: "tool.human_Approve", input: { message: "Pay $40?" } }]], null, /not approved: Pay \$40\?/],
      [[[{ name: "tool.human_UiTakeover", input: { message: "Log in" } }]], "yes", /take over the browser/],
      [[[{ name: "throw", input: ["The item is out of stock"] }]], "yes", /out of stock/],
      [[[{ name: "agentClick", input: ["nowhere"] }]], "yes", /^Error: not a box/],
    ];
    for (const [steps, reply, why] of cases) {
      const s = setup(steps, reply);
      const res = await s.adapter.run(s.input, s.config, s.ctx);
      expect(res.status).toBe("failed");
      expect(res.error).toMatch(why);
      expect(body(s.f, /\/acts\/act-1$/)).toMatchObject({ status: "FAILED" });
      expect(body(s.f, /\/workflow-runs\/run-1$/)).toEqual({ status: "FAILED" });
      expect(s.br.log.at(-1)).toBe("close");
    }
  });

  it("reads both box formats", () => {
    expect(boxCentre("<box>10,20,30,60</box>")).toEqual([40, 20]);
    expect(boxCentre("<bbox>0,0,1000,1000</bbox>")).toEqual([VIEWPORT.width / 2, VIEWPORT.height / 2]);
    expect(boxCentre("250,500,750,500")).toEqual([800, 406.5]);
    expect(() => boxCentre("<bbox>0,0,2000,10</bbox>")).toThrow(/not a box/);
  });

  it("is registered with its service", () => {
    expect(ADAPTERS["nova-act"]?.route).toBe("browser");
    expect(registry().service("nova-act")?.auth).toEqual({ scheme: "aws-sigv4", service: "nova-act" });
  });
});
