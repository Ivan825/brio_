// OpenAI Agents API hosted sessions (docs/vendors/hosted-agents.md §2): a session with an inline agent in an
// OpenAI-hosted environment, its status and items followed, browser site-access approvals put to a person (sign-in
// requests are always declined: agents never type credentials), token usage metered, and files under
// /workspace/outputs collected as artifacts (a patch among them).
import type { ServiceClient } from "../client";
import { createJobAdapter, type JobUpdate } from "../job";
import { githubRepo, hostedCapabilities, hostedPrompt, isPatch, producedFile, textOf, utf8 } from "./common";

interface Job {
  sessionId: string;
  seenItems: string[];
  /** Becomes true once a turn has started, so an idle session is not mistaken for a finished one. */
  started: boolean;
}

type Session = {
  id: string;
  status?: "idle" | "in_progress" | "requires_action" | "failed";
  required_actions?: Array<{
    type: string;
    request_id?: string;
    turn_id?: string;
    call_id?: string;
    name?: string;
    request?: { type?: string; origin?: string; url?: string };
  }>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    input_tokens_details?: { cached_tokens?: number };
  };
  last_error?: { message?: string };
};
type Item = { id: string; type?: string; role?: string; content?: unknown };
const data = <T>(r: Record<string, unknown>): T[] => (Array.isArray(r.data) ? (r.data as T[]) : []);

async function latestTurn(api: ServiceClient, id: string) {
  const turns = data<{ status?: string; subagent_id?: string | null; error?: { message?: string } }>(
    await api.json("GET", `/agents/sessions/${id}/turns`, undefined, { query: { order: "desc", limit: 5 } }),
  );
  return turns.find((t) => !t.subagent_id);
}

export const openaiAgents = createJobAdapter<Job>({
  key: "openai-agents",
  route: "hosted",
  capabilities: hostedCapabilities({ browses: true }),
  estimateUsd: 1,
  pollMs: 3000,

  async start(input, config, api) {
    const repo = githubRepo(input);
    const s = await api.json<Session>("POST", "/agents/sessions", {
      agent: {
        model: config.model,
        instructions: config.rolePrompt || undefined,
        ...(config.options?.agent as object),
      },
      // The repository is cloned by the agent itself, so it needs the network then.
      environment: { type: "openai_hosted", ...(repo ? { network: { access: "enabled" } } : {}) },
      input: hostedPrompt(input, "/workspace/outputs"),
      stream: false,
    });
    return { sessionId: s.id, seenItems: [], started: false };
  },

  idOf: (j) => j.sessionId,

  async poll(job, _config, api): Promise<JobUpdate<Job>> {
    const s = await api.json<Session>("GET", `/agents/sessions/${job.sessionId}`);
    const items = data<Item>(
      await api.json("GET", `/agents/sessions/${job.sessionId}/items`, undefined, {
        query: { order: "asc", limit: 100 },
      }),
    );
    const seen = new Set(job.seenItems);
    const messages = items
      .filter((i) => !seen.has(i.id) && i.type === "message" && i.role === "assistant")
      .map((i) => textOf(i.content))
      .filter(Boolean);
    for (const i of items) seen.add(i.id);
    const u = s.usage;
    const usage = u
      ? {
          tokensIn: u.input_tokens ?? 0,
          tokensOut: u.output_tokens ?? 0,
          cachedTokensIn: u.input_tokens_details?.cached_tokens ?? 0,
        }
      : undefined;
    const next = { ...job, seenItems: [...seen], started: job.started || s.status !== "idle" };
    const base = { job: next, messages, ...(usage ? { usage } : {}) };
    if (s.status === "failed")
      return { ...base, state: "failed", error: s.last_error?.message ?? "the session failed" };
    if (s.status === "requires_action") {
      const a = s.required_actions?.[0];
      if (a?.type === "computer_use_approval_request" && a.request_id)
        return {
          ...base,
          state: "needs_input",
          question: {
            id: `${a.request_id}|${a.request?.type ?? ""}`,
            kind: "approval",
            text:
              a.request?.type === "browser_authentication"
                ? `the agent's browser wants to sign in at ${a.request.origin ?? a.request.url ?? "a site"} (Brio never types credentials; this is declined)`
                : `the agent's browser wants to open ${a.request?.origin ?? a.request?.url ?? "a new site"}`,
          },
        };
      return {
        ...base,
        state: "failed",
        error: `the session asked for something Brio cannot provide (${a?.type ?? "unknown"})`,
      };
    }
    if (s.status === "idle") {
      const turn = await latestTurn(api, job.sessionId);
      if (turn?.status === "completed") return { ...base, state: "done" };
      if (turn?.status === "failed")
        return { ...base, state: "failed", error: turn.error?.message ?? "the turn failed" };
      if (turn?.status === "cancelled") return { ...base, state: "cancelled" };
    }
    return { ...base, state: "running" };
  },

  async answer(job, q, reply, api) {
    const [requestId, type] = q.id.split("|");
    const response =
      type === "browser_authentication"
        ? { type, action: "cancel" }
        : { type: type || "browser_origin_access", decision: reply.approve ? "approve" : "deny" };
    await api.json("POST", `/agents/sessions/${job.sessionId}/events`, {
      events: [
        { type: "agent.session.input.computer_use_approval_request_result", request_id: requestId, response },
      ],
    });
    return job;
  },

  async cancel(job, api) {
    await api.json("POST", `/agents/sessions/${job.sessionId}/events`, {
      events: [{ type: "agent.session.input.cancel" }],
    });
  },

  async outputs(job, _config, api) {
    const arts = data<{ id: string; name?: string; path?: string; mime_type?: string }>(
      await api.json("GET", `/agents/sessions/${job.sessionId}/artifacts`, undefined, {
        query: { limit: 100 },
      }),
    );
    let patch: string | undefined;
    const files = [];
    for (const a of arts.slice(0, 20)) {
      const name = a.path ?? a.name ?? a.id;
      const { bytes, contentType } = await api.bytes(
        `/agents/sessions/${job.sessionId}/artifacts/${a.id}/content`,
      );
      if (isPatch(name)) patch = utf8(bytes);
      else files.push(producedFile(name, a.mime_type ?? contentType, bytes));
    }
    return { text: "", files, ...(patch ? { patch } : {}) };
  },
});
