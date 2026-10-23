// Manus v2 (docs/vendors/hosted-agents.md §6): a task (the agent's "model" is the Manus profile: standard, lite or
// max), its messages followed, its questions answered and its action confirmations approved by a person, credits
// metered, and its attachments collected.
import { createJobAdapter, type JobUpdate } from "../job";
import { hostedCapabilities, hostedPrompt, producedFile } from "./common";

interface Job {
  taskId: string;
  cursor: string | null;
}

type Detail = {
  task?: {
    status?: "running" | "stopped" | "waiting" | "error" | "deleted";
    credit_usage?: number;
    has_running_background_jobs?: boolean;
    status_detail?: { waiting_for_event_type?: string; waiting_for_event_id?: string; message?: string };
    error?: string;
  };
};
type Event = { id?: string; type?: string; content?: string; message?: string };

const QUESTION_TYPES = new Set(["messageAskUser", "cascadeAskUser"]);

export const manus = createJobAdapter<Job>({
  key: "manus",
  route: "hosted",
  capabilities: hostedCapabilities({ browses: true }),
  estimateUsd: 1,
  pollMs: 5000,

  async start(input, config, api) {
    const r = await api.json<{ task_id: string }>("POST", "/v2/task.create", {
      message: { content: hostedPrompt(input, "the task's attachments", config.rolePrompt) },
      title: input.taskTitle.slice(0, 200),
      agent_profile: ["standard", "lite", "max"].includes(config.model) ? config.model : "standard",
      hide_in_task_list: true,
      share_visibility: "private",
    });
    return { taskId: r.task_id, cursor: null };
  },

  idOf: (j) => j.taskId,

  async poll(job, _config, api): Promise<JobUpdate<Job>> {
    const d = await api.json<Detail>("GET", "/v2/task.detail", undefined, { query: { task_id: job.taskId } });
    const page = await api.json<{ messages?: Event[]; events?: Event[]; next_cursor?: string }>(
      "GET",
      "/v2/task.listMessages",
      undefined,
      { query: { task_id: job.taskId, order: "asc", limit: 50, cursor: job.cursor ?? undefined } },
    );
    const events = page.messages ?? page.events ?? [];
    const messages = events
      .filter((e) => e.type === "assistant_message")
      .map((e) => e.content ?? e.message ?? "")
      .filter(Boolean);
    const t = d.task ?? {};
    const base = {
      job: { ...job, cursor: page.next_cursor ?? job.cursor },
      messages,
      usage: { units: t.credit_usage ?? 0 },
    };
    if (t.status === "error" || t.status === "deleted")
      return { ...base, state: "failed", error: t.error ?? `the task ended (${t.status})` };
    if (t.status === "stopped" && !t.has_running_background_jobs) return { ...base, state: "done" };
    if (t.status === "waiting") {
      const sd = t.status_detail ?? {};
      const asks = QUESTION_TYPES.has(sd.waiting_for_event_type ?? "");
      return {
        ...base,
        state: "needs_input",
        question: {
          id: sd.waiting_for_event_id ?? "",
          kind: asks ? "message" : "approval",
          text: asks
            ? (sd.message ?? messages.at(-1) ?? "Manus needs your input.")
            : `Manus wants to run ${sd.waiting_for_event_type ?? "an action"}${sd.message ? `: ${sd.message}` : ""}`,
        },
      };
    }
    return { ...base, state: "running" };
  },

  async answer(job, q, reply, api) {
    if (q.kind === "approval")
      await api.json("POST", "/v2/task.confirmAction", {
        task_id: job.taskId,
        event_id: q.id,
        input: { accept: reply.approve },
      });
    else
      await api.json("POST", "/v2/task.sendMessage", {
        task_id: job.taskId,
        message: { content: reply.text },
      });
    return job;
  },

  async cancel(job, api) {
    await api.json("POST", "/v2/task.stop", { task_id: job.taskId });
  },

  async outputs(job, _config, api) {
    const r = await api
      .json<{ artifacts?: Array<{ file_name?: string; url?: string; mime_type?: string }> }>(
        "GET",
        "/v2/artifact.list",
        undefined,
        {
          query: { task_id: job.taskId },
        },
      )
      .catch(() => ({ artifacts: [] }));
    let patch: string | undefined;
    const files = [];
    for (const a of (r.artifacts ?? []).filter((x) => x.url).slice(0, 20)) {
      const { bytes, contentType } = await api.bytes(a.url as string, { auth: false });
      if ((a.file_name ?? "").endsWith("changes.patch")) patch = new TextDecoder().decode(bytes);
      else files.push(producedFile(a.file_name ?? "artifact", a.mime_type ?? contentType, bytes));
    }
    return { text: "", files, ...(patch ? { patch } : {}) };
  },
});
