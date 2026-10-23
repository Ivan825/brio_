// Cloud browsers (docs/vendors/research-browser.md §13): Browserbase and Steel sessions are created, metered by the
// seconds they were open and released; computer use drives them over CDP — screenshots, clicks, typing and keys — with
// the task's site allowlist enforced inside the browser. A fake DevTools socket stands in for the browser.
import { registry } from "@brio/registry";
import { describe, expect, it } from "vitest";
import { ADAPTERS } from "../src/index";
import {
  actuatorFor,
  cdpActuator,
  cloudBrowserProvider,
  keyOf,
  type WsLike,
} from "../src/services/browser/index";
import type { AgentConfig, CloudBrowserProvider, ConnectorConfig, RunContext, RunInput } from "../src/types";
import { helloInput, secret } from "./contract";
import { FakeService } from "./service-fakes";

const KEY = ["cloud", "browser", "0123456789abcdefghijklmnop"].join("-");
const PNG_B64 = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64");

/** A DevTools endpoint: answers each command, records it, and can push events (a paused request). */
class FakeDevTools {
  readonly sent: Array<{ method: string; params: Record<string, unknown>; sessionId?: string }> = [];
  private listeners: Record<string, Array<(e: { data?: unknown }) => void>> = {};
  urls: string[] = [];
  readonly connect = (url: string): WsLike => {
    this.urls.push(url);
    const ws: WsLike = {
      send: (data) => this.handle(JSON.parse(data)),
      close: () => this.emit("close", {}),
      addEventListener: (type: string, fn: (e: { data?: unknown }) => void) => {
        this.listeners[type] = [...(this.listeners[type] ?? []), fn];
      },
    } as WsLike;
    setTimeout(() => this.emit("open", {}), 0);
    return ws;
  };
  private emit(type: string, e: { data?: unknown }) {
    for (const fn of this.listeners[type] ?? []) fn(e);
  }
  push(method: string, params: Record<string, unknown>, sessionId = "S1") {
    this.emit("message", { data: JSON.stringify({ method, params, sessionId }) });
  }
  private handle(m: { id: number; method: string; params: Record<string, unknown>; sessionId?: string }) {
    this.sent.push({
      method: m.method,
      params: m.params,
      ...(m.sessionId ? { sessionId: m.sessionId } : {}),
    });
    const result: Record<string, unknown> =
      m.method === "Target.getTargets"
        ? { targetInfos: [{ targetId: "T1", type: "page" }] }
        : m.method === "Target.attachToTarget"
          ? { sessionId: "S1" }
          : m.method === "Page.captureScreenshot"
            ? { data: PNG_B64 }
            : {};
    setTimeout(() => this.emit("message", { data: JSON.stringify({ id: m.id, result }) }), 0);
  }
  methods = () => this.sent.map((s) => s.method);
}

describe("computer use over CDP", () => {
  it("opens the page, sees it and acts on it, with the allowlist inside the browser", async () => {
    const dev = new FakeDevTools();
    let released = 0;
    const a = cdpActuator({
      url: "wss://connect.example/s1",
      allow: ["example.com", ".example.com"],
      release: async () => void released++,
      connect: dev.connect,
    });
    await a.open("https://www.example.com/", { width: 1280, height: 800 });
    expect(dev.methods()).toEqual([
      "Target.getTargets",
      "Target.attachToTarget",
      "Fetch.enable",
      "Emulation.setDeviceMetricsOverride",
      "Page.enable",
      "Page.navigate",
    ]);
    expect(dev.sent.at(-1)).toEqual({
      method: "Page.navigate",
      params: { url: "https://www.example.com/" },
      sessionId: "S1",
    });

    // Requests to the task's site go on; anything else fails in the browser.
    dev.push("Fetch.requestPaused", { requestId: "r1", request: { url: "https://cdn.example.com/a.js" } });
    dev.push("Fetch.requestPaused", { requestId: "r2", request: { url: "https://tracker.evil.net/x" } });
    await new Promise((r) => setTimeout(r, 5));
    expect(dev.sent.filter((s) => s.method.startsWith("Fetch.") && s.method !== "Fetch.enable")).toEqual([
      { method: "Fetch.continueRequest", params: { requestId: "r1" }, sessionId: "S1" },
      {
        method: "Fetch.failRequest",
        params: { requestId: "r2", errorReason: "BlockedByClient" },
        sessionId: "S1",
      },
    ]);

    expect([...(await a.screenshot())]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    await a.screenshot([10, 20, 110, 70]);
    expect(dev.sent.at(-1)?.params).toEqual({
      format: "png",
      clip: { x: 10, y: 20, width: 100, height: 50, scale: 1 },
    });

    dev.sent.length = 0;
    await a.act("double_click", { coordinate: [5, 6] });
    expect(dev.sent.map((s) => [s.params.type, s.params.clickCount ?? null])).toEqual([
      ["mouseMoved", null],
      ["mousePressed", 1],
      ["mouseReleased", 1],
      ["mousePressed", 2],
      ["mouseReleased", 2],
    ]);
    expect(await a.act("cursor_position", {})).toBe("X=5, Y=6");
    dev.sent.length = 0;
    await a.act("type", { text: "hello" });
    await a.act("key", { text: "ctrl+a" });
    await a.act("scroll", { scroll_direction: "down", scroll_amount: 2 });
    expect(dev.sent.map((s) => [s.method, s.params.type ?? null])).toEqual([
      ["Input.insertText", null],
      ["Input.dispatchKeyEvent", "rawKeyDown"],
      ["Input.dispatchKeyEvent", "keyUp"],
      ["Input.dispatchMouseEvent", "mouseWheel"],
    ]);
    expect(dev.sent[1]?.params).toMatchObject({ key: "a", code: "KeyA", modifiers: 2 });
    expect(dev.sent[3]?.params).toMatchObject({ deltaX: 0, deltaY: 200 });
    await expect(a.act("launch", {})).rejects.toThrow(/unknown action/);
    await a.close();
    expect(released).toBe(1);
  });

  it("maps key names the way the toolset sends them", () => {
    expect(keyOf("Return")).toMatchObject({ key: "Enter", keyCode: 13, modifiers: 0, text: "\r" });
    expect(keyOf("shift+Tab")).toMatchObject({ key: "Tab", modifiers: 8 });
    expect(keyOf("ctrl+shift+t")).toMatchObject({ key: "t", code: "KeyT", modifiers: 10 });
    expect(keyOf("F5")).toMatchObject({ key: "F5", keyCode: 116 });
    expect(() => keyOf("hyper+x")).toThrow(/unknown modifier/);
    expect(() => keyOf("Florp")).toThrow(/unknown key/);
  });
});

const connectorOf = (service: string): ConnectorConfig => {
  const sv = registry().service(service);
  if (!sv) throw new Error(`no service ${service}`);
  return { registryKey: sv.connector, serviceKey: service, service: sv, settings: {}, baseUrl: "" };
};

describe("cloud browser sessions", () => {
  const cases = [
    {
      service: "browserbase",
      authed: (h: Record<string, string>) => h["x-bb-api-key"] === KEY,
      install: (f: FakeService) =>
        void f
          .on("POST", /^\/v1\/sessions$/, (r) => {
            expect(r.body).toMatchObject({
              browserSettings: { viewport: { width: 1280, height: 800 } },
              timeout: 660,
            });
            return {
              id: "bb1",
              status: "RUNNING",
              connectUrl: "wss://connect.browserbase.com/bb1?signingKey=x",
            };
          })
          .on("POST", /^\/v1\/sessions\/bb1$/, (r) => {
            expect(r.body).toEqual({ status: "REQUEST_RELEASE" });
            return { id: "bb1" };
          }),
      url: "wss://connect.browserbase.com/bb1?signingKey=x",
      release: /^\/v1\/sessions\/bb1$/,
    },
    {
      service: "steel",
      authed: (h: Record<string, string>) => h["steel-api-key"] === KEY,
      install: (f: FakeService) =>
        void f
          .on("POST", /^\/v1\/sessions$/, (r) => {
            expect(r.body).toMatchObject({ dimensions: { width: 1280, height: 800 }, timeout: 660_000 });
            return { id: "st1", status: "live", websocketUrl: "wss://connect.steel.dev?sessionId=st1" };
          })
          .on("POST", /^\/v1\/sessions\/st1\/release$/, () => ({ id: "st1", status: "released" })),
      url: `wss://connect.steel.dev/?sessionId=st1&apiKey=${KEY}`,
      release: /^\/v1\/sessions\/st1\/release$/,
    },
  ];

  for (const c of cases)
    it(`${c.service}: opens a session, then releases it and meters the seconds`, async () => {
      const f = new FakeService();
      c.install(f);
      const metered: Array<[number, string]> = [];
      const sv = registry().service(c.service);
      const provider = cloudBrowserProvider(
        { connector: connectorOf(c.service), usdPerUnit: sv?.pricing.usdPerUnit ?? null },
        { credential: secret(KEY), fetch: f.fetch, meter: (usd, note) => void metered.push([usd, note]) },
      );
      const s = await provider.session({
        width: 1280,
        height: 800,
        timeoutS: 660,
        signal: new AbortController().signal,
      });
      expect(s.url).toBe(c.url);
      await s.release();
      await s.release();
      expect(f.calls("POST", c.release)).toHaveLength(1);
      expect(metered).toHaveLength(1);
      expect(metered[0]?.[0]).toBeCloseTo(sv?.pricing.usdPerUnit ?? 0, 9);
      for (const r of f.requests) expect(c.authed(r.headers)).toBe(true);
      expect(ADAPTERS[c.service]?.key).toBe(c.service);
    });
});

describe("computer use picks its browser", () => {
  const input: RunInput = {
    ...helloInput(),
    contract: { ...helloInput().contract, inputs: [{ kind: "url", ref: "https://shop.example.com" }] },
  };
  const config = (browser?: string) => ({ options: browser ? { browser } : {} }) as unknown as AgentConfig;

  it("uses a cloud session when the agent asks for one, held to the task's sites", async () => {
    const dev = new FakeDevTools();
    const opened: string[] = [];
    const provider: CloudBrowserProvider = {
      vendor: "browserbase",
      session: async () => {
        opened.push("session");
        return { url: "wss://connect.example/s", release: async () => void opened.push("released") };
      },
    };
    const ctx = {
      tools: { browser: provider },
      signal: new AbortController().signal,
    } as unknown as RunContext;
    // The fake socket is injected through the global the CDP client uses by default.
    const original = globalThis.WebSocket;
    (globalThis as { WebSocket: unknown }).WebSocket = class {
      constructor(url: string) {
        // biome-ignore lint/correctness/noConstructorReturn: a fake socket stands in for the real one
        return dev.connect(url);
      }
    };
    try {
      const a = actuatorFor(ctx, input, config("cloud"));
      await a.open("https://shop.example.com", { width: 800, height: 600 });
      dev.push("Fetch.requestPaused", { requestId: "r", request: { url: "https://elsewhere.net/" } });
      await new Promise((r) => setTimeout(r, 5));
      expect(dev.sent.find((s) => s.method === "Fetch.failRequest")).toBeDefined();
      await a.close();
    } finally {
      (globalThis as { WebSocket: unknown }).WebSocket = original;
    }
    expect(opened).toEqual(["session", "released"]);
  });

  it("refuses a cloud agent in a workspace without a cloud browser", () => {
    const ctx = { tools: {}, signal: new AbortController().signal } as unknown as RunContext;
    expect(() => actuatorFor(ctx, input, config("cloud"))).toThrow(/has none/);
  });
});
