// Gemini managed agents through the Interactions API (docs/vendors/hosted-agents.md §3): a background interaction with
// a managed agent (the agent id is the Brio agent's "model") in a remote environment, polled to its end; a question is
// answered by chaining a new interaction onto it; files in the environment collected (a patch among them).
import type { ServiceClient } from "../client";
import { createJobAdapter, type JobUpdate } from "../job";
import { hostedCapabilities, hostedPrompt, isPatch, producedFile, utf8 } from "./common";

interface Job {
  interactionId: string;
  environmentId: string | null;
  agent: string;
  shown: number;
}

type Interaction = {
  id: string;
  environment_id?: string;
  status?: "in_progress" | "requires_action" | "completed" | "failed" | "cancelled" | "incomplete";
  output_text?: string;
  error?: { message?: string };
  usage?: { total_input_tokens?: number; total_output_tokens?: number; total_cached_tokens?: number };
};

export const geminiManagedAgents = createJobAdapter<Job>({
  key: "gemini-managed-agents",
  route: "hosted",
  capabilities: hostedCapabilities({ browses: true }),
  estimateUsd: 1,
  pollMs: 4000,

  async start(input, config, api) {
    const it = await api.json<Interaction>("POST", "/interactions", {
      agent: config.model,
      input: [{ type: "text", text: hostedPrompt(input, "outputs", config.rolePrompt) }],
      environment: { type: "remote" },
      background: true,
      ...(config.options?.agentConfig ? { agent_config: config.options.agentConfig } : {}),
    });
    return { interactionId: it.id, environmentId: it.environment_id ?? null, agent: config.model, shown: 0 };
  },

  idOf: (j) => j.interactionId,

  async poll(job, _config, api): Promise<JobUpdate<Job>> {
    const it = await api.json<Interaction>("GET", `/interactions/${job.interactionId}`);
    const text = it.output_text ?? "";
    const messages = text.length > job.shown ? [text.slice(job.shown)] : [];
    const next = {
      ...job,
      environmentId: it.environment_id ?? job.environmentId,
      shown: Math.max(job.shown, text.length),
    };
    const u = it.usage;
    const usage = u
      ? {
          tokensIn: u.total_input_tokens ?? 0,
          tokensOut: u.total_output_tokens ?? 0,
          cachedTokensIn: u.total_cached_tokens ?? 0,
        }
      : undefined;
    const base = { job: next, messages, ...(usage ? { usage } : {}) };
    switch (it.status) {
      case "completed":
        return { ...base, state: "done" };
      case "failed":
        return { ...base, state: "failed", error: it.error?.message ?? "the interaction failed" };
      case "incomplete":
        return { ...base, state: "failed", error: "the agent hit its token limit before finishing" };
      case "cancelled":
        return { ...base, state: "cancelled" };
      case "requires_action":
        return {
          ...base,
          state: "needs_input",
          question: {
            id: job.interactionId,
            kind: "message",
            text: text.trim().split("\n").slice(-6).join("\n") || "The agent needs input.",
          },
        };
      default:
        return { ...base, state: "running" };
    }
  },

  async answer(job, _q, reply, api) {
    // A follow-up chains a new interaction onto the waiting one, in the same environment.
    const it = await api.json<Interaction>("POST", "/interactions", {
      agent: job.agent,
      previous_interaction_id: job.interactionId,
      ...(job.environmentId ? { environment: job.environmentId } : {}),
      input: [{ type: "text", text: reply.text }],
      background: true,
    });
    return { ...job, interactionId: it.id, shown: 0 };
  },

  async cancel(job, api) {
    // The docs disagree on the path (/cancel and :cancel): try both.
    await api
      .json("POST", `/interactions/${job.interactionId}/cancel`, {})
      .catch(() => api.json("POST", `/interactions/${job.interactionId}:cancel`, {}));
  },

  async outputs(job, _config, api) {
    if (!job.environmentId) return { text: "" };
    return environmentFiles(api, job.environmentId);
  },
});

async function environmentFiles(api: ServiceClient, env: string) {
  const r = await api.json<{
    files?: Array<{ path?: string; name?: string; mime_type?: string; size_bytes?: number }>;
  }>("GET", `/environments/${env}/files`, undefined, { query: { recursive: true } });
  let patch: string | undefined;
  const files = [];
  for (const f of (r.files ?? []).filter((x) => (x.path ?? x.name ?? "").includes("outputs/")).slice(0, 20)) {
    const path = f.path ?? f.name ?? "";
    const { bytes, contentType } = await api.bytes(
      api.url(`/environments/${env}/files/${path.replace(/^\/+/, "")}`, { alt: "media" }),
    );
    if (isPatch(path)) patch = utf8(bytes);
    else files.push(producedFile(path, f.mime_type ?? contentType, bytes));
  }
  return { text: "", files, ...(patch ? { patch } : {}) };
}
