// Claude Managed Agents (docs/vendors/hosted-agents.md §1): an agent and a cloud environment (found or created by name,
// reused), a session started with the task, events listed and de-duplicated by id, tool confirmations answered by a
// person, the list cost metered, and output files (a patch among them) read from the Files API.
import type { RunInput } from "../../types";
import type { ServiceClient } from "../client";
import { createJobAdapter, type JobQuestion, type JobUpdate } from "../job";
import { githubRepo, hostedCapabilities, hostedPrompt, isPatch, producedFile, textOf, utf8 } from "./common";

interface Job {
  sessionId: string;
  seen: string[];
  /** Tool-use event ids waiting for a confirmation. */
  pending: string[];
}

type Event = {
  id: string;
  type: string;
  content?: unknown;
  stop_reason?: { type?: string; event_ids?: string[] };
  name?: string;
  input?: unknown;
  usage?: unknown;
  error?: { message?: string; retry_status?: string };
};

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "agent";
const list = <T>(r: Record<string, unknown>): T[] => (Array.isArray(r.data) ? (r.data as T[]) : []);

async function ensureAgent(api: ServiceClient, name: string, model: string, system: string): Promise<string> {
  const found = list<{ id: string; name: string }>(
    await api.json("GET", "/agents", undefined, { query: { limit: 100 } }),
  );
  const mine = found.find((a) => a.name === name);
  if (mine) return mine.id;
  const made = await api.json<{ id: string }>("POST", "/agents", {
    name,
    model,
    system: system || undefined,
    tools: [{ type: "agent_toolset_20260401" }],
  });
  return made.id;
}

async function ensureEnvironment(api: ServiceClient, configured: string | undefined): Promise<string> {
  if (configured) return configured;
  const found = list<{ id: string; name: string }>(
    await api.json("GET", "/environments", undefined, { query: { limit: 100 } }),
  );
  const mine = found.find((e) => e.name === "brio");
  if (mine) return mine.id;
  const made = await api.json<{ id: string }>("POST", "/environments", {
    name: "brio",
    config: { type: "cloud", networking: { type: "limited", allow_package_managers: true } },
  });
  return made.id;
}

function sessionBody(input: RunInput, agentId: string, model: string, system: string, environmentId: string) {
  const repo = githubRepo(input);
  return {
    agent: { type: "agent_with_overrides", id: agentId, model: { id: model }, system: system || null },
    environment_id: environmentId,
    title: `Brio · ${input.taskTitle}`.slice(0, 200),
    ...(repo
      ? {
          resources: [
            {
              type: "github_repository",
              url: repo.url,
              mount_path: "/workspace/repo",
              checkout: { type: "branch", name: repo.branch },
            },
          ],
        }
      : {}),
    // The session stops itself at the attempt's cost limit (list cost, in cents).
    budget: {
      type: "limit",
      max_list_cost: {
        amount: String(Math.max(1, Math.floor(input.limits.maxCostUsd * 100))),
        currency: "USD",
      },
    },
    // The role is the agent's system prompt; the message carries the task.
    initial_events: [
      {
        type: "user.message",
        content: [{ type: "text", text: hostedPrompt(input, "/mnt/session/outputs") }],
      },
    ],
  };
}

export const claudeManagedAgents = createJobAdapter<Job>({
  key: "claude-managed-agents",
  route: "hosted",
  capabilities: hostedCapabilities({ browses: true }),
  estimateUsd: 1,
  pollMs: 3000,

  async start(input, config, api) {
    const agentId = await ensureAgent(api, `brio-${slug(config.name)}`, config.model, config.rolePrompt);
    const environmentId = await ensureEnvironment(api, config.connector.settings?.environmentId);
    const s = await api.json<{ id: string }>(
      "POST",
      "/sessions",
      sessionBody(input, agentId, config.model, config.rolePrompt, environmentId),
    );
    return { sessionId: s.id, seen: [], pending: [] };
  },

  idOf: (j) => j.sessionId,

  async poll(job, _config, api): Promise<JobUpdate<Job>> {
    const events = list<Event>(
      await api.json("GET", `/sessions/${job.sessionId}/events`, undefined, { query: { limit: 200 } }),
    );
    const seen = new Set(job.seen);
    const fresh = events.filter((e) => !seen.has(e.id));
    const messages: string[] = [];
    const progress: string[] = [];
    let usage: JobUpdate<Job>["usage"];
    let state: JobUpdate<Job>["state"] = "running";
    let question: JobQuestion | undefined;
    let error: string | undefined;
    const pending = [...job.pending];
    for (const e of fresh) {
      seen.add(e.id);
      if (e.type === "agent.message") {
        const t = textOf(e.content);
        if (t) messages.push(t);
      } else if (e.type === "agent.tool_use" || e.type === "agent.mcp_tool_use")
        progress.push(`tool: ${e.name ?? "?"}`);
      else if (e.type === "session.usage") usage = usageOf(e.usage ?? e);
      else if (e.type === "session.error" && e.error?.retry_status !== "retrying")
        error = e.error?.message ?? "the session failed";
      else if (e.type === "session.status_terminated") state = "failed";
      else if (e.type === "session.status_idle") {
        const why = e.stop_reason?.type;
        if (why === "end_turn") state = "done";
        else if (why === "budget_reached") {
          state = "failed";
          error = "the session reached its budget";
        } else if (why === "requires_action") {
          const ids = e.stop_reason?.event_ids ?? [];
          pending.splice(0, pending.length, ...ids);
          const uses = events.filter((x) => ids.includes(x.id));
          question = {
            id: ids.join(","),
            kind: "approval",
            text: uses.length
              ? uses
                  .map((u) => `${u.name ?? "a tool"} with ${JSON.stringify(u.input ?? {}).slice(0, 400)}`)
                  .join("; ")
              : "an action the agent wants to take",
          };
          state = "needs_input";
        }
      }
    }
    if (error && state === "running") state = "failed";
    return {
      job: { ...job, seen: [...seen], pending },
      state,
      messages,
      progress,
      ...(usage ? { usage } : {}),
      ...(question ? { question } : {}),
      ...(error ? { error } : {}),
    };
  },

  async answer(job, q, reply, api) {
    const ids = q.id.split(",").filter(Boolean);
    await api.json("POST", `/sessions/${job.sessionId}/events`, {
      events: ids.map((id) => ({
        type: "user.tool_confirmation",
        tool_use_id: id,
        result: reply.approve ? "allow" : "deny",
      })),
    });
    return { ...job, pending: [] };
  },

  async cancel(job, api) {
    await api.json("POST", `/sessions/${job.sessionId}/events`, { events: [{ type: "user.interrupt" }] });
  },

  async outputs(job, _config, api) {
    // Files can take a few seconds after the session idles to appear.
    let files: Array<{ id: string; filename?: string; name?: string; mime_type?: string }> = [];
    for (let i = 0; i < 4; i++) {
      files = list(
        await api.json("GET", "/files", undefined, { query: { scope_id: job.sessionId, limit: 100 } }),
      );
      if (files.length) break;
      await new Promise((r) => setTimeout(r, 1500));
    }
    let patch: string | undefined;
    const produced = [];
    for (const f of files.slice(0, 20)) {
      const name = f.filename ?? f.name ?? f.id;
      const { bytes, contentType } = await api.bytes(`/files/${f.id}/content`);
      if (isPatch(name)) patch = utf8(bytes);
      else produced.push(producedFile(name, f.mime_type ?? contentType, bytes));
    }
    return { text: "", files: produced, ...(patch ? { patch } : {}) };
  },
});

function usageOf(u: unknown): JobUpdate<Job>["usage"] {
  const x = (u ?? {}) as {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    list_cost?: { amount?: string };
  };
  const cents = Number(x.list_cost?.amount);
  if (!Number.isFinite(cents) && x.input_tokens === undefined) return undefined;
  return {
    ...(Number.isFinite(cents) ? { usd: cents / 100 } : {}),
    ...(x.input_tokens !== undefined ? { tokensIn: x.input_tokens + (x.cache_read_input_tokens ?? 0) } : {}),
    ...(x.output_tokens !== undefined ? { tokensOut: x.output_tokens } : {}),
    ...(x.cache_read_input_tokens !== undefined ? { cachedTokensIn: x.cache_read_input_tokens } : {}),
  };
}
