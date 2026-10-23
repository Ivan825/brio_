// Microsoft Foundry Agent Service (docs/vendors/hosted-agents.md §8): a background response from a named agent in the
// project, polled to its end; MCP tool approvals put to a person and answered with a chained response; token usage
// metered when the agent has a price. Auth is a Microsoft Entra service principal.
import { AdapterError } from "../../errors";
import { createJobAdapter, type JobUpdate } from "../job";
import { hostedCapabilities, hostedPrompt, textOf } from "./common";

interface Job {
  responseId: string;
  agent: string;
}

type Response = {
  id: string;
  status?: "queued" | "in_progress" | "completed" | "failed" | "cancelled" | "incomplete";
  error?: { message?: string };
  output?: Array<{
    type?: string;
    id?: string;
    name?: string;
    server_label?: string;
    arguments?: string;
    content?: unknown;
  }>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    input_tokens_details?: { cached_tokens?: number };
  };
};

const textOut = (r: Response) =>
  (r.output ?? [])
    .filter((o) => o.type === "message")
    .map((o) => textOf(o.content))
    .filter(Boolean)
    .join("\n\n");

export const foundryAgents = createJobAdapter<Job>({
  key: "foundry-agents",
  route: "hosted",
  capabilities: hostedCapabilities({ editsFiles: false }),
  estimateUsd: 0.5,
  pollMs: 3000,

  async start(input, config, api) {
    const agent = config.connector.settings?.agentName;
    if (!agent) throw new AdapterError("misconfigured", "Foundry needs the agent name");
    const r = await api.json<Response>("POST", "/openai/v1/responses", {
      agent: { type: "agent_reference", name: agent },
      input: [{ role: "user", content: hostedPrompt(input, "your outputs", config.rolePrompt) }],
      background: true,
    });
    return { responseId: r.id, agent };
  },

  idOf: (j) => j.responseId,

  async poll(job, _config, api): Promise<JobUpdate<Job>> {
    const r = await api.json<Response>("GET", `/openai/v1/responses/${job.responseId}`);
    const u = r.usage;
    const base = {
      job,
      ...(u
        ? {
            usage: {
              tokensIn: u.input_tokens ?? 0,
              tokensOut: u.output_tokens ?? 0,
              cachedTokensIn: u.input_tokens_details?.cached_tokens ?? 0,
            },
          }
        : {}),
    };
    if (r.status === "failed")
      return { ...base, state: "failed", error: r.error?.message ?? "the response failed" };
    if (r.status === "cancelled") return { ...base, state: "cancelled" };
    if (r.status === "incomplete")
      return { ...base, state: "failed", error: "the response stopped before finishing" };
    if (r.status === "completed") {
      const approval = (r.output ?? []).find((o) => o.type === "mcp_approval_request");
      if (approval?.id)
        return {
          ...base,
          state: "needs_input",
          question: {
            id: approval.id,
            kind: "approval",
            text: `the agent wants to call ${approval.server_label ?? "an MCP server"}'s ${approval.name ?? "tool"} with ${approval.arguments ?? "{}"}`,
          },
        };
      if ((r.output ?? []).some((o) => o.type === "function_call"))
        return { ...base, state: "failed", error: "the agent called a function Brio does not provide" };
      return { ...base, state: "done", messages: [textOut(r)].filter(Boolean) };
    }
    return { ...base, state: "running" };
  },

  async answer(job, q, reply, api) {
    const r = await api.json<Response>("POST", "/openai/v1/responses", {
      agent: { type: "agent_reference", name: job.agent },
      previous_response_id: job.responseId,
      input: [{ type: "mcp_approval_response", approval_request_id: q.id, approve: reply.approve }],
      background: true,
    });
    return { ...job, responseId: r.id };
  },

  async cancel(job, api) {
    await api.json("POST", `/openai/v1/responses/${job.responseId}/cancel`, {});
  },

  async outputs() {
    return { text: "" };
  },
});
