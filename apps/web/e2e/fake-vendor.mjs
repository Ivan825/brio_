// A tiny OpenAI-compatible server for the browser tests, shaped like a LiteLLM proxy: it lists one model and answers
// every generation with a fixed text, usage, and the call's cost in LiteLLM's x-litellm-response-cost header.
import { createServer } from "node:http";

const port = Number(process.env.FAKE_VENDOR_PORT ?? 4300);
export const ANSWER = "Plan: add GET /health that returns {ok:true}, then a test for it.";

/** What the planner gets back: a one-task plan a person can approve. */
const PLAN = {
  tasks: [
    {
      key: "write.health-plan",
      type: "write.summary",
      title: "Write the health endpoint plan",
      contract: {
        objective: "Describe the health endpoint and its test",
        inputs: [],
        outputs: [{ kind: "report", description: "the plan" }],
        acceptance: [{ kind: "human", hard: true }],
        constraints: [],
        sensitivity: "internal",
      },
      dependsOn: [],
      suggestedMode: "single",
      estimate: { usd: 0.01, minutes: 1 },
    },
  ],
  assumptions: ["The API is a single service"],
  questions: [],
};

const json = (res, status, body, headers = {}) => {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
};

createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${port}`);
  if (req.method === "GET" && url.pathname === "/health") return json(res, 200, { ok: true });
  if (req.method === "GET" && url.pathname === "/v1/models")
    return json(res, 200, {
      object: "list",
      data: [{ id: "fake-model", created: 1760000000, owned_by: "e2e" }],
    });
  if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
    let body = "";
    req.on("data", (c) => {
      body += c;
    });
    req.on("end", () =>
      json(
        res,
        200,
        {
          id: "chatcmpl-e2e",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: body.includes("# Plan this mission")
                  ? `\`\`\`json\n${JSON.stringify(PLAN)}\n\`\`\``
                  : ANSWER,
              },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 1200, completion_tokens: 80 },
        },
        { "x-litellm-response-cost": "0.0042" },
      ),
    );
    return;
  }
  json(res, 404, { error: { message: `no route ${req.method} ${url.pathname}` } });
}).listen(port, "127.0.0.1");
