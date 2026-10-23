// Browser agents (ADAPTER_SPEC §2.7, docs/vendors/research-browser.md §10, §12): every computer-use member translates to
// a safe xdotool command; the loop answers every tool_use in order with screenshots and results, stops a turn at the
// first failure, asks a person before irreversible steps, prunes old screenshots and meters each turn; Browser Use runs
// to its reported cost and cancels.
import { registry } from "@brio/registry";
import { describe, expect, it } from "vitest";
import { ADAPTERS } from "../src/index";
import {
  type Actuator,
  createComputerUse,
  pruneScreenshots,
  startUrl,
  TOOLSET,
  xdotool,
} from "../src/services/browser/index";
import type { AdapterEvent, AgentAdapter, AgentConfig, RunContext, RunInput } from "../src/types";
import { helloInput, secret } from "./contract";
import { FakeService } from "./service-fakes";

const KEY = ["browser", "key", "0123456789abcdefghijklmnop"].join("-");
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

describe("computer use: actions", () => {
  it("translates every member to xdotool", () => {
    expect(xdotool("left_click", { coordinate: [10, 20] })).toBe("xdotool mousemove 10 20 click 1");
    expect(xdotool("right_click", {})).toBe("xdotool click 3");
    expect(xdotool("double_click", { coordinate: [1, 2] })).toBe(
      "xdotool mousemove 1 2 click --repeat 2 --delay 80 1",
    );
    expect(xdotool("triple_click", { coordinate: [1, 2], text: "shift" })).toBe(
      "xdotool keydown shift && xdotool mousemove 1 2 click --repeat 3 --delay 80 1 ; xdotool keyup shift",
    );
    expect(xdotool("left_click_drag", { start_coordinate: [1, 2], coordinate: [3, 4] })).toBe(
      "xdotool mousemove 1 2 mousedown 1 mousemove 3 4 mouseup 1",
    );
    expect(xdotool("mouse_move", { coordinate: [5, 6] })).toBe("xdotool mousemove 5 6");
    expect(xdotool("left_mouse_down", {})).toBe("xdotool mousedown 1");
    expect(xdotool("left_mouse_up", {})).toBe("xdotool mouseup 1");
    expect(xdotool("scroll", { coordinate: [500, 400], scroll_direction: "down", scroll_amount: 3 })).toBe(
      "xdotool mousemove 500 400 click --repeat 3 --delay 40 5",
    );
    expect(xdotool("key", { text: "ctrl+s", repeat: 2 })).toBe("xdotool key --repeat 2 --delay 40 -- ctrl+s");
    expect(xdotool("hold_key", { text: "shift", duration: 2 })).toBe(
      "xdotool keydown shift && sleep 2 ; xdotool keyup shift",
    );
    expect(xdotool("wait", { duration: 3 })).toBe("sleep 3");
  });

  it("quotes typed text so it cannot become a command", () => {
    expect(xdotool("type", { text: "it's $(rm -rf /) `x`" })).toBe(
      "xdotool type --delay 12 -- 'it'\\''s $(rm -rf /) `x`'",
    );
  });

  it("refuses inputs that are not what the toolset sends", () => {
    expect(() => xdotool("key", { text: "ctrl+s; rm -rf /" })).toThrow(/key combination/);
    expect(() => xdotool("left_click", { coordinate: ["1; ls", 2] })).toThrow(/number/);
    expect(() => xdotool("scroll", { scroll_direction: "sideways" })).toThrow(/scroll_direction/);
    expect(() => xdotool("wait", { duration: 9999 })).toThrow(/between 0 and 300/);
    expect(() => xdotool("launch_rocket", {})).toThrow(/unknown action/);
  });

  it("starts on the task's site", () => {
    const base = helloInput().contract;
    expect(
      startUrl({
        ...helloInput(),
        contract: { ...base, inputs: [{ kind: "url", ref: "https://shop.example.com/p/1" }] },
      }),
    ).toBe("https://shop.example.com/p/1");
    expect(
      startUrl({
        ...helloInput(),
        contract: { ...base, objective: "Find the price on https://example.org/item." },
      }),
    ).toBe("https://example.org/item.");
    expect(startUrl(helloInput())).toBeNull();
  });
});

function fakeActuator(fail?: string) {
  const log: string[] = [];
  const a: Actuator = {
    open: async (url, s) => void log.push(`open ${url} ${s.width}x${s.height}`),
    screenshot: async (r) => {
      log.push(r ? `zoom ${r.join(",")}` : "screenshot");
      return PNG;
    },
    act: async (name, input) => {
      if (name === fail) throw new Error(`${name} failed`);
      log.push(`${name} ${JSON.stringify(input)}`);
      return "OK";
    },
    close: async () => void log.push("close"),
  };
  return { a, log };
}

type Turn = { content: unknown[]; stop_reason: string };

function computer(turns: Turn[], opts: { fail?: string; reply?: string | null; mailbox?: boolean } = {}) {
  const fake = new FakeService().on("POST", /^\/v1\/messages$/, (_r, n) => ({
    id: `msg_${n}`,
    ...(turns[n] ?? turns.at(-1)),
    usage: { input_tokens: 1000, output_tokens: 100 },
  }));
  const act = fakeActuator(opts.fail);
  const adapter = createComputerUse(() => act.a);
  const sv = registry().service("anthropic-computer-use");
  if (!sv) throw new Error("no service");
  const config: AgentConfig = {
    agentId: "a1",
    name: "Browser",
    model: "claude-sonnet-5-5",
    rolePrompt: "",
    connector: {
      registryKey: sv.connector,
      serviceKey: "anthropic-computer-use",
      service: sv,
      settings: {},
      baseUrl: "",
    },
    price: { inputPerM: 3, outputPerM: 15, cachedInputPerM: null, cacheWritePerM: null },
    unitPrice: null,
    options: {},
  };
  const events: AdapterEvent[] = [];
  const asked: string[] = [];
  const ctx = {
    credential: secret(KEY),
    emit: (e: AdapterEvent) => void events.push(e),
    signal: new AbortController().signal,
    sandbox: {} as RunContext["sandbox"],
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    fetch: fake.fetch,
    ...(opts.mailbox === false
      ? {}
      : {
          tools: {
            mailbox: {
              askUser: async (q: string) => {
                asked.push(q);
                return opts.reply === undefined ? "yes" : opts.reply;
              },
            } as unknown as NonNullable<RunContext["tools"]>["mailbox"],
          },
        }),
  } satisfies RunContext;
  const input: RunInput = {
    ...helloInput(),
    taskType: "browser.task",
    instructions: "Find the price of item 1 on https://shop.example.com",
    contract: { ...helloInput().contract, inputs: [{ kind: "url", ref: "https://shop.example.com" }] },
    limits: { maxCostUsd: 5, maxMinutes: 5, maxOutputTokens: 1024, maxTurns: 10 },
  };
  return { fake, act, adapter, config, ctx, events, asked, input };
}

const use = (id: string, name: string, input: Record<string, unknown> = {}, toolset = true) => ({
  type: "tool_use",
  id,
  name,
  ...(toolset ? { toolset_name: "computer" } : {}),
  input,
});

describe("computer use: the loop", () => {
  it("runs actions in the sandbox's browser and answers every tool_use, then reports the result", async () => {
    const s = computer([
      {
        content: [use("t1", "screenshot"), use("t2", "left_click", { coordinate: [10, 20] })],
        stop_reason: "tool_use",
      },
      {
        content: [use("t3", "zoom", { region: [0, 0, 100, 50] }), use("t4", "type", { text: "secret-ish" })],
        stop_reason: "tool_use",
      },
      { content: [{ type: "text", text: "The price is $12." }], stop_reason: "end_turn" },
    ]);
    const res = await s.adapter.run(s.input, s.config, s.ctx);
    expect(res.status, res.error).toBe("completed");
    expect(res.output).toBe("The price is $12.");
    expect(s.act.log).toEqual([
      "open https://shop.example.com 1280x800",
      "screenshot",
      'left_click {"coordinate":[10,20]}',
      "zoom 0,0,100,50",
      'type {"text":"secret-ish"}',
      "screenshot",
      "close",
    ]);
    const bodies = s.fake.calls("POST", /messages/).map((r) => r.body as Record<string, unknown>);
    expect(bodies[0]).toMatchObject({
      model: "claude-sonnet-5-5",
      tools: [{ type: TOOLSET }, { name: "ask_person" }],
    });
    const results = ((bodies[1]?.messages ?? []) as Array<{ role: string; content: unknown }>).at(-1);
    expect(results).toMatchObject({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "t1",
          toolset_name: "computer",
          content: [{ type: "image", source: { media_type: "image/png" } }],
        },
        {
          type: "tool_result",
          tool_use_id: "t2",
          toolset_name: "computer",
          content: [{ type: "text", text: "OK" }],
        },
      ],
    });
    // Three turns at 1,000 in and 100 out each, at $3 / $15 per 1M.
    expect(res.usage.usd).toBeCloseTo(3 * (0.003 + 0.0015), 6);
    expect(res.files?.[0]).toMatchObject({ kind: "image", name: "final-screen.png" });
    // What was typed is not echoed into events; the key never is.
    expect(JSON.stringify(s.events)).not.toContain("secret-ish");
    expect(JSON.stringify(s.events)).not.toContain(KEY);
    for (const r of s.fake.requests) expect(r.headers["x-api-key"]).toBe(KEY);
  });

  it("stops a turn at the first failure and answers the rest as not executed", async () => {
    const s = computer(
      [
        {
          content: [use("t1", "left_click", { coordinate: [1, 1] }), use("t2", "key", { text: "Return" })],
          stop_reason: "tool_use",
        },
        { content: [{ type: "text", text: "Could not click." }], stop_reason: "end_turn" },
      ],
      { fail: "left_click" },
    );
    await s.adapter.run(s.input, s.config, s.ctx);
    const second = s.fake.calls("POST", /messages/)[1]?.body as { messages: Array<{ content: unknown }> };
    expect(second.messages.at(-1)?.content).toEqual([
      {
        type: "tool_result",
        tool_use_id: "t1",
        toolset_name: "computer",
        is_error: true,
        content: [{ type: "text", text: "left_click failed" }],
      },
      {
        type: "tool_result",
        tool_use_id: "t2",
        toolset_name: "computer",
        is_error: true,
        content: [{ type: "text", text: "Not executed: an earlier computer action in this turn failed." }],
      },
    ]);
    expect(s.act.log.some((l) => l.startsWith("key"))).toBe(false);
  });

  it("asks a person before an irreversible step; no answer is no", async () => {
    const turns = [
      {
        content: [use("q1", "ask_person", { question: "Submit the order?" }, false)],
        stop_reason: "tool_use",
      },
      { content: [{ type: "text", text: "Stopped before ordering." }], stop_reason: "end_turn" },
    ];
    const yes = computer(turns);
    await yes.adapter.run(yes.input, yes.config, yes.ctx);
    expect(yes.asked).toEqual(["Submit the order?"]);
    expect(JSON.stringify(yes.fake.calls("POST", /messages/)[1]?.body)).toContain('"text":"yes"');
    const none = computer(turns, { reply: null });
    await none.adapter.run(none.input, none.config, none.ctx);
    expect(JSON.stringify(none.fake.calls("POST", /messages/)[1]?.body)).toContain(
      "No answer. Treat it as no",
    );
    expect(none.events).toContainEqual({ kind: "needs_input", question: "Submit the order?" });
  });

  it("stops at the cost limit and after too many turns", async () => {
    const loop = [{ content: [use("t", "screenshot")], stop_reason: "tool_use" }];
    const costly = computer(loop);
    const r1 = await costly.adapter.run(
      { ...costly.input, limits: { ...costly.input.limits, maxCostUsd: 0.01 } },
      costly.config,
      costly.ctx,
    );
    expect(r1.status).toBe("limit_exceeded");
    const endless = computer(loop);
    const r2 = await endless.adapter.run(endless.input, endless.config, endless.ctx);
    expect(r2).toMatchObject({ status: "failed", error: "stopped after 10 turns without finishing" });
    expect(endless.act.log.at(-1)).toBe("close");
  });

  it("keeps only the newest screenshots in the context", () => {
    const img = { type: "image", source: { type: "base64", media_type: "image/png", data: "x" } };
    const turn = (id: string) => ({
      role: "user" as const,
      content: [{ type: "tool_result", tool_use_id: id, content: [img] }],
    });
    const messages = [turn("a"), turn("b"), turn("c"), turn("d"), turn("e")];
    pruneScreenshots(messages as never, 3);
    const kept = messages.map((m) => (m.content[0]?.content[0] as { type: string } | undefined)?.type);
    expect(kept).toEqual(["text", "text", "image", "image", "image"]);
  });
});

describe("Browser Use Cloud", () => {
  const setup = (script: "done" | "forever") => {
    const fake = new FakeService()
      .on("POST", /^\/api\/v4\/runs$/, () => ({ id: "run_1", status: "queued" }))
      .on("GET", /^\/api\/v4\/runs\/run_1\/status$/, (_r, n) => ({
        status: script === "forever" || n === 0 ? "running" : "completed",
      }))
      .on("GET", /^\/api\/v4\/runs\/run_1$/, () => ({
        id: "run_1",
        status: "completed",
        output: "The price is $12.",
        totalInputTokens: 5000,
        totalOutputTokens: 400,
        totalCostUsd: 0.042,
      }))
      .on("POST", /^\/api\/v4\/runs\/run_1\/cancel$/, () => ({}));
    const sv = registry().service("browser-use");
    if (!sv) throw new Error("no service");
    const config: AgentConfig = {
      agentId: "a1",
      name: "BU",
      model: "default",
      rolePrompt: "",
      connector: {
        registryKey: sv.connector,
        serviceKey: "browser-use",
        service: sv,
        settings: {},
        baseUrl: "",
      },
      price: null,
      unitPrice: null,
      options: { pollMs: 5 },
    };
    const controller = new AbortController();
    const events: AdapterEvent[] = [];
    const ctx = {
      credential: secret(KEY),
      emit: (e: AdapterEvent) => void events.push(e),
      signal: controller.signal,
      sandbox: {} as RunContext["sandbox"],
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      fetch: fake.fetch,
    } satisfies RunContext;
    const input: RunInput = {
      ...helloInput(),
      taskType: "browser.task",
      limits: { maxCostUsd: 2, maxMinutes: 5, maxOutputTokens: 1024 },
    };
    return { fake, config, ctx, controller, events, input, adapter: ADAPTERS["browser-use"] as AgentAdapter };
  };

  it("runs in Browser Use's cloud, capped at the attempt's limit, and meters the reported cost", async () => {
    const s = setup("done");
    const res = await s.adapter.run(s.input, s.config, s.ctx);
    expect(res.status, res.error).toBe("completed");
    expect(res.output).toBe("The price is $12.");
    expect(res.usage.usd).toBeCloseTo(0.042, 6);
    const body = s.fake.calls("POST", /runs$/)[0]?.body as { task: string; maxCostUsd: number };
    expect(body.maxCostUsd).toBe(2);
    expect(body.task).toMatch(/Never type passwords/);
    for (const r of s.fake.requests) expect(r.headers["x-browser-use-api-key"]).toBe(KEY);
    expect(JSON.stringify(s.events)).not.toContain(KEY);
  });

  it("cancels the run when the attempt is cancelled", async () => {
    const s = setup("forever");
    const run = s.adapter.run(s.input, s.config, s.ctx);
    await new Promise((r) => setTimeout(r, 40));
    s.controller.abort();
    expect((await run).status).toBe("cancelled");
    expect(s.fake.calls("POST", /cancel$/)).toHaveLength(1);
  });

  it("covers every browser service in the registry", () => {
    const browsers = Object.entries(registry().services).filter(([, s]) => s.kind === "browser");
    expect(browsers.map(([k]) => k).sort()).toEqual(["anthropic-computer-use", "browser-use"]);
    for (const [k, s] of browsers) expect(ADAPTERS[s.adapter], k).toBeDefined();
  });
});
