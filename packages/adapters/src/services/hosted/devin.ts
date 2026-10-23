// Devin v3 (docs/vendors/hosted-agents.md §5): a session in the organization (capped in ACUs by the attempt's cost
// limit when the agent has a USD-per-ACU price), its messages followed, its questions answered by a person, ACUs
// metered, and its pull requests and attachments collected. Safe-mode approvals have no API: they fail the run.
import { createJobAdapter, type JobUpdate } from "../job";
import { githubRepo, hostedCapabilities, hostedPrompt, producedFile } from "./common";

interface Job {
  id: string;
  cursor: string | null;
}

type Session = {
  session_id?: string;
  status?: "new" | "claimed" | "running" | "exit" | "error" | "suspended" | "resuming";
  status_detail?: string;
  acus_consumed?: number;
  pull_requests?: Array<{ pr_url?: string }>;
};
type Message = { event_id?: string; message?: string; source?: "devin" | "user" };

export const devin = createJobAdapter<Job>({
  key: "devin",
  route: "hosted",
  capabilities: hostedCapabilities({ browses: true }),
  estimateUsd: 2,
  pollMs: 10_000,

  async start(input, config, api) {
    const repo = githubRepo(input);
    const usdPerAcu = config.unitPrice?.unit === "acu" ? config.unitPrice.usd : null;
    const s = await api.json<Session>("POST", "/sessions", {
      prompt: hostedPrompt(input, "the session's attachments", config.rolePrompt),
      title: input.taskTitle.slice(0, 200),
      tags: ["brio"],
      ...(repo ? { repos: [repo.slug] } : {}),
      ...(usdPerAcu ? { max_acu_limit: Math.max(1, Math.floor(input.limits.maxCostUsd / usdPerAcu)) } : {}),
      bypass_approval: false,
    });
    const raw = s.session_id ?? "";
    return { id: raw.startsWith("devin-") ? raw : `devin-${raw}`, cursor: null };
  },

  idOf: (j) => j.id,

  async poll(job, _config, api): Promise<JobUpdate<Job>> {
    const s = await api.json<Session>("GET", `/sessions/${job.id}`);
    const page = await api.json<{ items?: Message[]; end_cursor?: string; has_next_page?: boolean }>(
      "GET",
      `/sessions/${job.id}/messages`,
      undefined,
      { query: { first: 100, after: job.cursor ?? undefined } },
    );
    const items = page.items ?? [];
    const messages = items.filter((m) => m.source === "devin" && m.message).map((m) => m.message as string);
    const base = {
      job: { ...job, cursor: page.end_cursor ?? job.cursor },
      messages,
      usage: { units: s.acus_consumed ?? 0 },
    };
    const detail = s.status_detail ?? "";
    if (s.status === "error")
      return {
        ...base,
        state: "failed",
        error: `Devin stopped with an error${detail ? ` (${detail})` : ""}`,
      };
    if (s.status === "suspended")
      return {
        ...base,
        state: "failed",
        error: `Devin suspended the session (${detail || "unknown reason"})`,
      };
    if (s.status === "exit" || detail === "finished") return { ...base, state: "done" };
    if (detail === "waiting_for_approval")
      return {
        ...base,
        state: "failed",
        error: "Devin waits for a safe-mode approval, which only its own app can give",
      };
    if (detail === "waiting_for_user")
      return {
        ...base,
        state: "needs_input",
        question: { id: "user", kind: "message", text: messages.at(-1) ?? "Devin needs your input." },
      };
    return { ...base, state: "running" };
  },

  async answer(job, _q, reply, api) {
    await api.json("POST", `/sessions/${job.id}/messages`, { message: reply.text });
    return job;
  },

  async cancel(job, api) {
    await api.json("DELETE", `/sessions/${job.id}`, undefined, { query: { archive: false } });
  },

  async outputs(job, _config, api) {
    const s = await api.json<Session>("GET", `/sessions/${job.id}`);
    const atts = await api
      .json<
        | { items?: Array<{ name?: string; url?: string; content_type?: string }> }
        | Array<{ name?: string; url?: string; content_type?: string }>
      >("GET", `/sessions/${job.id}/attachments`)
      .catch(() => ({ items: [] }));
    const list = Array.isArray(atts) ? atts : (atts.items ?? []);
    let patch: string | undefined;
    const files = [];
    for (const a of list.filter((x) => x.url).slice(0, 20)) {
      const { bytes, contentType } = await api.bytes(a.url as string, { auth: false });
      if ((a.name ?? "").endsWith("changes.patch")) patch = new TextDecoder().decode(bytes);
      else files.push(producedFile(a.name ?? "attachment", a.content_type ?? contentType, bytes));
    }
    return {
      text: "",
      files,
      urls: (s.pull_requests ?? []).map((p) => p.pr_url ?? "").filter(Boolean),
      ...(patch ? { patch } : {}),
    };
  },
});
