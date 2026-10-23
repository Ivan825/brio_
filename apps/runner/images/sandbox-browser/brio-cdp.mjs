// brio-cdp: one Chrome DevTools command against the sandbox's own browser (127.0.0.1:9222, never reachable from
// outside the container). Used by agents that act in page coordinates and observe the viewport (Nova Act).
//   observe                       → JSON {activeURL, browserDimensions, screenshotBase64 (JPEG q90 data URL), …}
//   click <x> <y> <left|left-double|right> | hover <x> <y> | scroll <up|down|left|right> <x> <y>
//   type <x> <y> <enter 0|1> <base64 text> | goto <url> | settle
const [cmd, ...args] = process.argv.slice(2);

async function page() {
  const targets = await (await fetch("http://127.0.0.1:9222/json/list")).json();
  const t = targets.find((x) => x.type === "page");
  if (!t) throw new Error("no page is open");
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error("cannot reach the browser"));
  });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result ?? {});
  };
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      pending.set(++id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  return { send, close: () => ws.close() };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const num = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`not a number: ${v}`);
  return n;
};

async function settle(p) {
  for (let i = 0; i < 50; i++) {
    const r = await p.send("Runtime.evaluate", { expression: "document.readyState", returnByValue: true });
    if (r.result?.value === "complete") break;
    await sleep(100);
  }
  await sleep(300);
}

async function click(p, x, y, button, count) {
  await p.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  for (let i = 1; i <= count; i++) {
    await p.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button, clickCount: i });
    await p.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button, clickCount: i });
  }
}

const p = await page();
try {
  switch (cmd) {
    case "observe": {
      const shot = await p.send("Page.captureScreenshot", { format: "jpeg", quality: 90 });
      const r = await p.send("Runtime.evaluate", {
        returnByValue: true,
        expression: `({activeURL: location.href, userAgent: navigator.userAgent, browserDimensions: {
          scrollHeight: document.documentElement.scrollHeight, scrollLeft: window.scrollX, scrollTop: window.scrollY,
          scrollWidth: document.documentElement.scrollWidth, windowHeight: window.innerHeight, windowWidth: window.innerWidth}})`,
      });
      const v = r.result?.value ?? {};
      process.stdout.write(
        JSON.stringify({
          activeURL: v.activeURL ?? "",
          browserDimensions: v.browserDimensions ?? {},
          idToBboxMap: {},
          screenshotBase64: `data:image/jpeg;base64,${shot.data}`,
          simplifiedDOM: "",
          timestamp_ms: Date.now(),
          userAgent: v.userAgent ?? "",
        }),
      );
      break;
    }
    case "click": {
      const kind = args[2] ?? "left";
      const button = kind === "right" ? "right" : "left";
      await click(p, num(args[0]), num(args[1]), button, kind === "left-double" ? 2 : 1);
      break;
    }
    case "hover":
      await p.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: num(args[0]), y: num(args[1]) });
      break;
    case "scroll": {
      const d = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] }[args[0]];
      if (!d) throw new Error("direction must be up, down, left or right");
      const r = await p.send("Runtime.evaluate", {
        expression: "[innerWidth, innerHeight]",
        returnByValue: true,
      });
      const [w, h] = r.result?.value ?? [800, 600];
      await p.send("Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x: num(args[1]),
        y: num(args[2]),
        deltaX: d[0] * w * 0.75,
        deltaY: d[1] * h * 0.75,
      });
      await sleep(300);
      break;
    }
    case "type": {
      await click(p, num(args[0]), num(args[1]), "left", 1);
      // Replace what the field holds, as a person selecting it and typing would.
      await p.send("Runtime.evaluate", {
        expression:
          "document.activeElement && document.activeElement.select && document.activeElement.select()",
      });
      await p.send("Input.insertText", { text: Buffer.from(args[3] ?? "", "base64").toString("utf8") });
      if (args[2] === "1") {
        const key = { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 };
        await p.send("Input.dispatchKeyEvent", { type: "keyDown", text: "\r", ...key });
        await p.send("Input.dispatchKeyEvent", { type: "keyUp", ...key });
      }
      break;
    }
    case "goto":
      if (!/^https?:\/\//.test(args[0] ?? "")) throw new Error("only http(s) URLs");
      await p.send("Page.navigate", { url: args[0] });
      await settle(p);
      break;
    case "settle":
      await settle(p);
      break;
    default:
      throw new Error(`unknown command ${cmd}`);
  }
} catch (e) {
  process.stderr.write(`${e.message}\n`);
  process.exitCode = 1;
} finally {
  p.close();
}
