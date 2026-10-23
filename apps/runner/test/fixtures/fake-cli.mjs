// A stand-in coding CLI for the runner's integration tests: reads its prompt on stdin, writes NDJSON events like the
// real CLIs do, edits the worktree (adds a function and its test) and reports usage and cost. FAKE_CLI_MODE selects
// misbehaviour: "slow" (runs until killed), "expensive" (reports a large cost), "leaky" (echoes its key).
import { readFileSync, writeFileSync } from "node:fs";

const mode = process.env.FAKE_CLI_MODE ?? "normal";
const prompt = readFileSync(0, "utf8");
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);

out({ type: "start", session: "fake-session-1", promptChars: prompt.length });
if (mode === "mailbox") {
  // Reach the Brio mailbox over MCP the way a real CLI would: streamable HTTP with the attempt's bearer token.
  const r = await fetch(process.env.MAILBOX_URL, {
    method: "POST",
    headers: {
      authorization: process.env.MAILBOX_AUTH,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "report_progress", arguments: { note: "hello from inside the sandbox" } },
    }),
  }).catch((e) => ({ status: `error ${e.message}`, text: async () => "" }));
  out({ type: "text", text: `mailbox answered ${r.status}: ${(await r.text()).slice(0, 200)}` });
}
if (mode === "leaky") out({ type: "text", text: `my key is ${process.env.FAKE_CLI_KEY}` });
out({ type: "tool", name: "edit", args: { path: "math.js" } });
writeFileSync("math.js", `${readFileSync("math.js", "utf8")}export const sub = (a, b) => a - b;\n`);
writeFileSync(
  "math.test.js",
  'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { sub } from "./math.js";\ntest("sub", () => assert.equal(sub(5, 3), 2));\n',
);
if (mode === "leaky") writeFileSync("config.txt", `token=${process.env.FAKE_CLI_KEY}\n`);
out({ type: "usage", input: 1000, output: 200, cost: mode === "expensive" ? 5 : 0.0123 });
if (mode === "slow") setInterval(() => out({ type: "text", text: "still working" }), 500);
else out({ type: "result", text: "Added sub() and a test.", cost: mode === "expensive" ? 5 : 0.0123 });
