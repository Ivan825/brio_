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

/** For the M8 acceptance mission ("Ship the health file"): one code task, checked by a command, on a repository. */
const CODE_PLAN = {
  tasks: [
    {
      key: "health-file",
      type: "code.feature",
      title: "Add the health file",
      contract: {
        objective: "Add health.txt that says ok",
        inputs: [],
        outputs: [{ kind: "diff", description: "health.txt" }],
        acceptance: [{ kind: "tests", command: "test -f health.txt", hard: true }],
        constraints: [],
        expectedFootprint: { paths: ["health.txt"] },
        sensitivity: "internal",
      },
      dependsOn: [],
      suggestedMode: "single",
      estimate: { usd: 0.01, minutes: 1 },
    },
  ],
  assumptions: [],
  questions: [],
};

/** For the M9 acceptance ("Confidential report"): one task whose data may only go where policy allows. */
const CONFIDENTIAL_PLAN = {
  tasks: [
    {
      key: "salary-summary",
      type: "write.summary",
      title: "Summarise the salary bands",
      contract: {
        objective: "Summarise the salary bands for the board",
        inputs: [],
        outputs: [{ kind: "report", description: "the summary" }],
        acceptance: [{ kind: "human", hard: true }],
        constraints: [],
        sensitivity: "confidential",
      },
      dependsOn: [],
      suggestedMode: "single",
      estimate: { usd: 0.01, minutes: 1 },
    },
  ],
  assumptions: [],
  questions: [],
};

/** Pull requests opened through the fake GitHub API (the runner's BRIO_GITHUB_API_URL points here in e2e). */
let pulls = 0;

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
    req.on("end", () => {
      const planning = body.includes("# Plan this mission");
      const plan = body.includes("Ship the health file")
        ? CODE_PLAN
        : body.includes("Confidential report")
          ? CONFIDENTIAL_PLAN
          : PLAN;
      // The coder's first turn writes the file; once the tool result is back it answers.
      const coding = !planning && body.includes("health.txt that says ok") && !body.includes('"role":"tool"');
      const message = coding
        ? {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call-1",
                type: "function",
                function: {
                  name: "write_file",
                  arguments: JSON.stringify({ path: "health.txt", content: "ok\n" }),
                },
              },
            ],
          }
        : {
            role: "assistant",
            content: planning ? `\`\`\`json\n${JSON.stringify(plan)}\n\`\`\`` : ANSWER,
          };
      json(
        res,
        200,
        {
          id: "chatcmpl-e2e",
          choices: [{ index: 0, message, finish_reason: coding ? "tool_calls" : "stop" }],
          usage: { prompt_tokens: 1200, completion_tokens: 80 },
        },
        { "x-litellm-response-cost": "0.0042" },
      );
    });
    return;
  }
  const pull = /^\/repos\/([^/]+)\/([^/]+)\/pulls$/.exec(url.pathname);
  if (req.method === "POST" && pull) {
    pulls++;
    return json(res, 201, {
      html_url: `https://github.com/${pull[1]}/${pull[2]}/pull/${pulls}`,
      number: pulls,
    });
  }
  json(res, 404, { error: { message: `no route ${req.method} ${url.pathname}` } });
}).listen(port, "127.0.0.1");
