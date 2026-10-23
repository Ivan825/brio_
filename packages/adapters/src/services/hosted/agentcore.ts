// Amazon Bedrock AgentCore Runtime (docs/vendors/hosted-agents.md §7): your own agent, hosted by AWS. One signed
// InvokeAgentRuntime call per run in a fresh runtime session; the reply is the agent's text (server-sent events or
// JSON, as the agent defines). Nothing to poll and no cost in the API: bounded by the attempt's time limit.
import { randomUUID } from "node:crypto";
import { AdapterError } from "../../errors";
import { createJobAdapter, type JobUpdate } from "../job";
import { hostedCapabilities, hostedPrompt } from "./common";

interface Job {
  sessionId: string;
  arn: string;
  text: string;
}

/** The text of an agent's reply: SSE data lines (any of the common shapes) or a JSON object. */
export function agentcoreText(contentType: string, body: string): string {
  const pick = (v: unknown): string => {
    if (typeof v === "string") return v;
    if (!v || typeof v !== "object") return "";
    const o = v as Record<string, unknown>;
    for (const k of ["result", "output", "response", "text", "content", "message"]) {
      const x = o[k];
      if (typeof x === "string") return x;
      if (x && typeof x === "object") {
        const inner = pick(x);
        if (inner) return inner;
      }
    }
    const delta = (o.event as { contentBlockDelta?: { delta?: { text?: string } } } | undefined)
      ?.contentBlockDelta?.delta?.text;
    return delta ?? "";
  };
  if (contentType.includes("text/event-stream"))
    return body
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim())
      .map((d) => {
        try {
          return pick(JSON.parse(d));
        } catch {
          return d;
        }
      })
      .join("");
  try {
    return pick(JSON.parse(body)) || body;
  } catch {
    return body;
  }
}

export const agentcore = createJobAdapter<Job>({
  key: "bedrock-agentcore",
  route: "hosted",
  capabilities: hostedCapabilities({ editsFiles: false, runsCode: false }),
  estimateUsd: 0,

  async start(input, config, api) {
    const arn = config.connector.settings?.runtimeArn;
    if (!arn) throw new AdapterError("misconfigured", "AgentCore needs the runtime ARN");
    // Session ids are 33–256 characters.
    const sessionId = `brio-${input.attemptId}-${randomUUID()}`.slice(0, 120);
    const r = await api.text(
      "POST",
      `/runtimes/${encodeURIComponent(arn)}/invocations?qualifier=${encodeURIComponent(String(config.options?.qualifier ?? "DEFAULT"))}`,
      { prompt: hostedPrompt(input, "your outputs", config.rolePrompt) },
      {
        headers: {
          accept: "text/event-stream, application/json",
          "x-amzn-bedrock-agentcore-runtime-session-id": sessionId,
        },
        timeoutMs: input.limits.maxMinutes * 60_000,
      },
    );
    return { sessionId, arn, text: agentcoreText(r.contentType, r.text) };
  },

  idOf: (j) => j.sessionId,

  async poll(job): Promise<JobUpdate<Job>> {
    return { job, state: "done" };
  },

  async cancel(job, api) {
    // Frees the runtime session (the invocation itself ends with the run's signal).
    await api.json(
      "POST",
      `/runtimes/${encodeURIComponent(job.arn)}/stopruntimesession`,
      {},
      {
        headers: { "x-amzn-bedrock-agentcore-runtime-session-id": job.sessionId },
      },
    );
  },

  async outputs(job) {
    return { text: job.text };
  },
});
