// Computer use on a cloud browser (docs/vendors/research-browser.md §13): a Browserbase or Steel session reached over
// the Chrome DevTools Protocol. Screenshots come from Page.captureScreenshot, input from Input.dispatch*, and the
// task's site allowlist is enforced inside the browser (Fetch interception fails every request to another host),
// since a cloud browser is not behind Brio's egress proxy. Session URLs can carry the key: they are never logged.
import { hostAllowed } from "@brio/core";
import type { Actuator, Screen } from "./actuator";

/** The part of a WebSocket the client needs (the global WebSocket in production, a fake in tests). */
export interface WsLike {
  send(data: string): void;
  close(): void;
  addEventListener(type: "message", fn: (e: { data: unknown }) => void): void;
  addEventListener(type: "open" | "close" | "error", fn: (e: unknown) => void): void;
}

export type Connect = (url: string) => WsLike;

const defaultConnect: Connect = (url) => new WebSocket(url) as unknown as WsLike;

type Pending = { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void };

/** A minimal CDP client over one browser-level connection with flattened page sessions. */
export class Cdp {
  private id = 0;
  private readonly pending = new Map<number, Pending>();
  private readonly handlers = new Map<
    string,
    Array<(params: Record<string, unknown>, sessionId?: string) => void>
  >();
  private closed: Error | null = null;

  private constructor(private readonly ws: WsLike) {
    ws.addEventListener("message", (e) => this.receive(String(e.data)));
    ws.addEventListener("close", () => this.fail(new Error("the browser connection closed")));
    ws.addEventListener("error", () => this.fail(new Error("the browser connection failed")));
  }

  static async open(url: string, connect: Connect = defaultConnect, timeoutMs = 30_000): Promise<Cdp> {
    const ws = connect(url);
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("the browser did not answer")), timeoutMs);
      ws.addEventListener("open", () => {
        clearTimeout(t);
        resolve();
      });
      ws.addEventListener("error", () => {
        clearTimeout(t);
        reject(new Error("cannot reach the browser"));
      });
    });
    return new Cdp(ws);
  }

  on(method: string, fn: (params: Record<string, unknown>, sessionId?: string) => void): void {
    this.handlers.set(method, [...(this.handlers.get(method) ?? []), fn]);
  }

  send<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
  ): Promise<T> {
    if (this.closed) return Promise.reject(this.closed);
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as Pending["resolve"], reject });
    });
  }

  close(): void {
    this.fail(new Error("closed"));
    try {
      this.ws.close();
    } catch {}
  }

  private fail(e: Error) {
    if (this.closed) return;
    this.closed = e;
    for (const p of this.pending.values()) p.reject(e);
    this.pending.clear();
  }

  private receive(raw: string) {
    let msg: {
      id?: number;
      method?: string;
      params?: Record<string, unknown>;
      result?: Record<string, unknown>;
      error?: { message?: string };
      sessionId?: string;
    };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.id !== undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message ?? "the browser refused"));
      else p.resolve(msg.result ?? {});
      return;
    }
    for (const fn of this.handlers.get(msg.method ?? "") ?? []) fn(msg.params ?? {}, msg.sessionId);
  }
}

/** xdotool-style key names to what Input.dispatchKeyEvent takes. */
const KEYS: Record<string, { key: string; code: string; keyCode: number; text?: string }> = {
  return: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  tab: { key: "Tab", code: "Tab", keyCode: 9 },
  backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  escape: { key: "Escape", code: "Escape", keyCode: 27 },
  esc: { key: "Escape", code: "Escape", keyCode: 27 },
  delete: { key: "Delete", code: "Delete", keyCode: 46 },
  space: { key: " ", code: "Space", keyCode: 32, text: " " },
  up: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  down: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  left: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  right: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  home: { key: "Home", code: "Home", keyCode: 36 },
  end: { key: "End", code: "End", keyCode: 35 },
  page_up: { key: "PageUp", code: "PageUp", keyCode: 33 },
  prior: { key: "PageUp", code: "PageUp", keyCode: 33 },
  page_down: { key: "PageDown", code: "PageDown", keyCode: 34 },
  next: { key: "PageDown", code: "PageDown", keyCode: 34 },
};
const MODIFIERS: Record<string, number> = {
  alt: 1,
  ctrl: 2,
  control: 2,
  super: 4,
  meta: 4,
  cmd: 4,
  shift: 8,
};

/** Splits "ctrl+shift+a" into the modifier bitmask and the key's dispatch fields. */
export function keyOf(combo: string): {
  modifiers: number;
  key: string;
  code: string;
  keyCode: number;
  text?: string;
} {
  const parts = combo
    .split("+")
    .map((p) => p.trim())
    .filter(Boolean);
  const last = parts.pop() ?? "";
  const modifiers = parts.reduce((m, p) => {
    const bit = MODIFIERS[p.toLowerCase()];
    if (bit === undefined) throw new Error(`unknown modifier ${p}`);
    return m | bit;
  }, 0);
  const named = KEYS[last.toLowerCase()];
  if (named) return { modifiers, ...named };
  const fn = /^f(\d{1,2})$/i.exec(last);
  if (fn) return { modifiers, key: `F${fn[1]}`, code: `F${fn[1]}`, keyCode: 111 + Number(fn[1]) };
  if (last.length === 1) {
    const upper = last.toUpperCase();
    const code = /[a-z]/i.test(last) ? `Key${upper}` : /\d/.test(last) ? `Digit${last}` : "";
    return {
      modifiers,
      key: last,
      code,
      keyCode: upper.charCodeAt(0),
      ...(modifiers & ~8 ? {} : { text: last }),
    };
  }
  throw new Error(`unknown key ${last}`);
}

const BUTTONS: Record<string, { button: "left" | "right" | "middle"; clicks: number }> = {
  left_click: { button: "left", clicks: 1 },
  right_click: { button: "right", clicks: 1 },
  middle_click: { button: "middle", clicks: 1 },
  double_click: { button: "left", clicks: 2 },
  triple_click: { button: "left", clicks: 3 },
};

const num = (v: unknown, what: string) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 100_000) throw new Error(`${what} must be a number`);
  return n;
};
const xy = (v: unknown, what = "coordinate"): [number, number] => {
  if (!Array.isArray(v) || v.length !== 2) throw new Error(`${what} must be [x, y]`);
  return [num(v[0], what), num(v[1], what)];
};

/** Computer use over CDP on an already created cloud session. `allow`: the task's sites (empty: nothing loads). */
export function cdpActuator(o: {
  url: string;
  allow: readonly string[];
  release: () => Promise<void>;
  connect?: Connect;
}): Actuator {
  let cdp: Cdp | null = null;
  let session = "";
  let mouse: [number, number] = [0, 0];
  const page = <T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}) => {
    if (!cdp) throw new Error("the browser is not open");
    return cdp.send<T>(method, params, session);
  };
  const mods = (text: unknown) => (typeof text === "string" && text ? keyOf(`${text}+a`).modifiers : 0);
  const mouseEvent = (type: string, x: number, y: number, extra: Record<string, unknown> = {}) =>
    page("Input.dispatchMouseEvent", { type, x, y, ...extra });
  const press = async (combo: string) => {
    const k = keyOf(combo);
    const base = { modifiers: k.modifiers, key: k.key, code: k.code, windowsVirtualKeyCode: k.keyCode };
    await page("Input.dispatchKeyEvent", {
      type: k.text ? "keyDown" : "rawKeyDown",
      ...base,
      ...(k.text ? { text: k.text } : {}),
    });
    await page("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  };

  return {
    async open(url, screen: Screen) {
      cdp = await Cdp.open(o.url, o.connect);
      const { targetInfos } = await cdp.send<{ targetInfos: Array<{ targetId: string; type: string }> }>(
        "Target.getTargets",
      );
      const existing = targetInfos.find((t) => t.type === "page")?.targetId;
      const targetId =
        existing ??
        (await cdp.send<{ targetId: string }>("Target.createTarget", { url: "about:blank" })).targetId;
      session = (await cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true }))
        .sessionId;
      // The allowlist, inside the browser: every request to another host fails.
      cdp.on("Fetch.requestPaused", (p, sid) => {
        let host = "";
        try {
          host = new URL(String((p.request as { url?: string })?.url ?? "")).hostname;
        } catch {}
        const ok =
          /^(data|blob|about):/.test(String((p.request as { url?: string })?.url ?? "")) ||
          hostAllowed(host, o.allow);
        void cdp
          ?.send(
            ok ? "Fetch.continueRequest" : "Fetch.failRequest",
            ok ? { requestId: p.requestId } : { requestId: p.requestId, errorReason: "BlockedByClient" },
            sid,
          )
          .catch(() => {});
      });
      await page("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
      await page("Emulation.setDeviceMetricsOverride", {
        width: screen.width,
        height: screen.height,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await page("Page.enable");
      if (url) await page("Page.navigate", { url });
    },
    async screenshot(region) {
      const clip = region
        ? {
            x: region[0],
            y: region[1],
            width: region[2] - region[0],
            height: region[3] - region[1],
            scale: 1,
          }
        : undefined;
      const r = await page<{ data: string }>("Page.captureScreenshot", {
        format: "png",
        ...(clip ? { clip } : {}),
      });
      return new Uint8Array(Buffer.from(r.data, "base64"));
    },
    async act(name, input) {
      const b = BUTTONS[name];
      if (b) {
        if (input.coordinate !== undefined) mouse = xy(input.coordinate);
        const modifiers = mods(input.text);
        await mouseEvent("mouseMoved", mouse[0], mouse[1], { modifiers });
        for (let i = 1; i <= b.clicks; i++) {
          await mouseEvent("mousePressed", mouse[0], mouse[1], {
            button: b.button,
            clickCount: i,
            modifiers,
          });
          await mouseEvent("mouseReleased", mouse[0], mouse[1], {
            button: b.button,
            clickCount: i,
            modifiers,
          });
        }
        return "OK";
      }
      switch (name) {
        case "mouse_move":
          mouse = xy(input.coordinate);
          await mouseEvent("mouseMoved", mouse[0], mouse[1]);
          return "OK";
        case "left_mouse_down":
          await mouseEvent("mousePressed", mouse[0], mouse[1], { button: "left", clickCount: 1 });
          return "OK";
        case "left_mouse_up":
          await mouseEvent("mouseReleased", mouse[0], mouse[1], { button: "left", clickCount: 1 });
          return "OK";
        case "left_click_drag": {
          const from = xy(input.start_coordinate, "start_coordinate");
          const to = xy(input.coordinate);
          await mouseEvent("mouseMoved", from[0], from[1]);
          await mouseEvent("mousePressed", from[0], from[1], { button: "left", clickCount: 1 });
          await mouseEvent("mouseMoved", to[0], to[1], { buttons: 1 });
          await mouseEvent("mouseReleased", to[0], to[1], { button: "left", clickCount: 1 });
          mouse = to;
          return "OK";
        }
        case "scroll": {
          if (input.coordinate !== undefined) mouse = xy(input.coordinate);
          const n = Math.max(1, Math.min(50, num(input.scroll_amount ?? 3, "scroll_amount")));
          const step = 100 * n;
          const d = String(input.scroll_direction);
          const delta = { up: [0, -step], down: [0, step], left: [-step, 0], right: [step, 0] }[d];
          if (!delta) throw new Error("scroll_direction must be up, down, left or right");
          await mouseEvent("mouseWheel", mouse[0], mouse[1], { deltaX: delta[0], deltaY: delta[1] });
          return "OK";
        }
        case "type":
          if (typeof input.text !== "string") throw new Error("text must be a string");
          await page("Input.insertText", { text: input.text });
          return "OK";
        case "key": {
          const combo = String(input.text ?? "");
          const n = Math.max(1, Math.min(100, num(input.repeat ?? 1, "repeat")));
          for (let i = 0; i < n; i++) await press(combo);
          return "OK";
        }
        case "hold_key": {
          const k = keyOf(String(input.text ?? ""));
          const base = { modifiers: k.modifiers, key: k.key, code: k.code, windowsVirtualKeyCode: k.keyCode };
          await page("Input.dispatchKeyEvent", { type: "rawKeyDown", ...base });
          await new Promise((r) => setTimeout(r, Math.min(300, num(input.duration ?? 1, "duration")) * 1000));
          await page("Input.dispatchKeyEvent", { type: "keyUp", ...base });
          return "OK";
        }
        case "wait":
          await new Promise((r) => setTimeout(r, Math.min(300, num(input.duration ?? 1, "duration")) * 1000));
          return "OK";
        case "cursor_position":
          return `X=${Math.round(mouse[0])}, Y=${Math.round(mouse[1])}`;
        default:
          throw new Error(`unknown action ${name}`);
      }
    },
    async close() {
      cdp?.close();
      cdp = null;
      await o.release();
    },
  };
}
