// Manus v2 (docs/vendors/hosted-agents.md §6): a task (the agent's "model" is the Manus profile: standard, lite or
// max), its messages followed, its questions answered and its action confirmations approved by a person, credits
// metered, and its attachments collected.
import { createHash, verify } from "node:crypto";
import { AdapterError } from "../../errors";
import type { ServiceClient } from "../client";
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

// Webhooks (docs/vendors/hosted-agents.md §6): registered per connector, signed with RSA-SHA256 over
// `{timestamp}.{url}.{sha256_hex(body)}`, verified with the public key Manus publishes for the account. They tell the
// board as soon as a task stops; the run itself still follows the task by polling, so a lost webhook loses nothing.

/** Registers Brio's receiver for this connector's account. */
export async function registerManusWebhook(api: ServiceClient, url: string): Promise<string | null> {
  const r = await api.json<{ webhook_id?: string; id?: string; webhook?: { id?: string } }>(
    "POST",
    "/v2/webhook.create",
    { url },
    { retries: 1 },
  );
  return r.webhook_id ?? r.id ?? r.webhook?.id ?? null;
}

/** The first PEM public key anywhere in an answer. */
function pemIn(v: unknown): string | null {
  if (typeof v === "string")
    return /-----BEGIN (RSA )?PUBLIC KEY-----[\s\S]+?-----END (RSA )?PUBLIC KEY-----/.exec(v)?.[0] ?? null;
  if (v && typeof v === "object")
    for (const x of Object.values(v)) {
      const found = pemIn(x);
      if (found) return found;
    }
  return null;
}

/** The key Manus signs webhooks with. */
export async function manusPublicKey(api: ServiceClient): Promise<string> {
  const pem = pemIn(await api.json<unknown>("GET", "/v2/webhook.publicKey", undefined, { retries: 1 }));
  if (!pem) throw new AdapterError("bad_request", "Manus returned no webhook public key");
  return pem;
}

/** True when the signature is Manus's over this exact body, for this URL, within five minutes. */
export function verifyManusSignature(o: {
  publicKey: string;
  url: string;
  body: string;
  timestamp: string | undefined;
  signature: string | undefined;
  now?: number;
}): boolean {
  if (!o.timestamp || !o.signature || !/^\d{9,14}$/.test(o.timestamp)) return false;
  const ts = Number(o.timestamp);
  const ms = ts > 1e12 ? ts : ts * 1000;
  if (Math.abs((o.now ?? Date.now()) - ms) > 5 * 60_000) return false;
  const digest = createHash("sha256").update(o.body).digest("hex");
  try {
    return verify(
      "RSA-SHA256",
      Buffer.from(`${o.timestamp}.${o.url}.${digest}`),
      o.publicKey,
      Buffer.from(o.signature, "base64"),
    );
  } catch {
    return false;
  }
}

/** What a webhook says, read leniently: the event, the task, why it stopped and its last message. */
export function manusEvent(body: unknown): {
  type: string;
  taskId: string | null;
  stopReason: string | null;
  message: string | null;
} {
  const b = (body ?? {}) as Record<string, unknown>;
  const d = (b.task_detail ?? b.data ?? b) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" && v ? v : null);
  return {
    type: str(b.event_type) ?? str(b.type) ?? str(b.event) ?? "unknown",
    taskId: str(d.task_id) ?? str(b.task_id) ?? null,
    stopReason: str(d.stop_reason) ?? null,
    message: str(d.message) ?? null,
  };
}
