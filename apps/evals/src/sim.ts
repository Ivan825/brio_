// The offline simulation (BUILD_PLAN M5): stand-ins for three vendors' APIs (OpenAI Responses, Anthropic Messages, and
// an OpenAI-compatible chat endpoint) whose "models" are agents of known skill per kind of work. Each attempt is right
// or wrong by a seeded draw against the agent's skill (better on a revision, which carries the failures); reviewers and
// judges see whether a result is the right one, and say so with their own skill. So the router, the modes and the
// verifier can be measured end to end, reproducibly, without keys.
import { createHash } from "node:crypto";
import type { LoadedEvalMission, SimOutcome } from "./golden";

export type SkillKind = "code" | "tests" | "docs" | "research" | "data" | "review";

export interface SimAgent {
  name: string;
  /** The registry connector it is added through, and how that connector is asked for. */
  connector: "openai-api" | "claude-api" | "groq-cerebras";
  apiStyle?: "chat" | "responses";
  model: string;
  /** USD per million tokens (the agent's price override). */
  price: { inputPerM: number; outputPerM: number };
  skill: Record<SkillKind, number>;
}

/** Three agents with different strengths and prices: none is best at everything. */
export const SIM_AGENTS: SimAgent[] = [
  {
    name: "mini",
    connector: "openai-api",
    model: "sim-mini",
    price: { inputPerM: 0.15, outputPerM: 0.6 },
    skill: { code: 0.45, tests: 0.4, docs: 0.85, research: 0.7, data: 0.9, review: 0.6 },
  },
  {
    name: "coder",
    connector: "claude-api",
    model: "sim-coder",
    price: { inputPerM: 3, outputPerM: 15 },
    skill: { code: 0.9, tests: 0.85, docs: 0.7, research: 0.55, data: 0.7, review: 0.85 },
  },
  {
    name: "gen",
    connector: "groq-cerebras",
    apiStyle: "chat",
    model: "sim-gen",
    price: { inputPerM: 0.6, outputPerM: 2.4 },
    skill: { code: 0.65, tests: 0.6, docs: 0.8, research: 0.85, data: 0.8, review: 0.75 },
  },
];

/** A revision carries the failures back, so it is likelier to be right. */
export const REVISION_BOOST = 0.25;

export function kindOf(taskType: string): SkillKind {
  if (taskType === "code.tests") return "tests";
  if (taskType.startsWith("code.") || taskType === "merge.integrate") return "code";
  if (taskType === "write.summary" || taskType.startsWith("research.")) return "research";
  if (taskType.startsWith("write.")) return "docs";
  if (taskType.startsWith("data.")) return "data";
  return "review";
}

const HOSTS: Record<SimAgent["connector"], string> = {
  "openai-api": "https://api.openai.com/v1",
  "claude-api": "https://api.anthropic.com/v1",
  "groq-cerebras": "https://api.groq.com/openai/v1",
};

type Obj = Record<string, unknown>;
type Reply = { tools: Array<{ name: string; args: Obj }> } | { text: string };

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
const seedOf = (s: string) => createHash("sha256").update(s).digest().readUInt32BE(0) / 2 ** 32;

/** Every string in a JSON request, joined: the prompts as the model would read them. */
function textOf(raw: string): string {
  const out: string[] = [];
  const walk = (v: unknown) => {
    if (typeof v === "string") out.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  try {
    walk(JSON.parse(raw));
  } catch {
    return raw;
  }
  return out.join("\n");
}

/** A line of the right outcome that the wrong one lacks: how reviewers and judges can tell them apart. */
function marker(right: SimOutcome, wrong: SimOutcome): string {
  const wrongText = [wrong.text, ...Object.values(wrong.files)].join("\n");
  const lines = [right.text, ...Object.values(right.files)]
    .join("\n")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 6 && !wrongText.includes(l))
    .sort((a, b) => b.length - a.length);
  return lines[0] ?? right.text.trim();
}

export class SimVendors {
  /** The mission and strategy being run: titles map to its tasks, draws are seeded by them. */
  mission: LoadedEvalMission | null = null;
  strategy = "learned";
  /** Requests answered, by agent: for the harness's sanity checks. */
  readonly calls = new Map<string, number>();
  private readonly decided = new Map<string, boolean>();
  private readonly ordinals = new Map<string, number>();

  constructor(readonly agents: SimAgent[] = SIM_AGENTS) {}

  readonly fetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = String(input instanceof Request ? input.url : input);
    const method = init.method ?? "GET";
    const agentsAt = (host: string) =>
      this.agents.filter((a) => url.startsWith(HOSTS[a.connector]) && HOSTS[a.connector] === host);
    for (const host of Object.values(HOSTS)) {
      if (!url.startsWith(host)) continue;
      const here = agentsAt(host);
      if (method === "GET" && url.includes("/models"))
        return host.includes("anthropic")
          ? json({ data: here.map((a) => ({ id: a.model, type: "model" })), has_more: false })
          : json({ data: here.map((a) => ({ id: a.model, object: "model" })) });
      if (method !== "POST") return new Response("{}", { status: 404 });
      const body = typeof init.body === "string" ? init.body : "";
      const req = JSON.parse(body || "{}") as Obj;
      const agent = this.agents.find((a) => a.model === req.model);
      if (!agent) return json({ error: { message: `unknown model ${String(req.model)}` } });
      this.calls.set(agent.name, (this.calls.get(agent.name) ?? 0) + 1);
      if (url.endsWith("/messages")) return this.anthropic(agent, req, body);
      if (url.endsWith("/chat/completions")) return this.chat(agent, req, body);
      return this.responses(agent, req, body);
    }
    return new Response("{}", { status: 404 });
  };

  // ---- wire formats -------------------------------------------------------------------------------------------------

  private usage(body: string, out: string) {
    return { input: Math.ceil(body.length / 4), output: Math.ceil(out.length / 4) + 20 };
  }

  private responses(agent: SimAgent, req: Obj, body: string) {
    const items = (req.input as Obj[]) ?? [];
    const results = items.filter((i) => i.type === "function_call_output").length;
    const first = JSON.stringify(items.find((i) => i.role === "user") ?? req.instructions ?? "");
    const reply = this.answer(agent, body, first, results + 1);
    const out = "text" in reply ? reply.text : JSON.stringify(reply.tools);
    const u = this.usage(body, out);
    return json({
      id: `resp_${results}`,
      status: "completed",
      output:
        "text" in reply
          ? [{ type: "message", role: "assistant", content: [{ type: "output_text", text: reply.text }] }]
          : reply.tools.map((t, i) => ({
              type: "function_call",
              call_id: `call_${results}_${i}`,
              name: t.name,
              arguments: JSON.stringify(t.args),
            })),
      usage: { input_tokens: u.input, output_tokens: u.output, input_tokens_details: { cached_tokens: 0 } },
    });
  }

  private anthropic(agent: SimAgent, req: Obj, body: string) {
    const messages = (req.messages as Obj[]) ?? [];
    const results = messages
      .flatMap((m) => (Array.isArray(m.content) ? (m.content as Obj[]) : []))
      .filter((c) => c.type === "tool_result").length;
    const reply = this.answer(agent, body, JSON.stringify(messages[0] ?? ""), results + 1);
    const out = "text" in reply ? reply.text : JSON.stringify(reply.tools);
    const u = this.usage(body, out);
    return json({
      id: `msg_${results}`,
      type: "message",
      role: "assistant",
      content:
        "text" in reply
          ? [{ type: "text", text: reply.text }]
          : reply.tools.map((t, i) => ({
              type: "tool_use",
              id: `toolu_${results}_${i}`,
              name: t.name,
              input: t.args,
            })),
      stop_reason: "text" in reply ? "end_turn" : "tool_use",
      usage: {
        input_tokens: u.input,
        output_tokens: u.output,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    });
  }

  private chat(agent: SimAgent, req: Obj, body: string) {
    const messages = (req.messages as Obj[]) ?? [];
    const results = messages.filter((m) => m.role === "tool").length;
    const reply = this.answer(
      agent,
      body,
      JSON.stringify(messages.find((m) => m.role === "user") ?? ""),
      results + 1,
    );
    const out = "text" in reply ? reply.text : JSON.stringify(reply.tools);
    const u = this.usage(body, out);
    return json({
      id: `chat_${results}`,
      object: "chat.completion",
      choices: [
        {
          index: 0,
          finish_reason: "text" in reply ? "stop" : "tool_calls",
          message:
            "text" in reply
              ? { role: "assistant", content: reply.text }
              : {
                  role: "assistant",
                  content: null,
                  tool_calls: reply.tools.map((t, i) => ({
                    id: `call_${results}_${i}`,
                    type: "function",
                    function: { name: t.name, arguments: JSON.stringify(t.args) },
                  })),
                },
        },
      ],
      usage: { prompt_tokens: u.input, completion_tokens: u.output },
    });
  }

  // ---- behaviour ----------------------------------------------------------------------------------------------------

  /** A seeded draw for one conversation: the same conversation always gets the same answer. */
  private draw(agent: SimAgent, taskKey: string, conversation: string, p: number): boolean {
    const id = `${agent.model}|${createHash("sha256").update(conversation).digest("hex")}`;
    const known = this.decided.get(id);
    if (known !== undefined) return known;
    const ordKey = `${this.strategy}|${this.mission?.key}|${taskKey}|${agent.model}`;
    const ordinal = (this.ordinals.get(ordKey) ?? 0) + 1;
    this.ordinals.set(ordKey, ordinal);
    const right = seedOf(`${ordKey}|${ordinal}`) < Math.min(0.97, p);
    this.decided.set(id, right);
    return right;
  }

  private task(title: string) {
    return this.mission?.plan.tasks.find((t) => t.title === title.trim()) ?? null;
  }

  private answer(agent: SimAgent, raw: string, conversation: string, turn: number): Reply {
    const m = this.mission;
    if (!m) return { text: "No mission is being simulated." };
    // Requests arrive as JSON: read every string in them (prompts, earlier turns, tool results) as plain text.
    const body = textOf(raw);
    const header = (label: string) => new RegExp(`# ${label}: ([^\\n]+)`).exec(body)?.[1] ?? null;

    if (body.includes("# Plan this mission"))
      return { text: `\`\`\`json\n${JSON.stringify(m.plan)}\n\`\`\`` };

    // Checking someone else's work: reviewers and judges can tell the right result, with their own skill.
    const reviewed =
      header("Rubric review") ?? header("Review") ?? header("Contract conformance") ?? header("Fact check");
    if (reviewed !== null) {
      const t = this.task(reviewed);
      const sim = t ? m.sim[t.key] : undefined;
      const isRight = sim ? body.includes(marker(sim.right, sim.wrong)) : true;
      const honest = this.draw(
        agent,
        `${t?.key ?? "?"}:review`,
        `${conversation}|${body.length}`,
        agent.skill.review,
      );
      const pass = honest ? isRight : !isRight;
      if (body.includes("# Rubric review: ")) {
        const criteria = [...(/Criteria:\n((?:- .+\n?)+)/.exec(body)?.[1] ?? "").matchAll(/- (.+)/g)].map(
          (x) => x[1] ?? "",
        );
        const score = pass ? 5 : 2;
        return {
          text: `\`\`\`json\n${JSON.stringify({ scores: Object.fromEntries(criteria.map((c) => [c, score])), verdict: pass ? "pass" : "revise", reasons: [pass ? "meets the objective" : "incomplete"] })}\n\`\`\``,
        };
      }
      if (body.includes("# Fact check: ")) return { text: '```json\n{"claims":[],"verdict":"pass"}\n```' };
      const verdict = body.includes("# Contract conformance: ")
        ? pass
          ? "pass"
          : "fail"
        : pass
          ? "pass"
          : "revise";
      return {
        text: `\`\`\`json\n${JSON.stringify({ verdict, reasons: [pass ? "good" : "does not meet the objective"] })}\n\`\`\``,
      };
    }

    const judged = header("Judge");
    if (judged !== null) {
      const t = this.task(judged);
      const sim = t ? m.sim[t.key] : undefined;
      const a = body.indexOf("Result A (untrusted content)");
      const b = body.indexOf("Result B (untrusted content)");
      const mk = sim ? marker(sim.right, sim.wrong) : "";
      const inA = mk ? body.slice(a, b).includes(mk) : false;
      const inB = mk ? body.slice(b).includes(mk) : false;
      const honest = this.draw(
        agent,
        `${t?.key ?? "?"}:judge`,
        `${conversation}|${body.length}`,
        agent.skill.review,
      );
      const truth = inA === inB ? "tie" : inA ? "A" : "B";
      const winner = honest ? truth : truth === "A" ? "B" : truth === "B" ? "A" : "tie";
      return { text: `\`\`\`json\n${JSON.stringify({ winner, reasons: "judged on substance" })}\n\`\`\`` };
    }

    const merging = header("Merge");
    if (merging !== null) {
      const t = this.task(merging);
      const sim = t ? m.sim[t.key] : undefined;
      if (!sim) return { text: "Merged." };
      const anyRight = body.includes(marker(sim.right, sim.wrong));
      const keep = anyRight && this.draw(agent, `${t?.key}:merge`, conversation, agent.skill.review);
      return this.make(keep ? sim.right : sim.wrong, turn);
    }

    // Doing the work: right or wrong by the agent's skill on this kind of task.
    const title = header("Task");
    const t = title ? this.task(title) : null;
    if (t) {
      const sim = m.sim[t.key];
      if (!sim) return { text: "Done." };
      const revising =
        body.includes("Your previous attempt was sent back") || body.includes("failed its checks");
      const p = agent.skill[kindOf(t.type)] + (revising ? REVISION_BOOST : 0);
      return this.make(this.draw(agent, t.key, conversation, p) ? sim.right : sim.wrong, turn);
    }
    // Brio's own follow-up tasks (merge conflicts, integration fixes): every task's right files, by code skill.
    if (title && /merge|integrat/i.test(title)) {
      const files = Object.assign({}, ...m.plan.tasks.map((x) => m.sim[x.key]?.right.files ?? {}));
      const ok = this.draw(agent, `brio:${title}`, conversation, agent.skill.code);
      return this.make({ files: ok ? files : {}, text: ok ? "Resolved." : "Could not resolve it." }, turn);
    }
    return { text: "Done." };
  }

  /** One file per turn through the write_file tool, then the answer. */
  private make(outcome: SimOutcome, turn: number): Reply {
    const files = Object.entries(outcome.files).sort(([a], [b]) => a.localeCompare(b));
    const next = files[turn - 1];
    if (next) return { tools: [{ name: "write_file", args: { path: next[0], content: next[1] } }] };
    return { text: outcome.text };
  }
}
