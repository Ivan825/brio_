// A tiny OpenAI-compatible server for the browser tests, shaped like a LiteLLM proxy: it lists one model and answers
// every generation with a fixed text, usage, and the call's cost in LiteLLM's x-litellm-response-cost header.
import { createServer } from "node:http";

const port = Number(process.env.FAKE_VENDOR_PORT ?? 4300);
export const ANSWER = "Plan: add GET /health that returns {ok:true}, then a test for it.";

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
    req.resume();
    req.on("end", () =>
      json(
        res,
        200,
        {
          id: "chatcmpl-e2e",
          choices: [{ index: 0, message: { role: "assistant", content: ANSWER }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1200, completion_tokens: 80 },
        },
        { "x-litellm-response-cost": "0.0042" },
      ),
    );
    return;
  }
  json(res, 404, { error: { message: `no route ${req.method} ${url.pathname}` } });
}).listen(port, "127.0.0.1");
