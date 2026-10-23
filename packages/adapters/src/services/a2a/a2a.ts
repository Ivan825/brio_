// Any A2A agent as a Brio worker (ADAPTER_SPEC §2.5, docs/vendors/protocols.md §1): its Agent Card is read from the
// connector's URL, each task goes to it as an A2A v1.0 message through the official SDK client (non-blocking), the A2A
// task is followed to its end, its questions (input-required) go to the mission's person, and its artifacts come back
// as the result: text and data as the answer, files as produced files, links as links. A2A reports no cost: runs are
// bounded by time.
import { AgentCard, type Artifact, Role, type Task, TaskState } from "@a2a-js/sdk";
import {
  type Client,
  ClientFactory,
  ClientFactoryOptions,
  JsonRpcTransportFactory,
} from "@a2a-js/sdk/client";
import { AdapterError } from "../../errors";
import type { AdapterCapabilities, ProducedFile, RunInput } from "../../types";
import type { ServiceClient } from "../client";
import { createJobAdapter, type JobUpdate } from "../job";

const CARD_PATH = "/.well-known/agent-card.json";

interface Job {
  card: unknown;
  taskId: string;
  contextId: string;
  /** The finished task (or a direct reply, as a task-shaped record). */
  done: { text: string; files: ProducedFile[]; urls: string[] } | null;
  asked: string;
}

/** Task types an agent's skills suggest (the person can change them on the connector). */
export function taskTypesFromSkills(
  skills: Array<{ id?: string; name?: string; description?: string; tags?: string[] }>,
): string[] {
  const words = skills
    .flatMap((s) => [s.id ?? "", s.name ?? "", s.description ?? "", ...(s.tags ?? [])])
    .join(" ")
    .toLowerCase();
  const out = new Set<string>();
  const has = (re: RegExp) => re.test(words);
  if (has(/\b(code|coding|program|bug|refactor|test|pull request|repository)/))
    out.add("code.feature").add("code.bugfix").add("code.tests");
  if (has(/\b(research|search|find|cite|citation|report)/))
    out.add("research.web").add("research.deep_report");
  if (has(/\b(write|writing|summar|doc|copy|translat|email)/)) out.add("write.doc").add("write.summary");
  if (has(/\b(data|sql|analy|extract|spreadsheet|csv)/)) out.add("data.analysis").add("data.extraction");
  if (has(/\b(image|picture|illustrat)/)) out.add("media.image");
  if (has(/\b(video)/)) out.add("media.video");
  if (has(/\b(voice|speech|audio)/)) out.add("media.voice");
  if (has(/\b(browse|browser|website|form)/)) out.add("browser.task");
  if (has(/\b(plan|orchestrat|mission)/)) out.add("plan.decompose");
  // An agent that says nothing specific can still write and summarise.
  if (!out.size) out.add("write.summary");
  return [...out].sort();
}

/** The agent's card, from its URL (with the install's credential, when it has one). */
export async function fetchAgentCard(api: ServiceClient): Promise<AgentCard> {
  return AgentCard.fromJSON(
    await api.json<Record<string, unknown>>("GET", CARD_PATH, undefined, { retries: 1 }),
  );
}

/** An SDK client that sends every request through Brio's guarded fetch, with the install's credential. */
async function clientFor(api: ServiceClient, cardJson: unknown): Promise<Client> {
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    const body = typeof init?.body === "string" ? init.body : "";
    const method = (init?.method ?? "GET") as "GET" | "POST";
    const headers = new Headers(init?.headers);
    for (const [k, v] of Object.entries(await api.headers(method, url, body))) headers.set(k, v);
    return api.rawFetch(url, { ...init, headers });
  };
  const factory = new ClientFactory(
    ClientFactoryOptions.createFrom(ClientFactoryOptions.default, {
      transports: [new JsonRpcTransportFactory({ fetchImpl })],
    }),
  );
  return factory.createFromAgentCard(AgentCard.fromJSON(cardJson));
}

const userMessage = (text: string, ids: { taskId?: string; contextId?: string } = {}) => ({
  messageId: crypto.randomUUID(),
  contextId: ids.contextId ?? "",
  taskId: ids.taskId ?? "",
  role: Role.ROLE_USER,
  parts: [
    {
      content: { $case: "text" as const, value: text },
      metadata: undefined,
      filename: "",
      mediaType: "text/plain",
    },
  ],
  metadata: undefined,
  extensions: [],
  referenceTaskIds: [],
});

const textOfMessage = (m: { parts?: Array<{ content?: { $case: string; value: unknown } }> } | undefined) =>
  (m?.parts ?? [])
    .map((p) => (p.content?.$case === "text" ? String(p.content.value) : ""))
    .filter(Boolean)
    .join("\n");

/** An A2A task's artifacts as Brio's result. */
export function resultOf(artifacts: Artifact[]): { text: string; files: ProducedFile[]; urls: string[] } {
  const text: string[] = [];
  const files: ProducedFile[] = [];
  const urls: string[] = [];
  for (const a of artifacts)
    for (const p of a.parts) {
      const c = p.content;
      if (!c) continue;
      if (c.$case === "text") text.push(a.name ? `## ${a.name}\n\n${c.value}` : c.value);
      else if (c.$case === "data") text.push(`\`\`\`json\n${JSON.stringify(c.value, null, 2)}\n\`\`\``);
      else if (c.$case === "url") urls.push(c.value);
      else if (c.$case === "raw") {
        const type = p.mediaType || "application/octet-stream";
        const top = type.split("/")[0] ?? "";
        files.push({
          kind: top === "image" || top === "video" || top === "audio" ? top : "file",
          name: p.filename || a.name || `artifact-${files.length + 1}`,
          contentType: type,
          bytes: new Uint8Array(c.value),
        });
      }
    }
  return { text: text.join("\n\n"), files, urls };
}

const capabilities = (): AdapterCapabilities => ({
  taskTypes: [],
  editsFiles: false,
  runsCode: false,
  browses: false,
  producesMedia: [],
  streaming: false,
  supportsMcpTools: false,
  supportsResume: false,
  runnerModes: ["cloud"],
});

export const a2a = createJobAdapter<Job>({
  key: "a2a",
  route: "a2a",
  capabilities,
  estimateUsd: 0,
  pollMs: 2000,

  async start(input: RunInput, config, api) {
    const card = await fetchAgentCard(api);
    const cardJson = AgentCard.toJSON(card);
    const client = await clientFor(api, cardJson);
    const prompt = [config.rolePrompt, input.instructions].filter(Boolean).join("\n\n");
    const r = (await client.sendMessage({
      tenant: "",
      message: userMessage(prompt),
      configuration: {
        acceptedOutputModes: [],
        taskPushNotificationConfig: undefined,
        historyLength: undefined,
        returnImmediately: true,
      },
      metadata: undefined,
    })) as Task | { parts: unknown[] };
    if (!("status" in r)) {
      // A direct reply: the agent answered without a task.
      return {
        card: cardJson,
        taskId: "",
        contextId: "",
        done: { text: textOfMessage(r as never), files: [], urls: [] },
        asked: "",
      };
    }
    return { card: cardJson, taskId: r.id, contextId: r.contextId, done: null, asked: "" };
  },

  idOf: (j) => j.taskId || "direct-reply",

  async poll(job, _config, api): Promise<JobUpdate<Job>> {
    if (job.done) return { job, state: "done" };
    const client = await clientFor(api, job.card);
    const t = await client.getTask({ tenant: "", id: job.taskId, historyLength: undefined });
    const state = t.status?.state ?? TaskState.TASK_STATE_UNSPECIFIED;
    const said = textOfMessage(t.status?.message);
    switch (state) {
      case TaskState.TASK_STATE_COMPLETED:
        return {
          job: { ...job, done: resultOf(t.artifacts) },
          state: "done",
          ...(said ? { messages: [said] } : {}),
        };
      case TaskState.TASK_STATE_FAILED:
      case TaskState.TASK_STATE_REJECTED:
        return { job, state: "failed", error: said || "the agent could not do the task" };
      case TaskState.TASK_STATE_CANCELED:
        return { job, state: "cancelled", error: said || "the agent cancelled the task" };
      case TaskState.TASK_STATE_AUTH_REQUIRED:
        return {
          job,
          state: "failed",
          error: "the agent wants you to sign in with it; Brio does not hand over credentials",
        };
      case TaskState.TASK_STATE_INPUT_REQUIRED:
        return {
          job,
          state: "needs_input",
          question: {
            id: `${job.taskId}:${t.status?.timestamp ?? said}`,
            kind: "message",
            text: said || "The agent needs more input.",
          },
        };
      default:
        return { job, state: "running", ...(said && said !== job.asked ? { progress: [said] } : {}) };
    }
  },

  async answer(job, _q, reply, api) {
    const client = await clientFor(api, job.card);
    await client.sendMessage({
      tenant: "",
      message: userMessage(reply.text, { taskId: job.taskId, contextId: job.contextId }),
      configuration: {
        acceptedOutputModes: [],
        taskPushNotificationConfig: undefined,
        historyLength: undefined,
        returnImmediately: true,
      },
      metadata: undefined,
    });
    return { ...job, asked: reply.text };
  },

  async cancel(job, api) {
    if (!job.taskId || job.done) return;
    const client = await clientFor(api, job.card);
    await client.cancelTask({ tenant: "", id: job.taskId, metadata: undefined });
  },

  async outputs(job) {
    if (!job.done) throw new AdapterError("bad_request", "the task has no result");
    return job.done;
  },
});
