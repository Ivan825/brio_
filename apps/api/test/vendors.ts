// A scripted multi-vendor stand-in for orchestration tests: OpenAI (Responses) and Anthropic (Messages) endpoints whose
// replies are chosen by a script per request, so a whole mission (planning, contract, two coders in parallel, docs)
// runs deterministically without keys.

type Obj = Record<string, unknown>;

export interface ToolUse {
  name: string;
  args: Record<string, unknown>;
}

/** What the script returns for one model call: tool calls, or a final answer. */
export type Reply = { tools: ToolUse[] } | { text: string };

export interface CallInfo {
  vendor: "openai" | "anthropic";
  model: string;
  /** The whole request body as text: prompts, previous turns, tool results. */
  body: string;
  /** How many calls this conversation has made so far (1 for the first). */
  turn: number;
}

export type Script = (call: CallInfo) => Reply | Promise<Reply>;

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

/** A web page the scripted internet serves (for link checks and fact checks). */
export interface Page {
  status?: number;
  body?: string;
  type?: string;
  /** A redirect target (status defaults to 301). */
  location?: string;
}

export class ScriptedVendors {
  readonly calls: CallInfo[] = [];
  /** Every web request that was not a vendor call: method and URL. */
  readonly visits: string[] = [];
  constructor(
    private readonly script: Script,
    private readonly pages: Record<string, Page> = {},
  ) {}

  readonly fetch = async (input: string | URL, init: RequestInit = {}): Promise<Response> => {
    const url = String(input);
    const method = init.method ?? "GET";
    const page = this.pages[url];
    if (page) {
      this.visits.push(`${method} ${url}`);
      if (page.location)
        return new Response(null, { status: page.status ?? 301, headers: { location: page.location } });
      return new Response(method === "HEAD" ? null : (page.body ?? ""), {
        status: page.status ?? 200,
        headers: { "content-type": page.type ?? "text/html; charset=utf-8" },
      });
    }
    if (method === "GET" || method === "HEAD") {
      if (url.startsWith("https://api.openai.com/v1/models"))
        return json({ data: [{ id: "gpt-coder" }, { id: "planner" }] });
      if (url.startsWith("https://api.anthropic.com/v1/models"))
        return json({ data: [{ id: "claude-writer" }], has_more: false });
      if (!url.startsWith("https://api.")) this.visits.push(`${method} ${url}`);
      return new Response("{}", { status: 404 });
    }
    const body = typeof init.body === "string" ? init.body : "";
    const req = JSON.parse(body || "{}") as Obj;
    const vendor = url.includes("anthropic") ? "anthropic" : "openai";
    const turn =
      vendor === "anthropic"
        ? Math.ceil(((req.messages as unknown[]) ?? []).length / 2)
        : 1 + ((req.input as Obj[]) ?? []).filter((i) => i.type === "function_call_output").length;
    const call: CallInfo = { vendor, model: String(req.model), body, turn };
    this.calls.push(call);
    const reply = await this.script(call);
    const usage = { input: 1000, output: 100 };
    if (vendor === "anthropic") {
      const content =
        "text" in reply
          ? [{ type: "text", text: reply.text }]
          : reply.tools.map((t, i) => ({
              type: "tool_use",
              id: `toolu_${turn}_${i}`,
              name: t.name,
              input: t.args,
            }));
      return json({
        id: `msg_${turn}`,
        type: "message",
        role: "assistant",
        content,
        stop_reason: "text" in reply ? "end_turn" : "tool_use",
        usage: {
          input_tokens: usage.input,
          output_tokens: usage.output,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      });
    }
    const output =
      "text" in reply
        ? [{ type: "message", role: "assistant", content: [{ type: "output_text", text: reply.text }] }]
        : reply.tools.map((t, i) => ({
            type: "function_call",
            call_id: `call_${turn}_${i}`,
            name: t.name,
            arguments: JSON.stringify(t.args),
          }));
    return json({
      id: `resp_${turn}`,
      status: "completed",
      output,
      usage: {
        input_tokens: usage.input,
        output_tokens: usage.output,
        input_tokens_details: { cached_tokens: 0 },
      },
    });
  };
}

/** The title of the task a request is for (the rendered instructions start with "# Task: <title>"). */
export const taskTitle = (body: string) => /# Task: ([^\\\n]+)/.exec(body)?.[1]?.trim() ?? null;
