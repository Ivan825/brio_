// The hands for computer use (docs/vendors/research-browser.md §10): a browser on a virtual display inside the
// attempt's browser sandbox, driven with xdotool and seen with screenshots. The model only plans actions; they run
// here, in the sandbox, whose egress proxy lets the browser reach only the sites the task names.
import type { SandboxHandle } from "../../types";

export interface Screen {
  width: number;
  height: number;
}

/** Where computer-use actions run: the sandbox's display here, a cloud browser over CDP elsewhere. */
export interface Actuator {
  open(url: string | null, screen: Screen): Promise<void>;
  /** A PNG of the screen, or of a region [x0, y0, x1, y1]. */
  screenshot(region?: [number, number, number, number]): Promise<Uint8Array>;
  /** Runs one toolset member; returns its short text result. Throws when it cannot. */
  act(name: string, input: Record<string, unknown>): Promise<string>;
  close(): Promise<void>;
}

const DISPLAY = ":99";

/**
 * Keyboard input goes to the focused window, and there is no window manager to focus one on click: focus the newest
 * visible browser window (a popup it opened, else the main one) before typing.
 */
const FOCUS = "xdotool search --onlyvisible --class chromium | tail -1 | xargs -r xdotool windowfocus --sync";

const KEYBOARD = new Set(["type", "key", "hold_key"]);

/** Single-quotes a value for sh. */
/** Stops the browser and its display, and waits until both have exited (the next open may want another size). */
export const CLOSE_BROWSER =
  "pkill -x chromium; pkill -x Xvfb; i=0; while pgrep -x Xvfb >/dev/null || pgrep -x chromium >/dev/null; do i=$((i+1)); [ $i -gt 100 ] && break; sleep 0.1; done; rm -f /tmp/.X99-lock";

export const sh = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

const int = (v: unknown, what: string, max = 100_000): number => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > max)
    throw new Error(`${what} must be a number between 0 and ${max}`);
  return Math.round(n);
};

const point = (v: unknown, what = "coordinate"): [number, number] => {
  if (!Array.isArray(v) || v.length !== 2) throw new Error(`${what} must be [x, y]`);
  return [int(v[0], `${what}[0]`), int(v[1], `${what}[1]`)];
};

/** xdotool key names: "ctrl+s", "Return", "shift+Tab". Only names, plus and digits. */
const keys = (v: unknown): string => {
  if (typeof v !== "string" || !/^[A-Za-z0-9_+\- ]{1,64}$/.test(v)) throw new Error("not a key combination");
  return v.trim().replace(/\s+/g, "+");
};

/** Modifiers held during a click ("shift", "ctrl+alt"). */
const held = (v: unknown): string[] => (typeof v === "string" && v ? keys(v).split("+").filter(Boolean) : []);

const BUTTON: Record<string, number> = {
  left_click: 1,
  middle_click: 2,
  right_click: 3,
  double_click: 1,
  triple_click: 1,
};
const REPEAT: Record<string, number> = { double_click: 2, triple_click: 3 };
const WHEEL: Record<string, number> = { up: 4, down: 5, left: 6, right: 7 };

/**
 * The xdotool command line for one toolset member (screenshot, zoom and cursor_position are handled by the caller).
 * Pure, so every member's translation is tested.
 */
export function xdotool(name: string, input: Record<string, unknown>): string {
  const x = (args: string) => `xdotool ${args}`;
  const withMods = (mods: string[], cmd: string) =>
    mods.length ? `${x(`keydown ${mods.join(" ")}`)} && ${cmd} ; ${x(`keyup ${mods.join(" ")}`)}` : cmd;
  switch (name) {
    case "left_click":
    case "right_click":
    case "middle_click":
    case "double_click":
    case "triple_click": {
      const move = input.coordinate !== undefined ? `mousemove ${point(input.coordinate).join(" ")} ` : "";
      const repeat = REPEAT[name] ? `--repeat ${REPEAT[name]} --delay 80 ` : "";
      return withMods(held(input.text), x(`${move}click ${repeat}${BUTTON[name]}`));
    }
    case "left_click_drag": {
      const [sx, sy] = point(input.start_coordinate, "start_coordinate");
      const [ex, ey] = point(input.coordinate);
      return withMods(
        held(input.text),
        x(`mousemove ${sx} ${sy} mousedown 1 mousemove ${ex} ${ey} mouseup 1`),
      );
    }
    case "mouse_move":
      return x(`mousemove ${point(input.coordinate).join(" ")}`);
    case "left_mouse_down":
      return x("mousedown 1");
    case "left_mouse_up":
      return x("mouseup 1");
    case "scroll": {
      const dir = WHEEL[String(input.scroll_direction)];
      if (!dir) throw new Error("scroll_direction must be up, down, left or right");
      const n = Math.max(1, int(input.scroll_amount ?? 3, "scroll_amount", 50));
      const move = input.coordinate !== undefined ? `mousemove ${point(input.coordinate).join(" ")} ` : "";
      return withMods(held(input.text), x(`${move}click --repeat ${n} --delay 40 ${dir}`));
    }
    case "type": {
      if (typeof input.text !== "string") throw new Error("text must be a string");
      return x(`type --delay 12 -- ${sh(input.text)}`);
    }
    case "key": {
      const n = Math.max(1, int(input.repeat ?? 1, "repeat", 100));
      return x(`key --repeat ${n} --delay 40 -- ${keys(input.text)}`);
    }
    case "hold_key": {
      const k = keys(input.text);
      const s = int(input.duration ?? 1, "duration", 300);
      return `${x(`keydown ${k}`)} && sleep ${s} ; ${x(`keyup ${k}`)}`;
    }
    case "wait":
      return `sleep ${int(input.duration ?? 1, "duration", 300)}`;
    default:
      throw new Error(`unknown action ${name}`);
  }
}

/** The browser and display in the attempt's browser sandbox (image sandbox-browser, `brio-browser`). */
export function sandboxActuator(sandbox: SandboxHandle): Actuator {
  const run = async (cmd: string, timeoutMs = 60_000) => {
    const r = await sandbox.exec(`export DISPLAY=${DISPLAY}; ${cmd}`, { timeoutMs });
    if (r.exitCode !== 0) throw new Error((r.stderr || r.stdout).trim().slice(-300) || `exit ${r.exitCode}`);
    return r.stdout;
  };
  return {
    async open(url, screen) {
      if (!sandbox.available) throw new Error("computer use needs the browser sandbox");
      await run(
        `brio-browser ${int(screen.width, "width", 4000)} ${int(screen.height, "height", 4000)} ${url ? sh(url) : ""}`,
        90_000,
      );
    },
    async screenshot(region) {
      const crop = region
        ? ` -crop ${int(region[2] - region[0], "width")}x${int(region[3] - region[1], "height")}+${int(region[0], "x0")}+${int(region[1], "y0")}`
        : "";
      const b64 = await run(`import -silent -window root${crop} png:- | base64 | tr -d '\\n'`);
      return new Uint8Array(Buffer.from(b64.trim(), "base64"));
    },
    async act(name, input) {
      if (name === "cursor_position") {
        const out = await run("xdotool getmouselocation --shell");
        const x = /X=(\d+)/.exec(out)?.[1] ?? "0";
        const y = /Y=(\d+)/.exec(out)?.[1] ?? "0";
        return `X=${x}, Y=${y}`;
      }
      const seconds = name === "wait" || name === "hold_key" ? Number(input.duration ?? 1) : 0;
      const cmd = xdotool(name, input);
      await run(KEYBOARD.has(name) ? `${FOCUS} && ${cmd}` : cmd, (seconds + 30) * 1000);
      return "OK";
    },
    async close() {
      await sandbox.exec(CLOSE_BROWSER, { timeoutMs: 10_000 }).catch(() => {});
    },
  };
}
