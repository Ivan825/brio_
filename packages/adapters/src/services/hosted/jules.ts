// Jules (docs/vendors/hosted-agents.md §4): a session on a connected GitHub source (or none), activities followed
// for messages and progress, its plan approved (or its question answered) by a person, and the change set's patch
// applied to the task's worktree. Jules has no cancel: Brio stops following a cancelled session.
import { createJobAdapter, type JobUpdate } from "../job";
import { githubRepo, hostedCapabilities } from "./common";

interface Job {
  id: string;
  seen: string[];
}

type Activity = {
  name?: string;
  id?: string;
  agentMessaged?: { agentMessage?: string };
  progressUpdated?: { title?: string; description?: string };
  planGenerated?: { plan?: { steps?: Array<{ title?: string }> } };
  sessionFailed?: { reason?: string };
  artifacts?: Array<{ changeSet?: { gitPatch?: { unidiffPatch?: string } } }>;
};
type Session = {
  id?: string;
  name?: string;
  state?: string;
  outputs?: Array<{ pullRequest?: { url?: string } }>;
};

const idOf = (a: Activity) => a.id ?? a.name ?? JSON.stringify(a).slice(0, 80);

async function activities(api: import("../client").ServiceClient, id: string): Promise<Activity[]> {
  const out: Activity[] = [];
  let pageToken: string | undefined;
  for (let i = 0; i < 20; i++) {
    const r = await api.json<{ activities?: Activity[]; nextPageToken?: string }>(
      "GET",
      `/sessions/${id}/activities`,
      undefined,
      { query: { pageSize: 50, pageToken } },
    );
    out.push(...(r.activities ?? []));
    if (!r.nextPageToken) break;
    pageToken = r.nextPageToken;
  }
  return out;
}

export const jules = createJobAdapter<Job>({
  key: "jules",
  route: "hosted",
  capabilities: hostedCapabilities(),
  estimateUsd: 0,
  pollMs: 5000,

  async start(input, config, api) {
    const source = config.connector.settings?.source;
    const repo = githubRepo(input);
    const s = await api.json<Session>("POST", "/sessions", {
      prompt: [config.rolePrompt, input.instructions].filter(Boolean).join("\n\n"),
      title: input.taskTitle.slice(0, 200),
      ...(source
        ? { sourceContext: { source, githubRepoContext: { startingBranch: repo?.branch ?? "main" } } }
        : {}),
      requirePlanApproval: false,
    });
    const id = s.id ?? (s.name ?? "").replace(/^sessions\//, "");
    return { id, seen: [] };
  },

  idOf: (j) => j.id,

  async poll(job, _config, api): Promise<JobUpdate<Job>> {
    const s = await api.json<Session>("GET", `/sessions/${job.id}`);
    const acts = await activities(api, job.id);
    const seen = new Set(job.seen);
    const fresh = acts.filter((a) => !seen.has(idOf(a)));
    for (const a of fresh) seen.add(idOf(a));
    const messages = fresh.map((a) => a.agentMessaged?.agentMessage ?? "").filter(Boolean);
    const progress = fresh
      .map((a) =>
        a.progressUpdated
          ? [a.progressUpdated.title, a.progressUpdated.description].filter(Boolean).join(": ")
          : "",
      )
      .filter(Boolean);
    const base = { job: { ...job, seen: [...seen] }, messages, progress };
    switch (s.state) {
      case "COMPLETED":
        return { ...base, state: "done" };
      case "FAILED":
        return {
          ...base,
          state: "failed",
          error: acts.find((a) => a.sessionFailed)?.sessionFailed?.reason ?? "the session failed",
        };
      case "AWAITING_PLAN_APPROVAL": {
        const plan = [...acts].reverse().find((a) => a.planGenerated)?.planGenerated?.plan?.steps ?? [];
        return {
          ...base,
          state: "needs_input",
          question: {
            id: "plan",
            kind: "approval",
            text: `Jules's plan: ${plan.map((p, i) => `${i + 1}. ${p.title ?? ""}`).join(" ")}`,
          },
        };
      }
      case "AWAITING_USER_FEEDBACK": {
        const last = [...acts].reverse().find((a) => a.agentMessaged)?.agentMessaged?.agentMessage;
        return {
          ...base,
          state: "needs_input",
          question: { id: "feedback", kind: "message", text: last ?? "Jules needs your input." },
        };
      }
      default:
        return { ...base, state: "running" };
    }
  },

  async answer(job, q, reply, api) {
    if (q.kind === "approval" && reply.approve) await api.json("POST", `/sessions/${job.id}:approvePlan`, {});
    else await api.json("POST", `/sessions/${job.id}:sendMessage`, { prompt: reply.text });
    return job;
  },

  async outputs(job, _config, api) {
    const acts = await activities(api, job.id);
    const patches = acts
      .flatMap((a) => (a.artifacts ?? []).map((x) => x.changeSet?.gitPatch?.unidiffPatch ?? ""))
      .filter(Boolean);
    const s = await api.json<Session>("GET", `/sessions/${job.id}`);
    const urls = (s.outputs ?? []).map((o) => o.pullRequest?.url ?? "").filter(Boolean);
    // The last change set is the session's final state of the code.
    const patch = patches.at(-1);
    return { text: "", urls, ...(patch ? { patch } : {}) };
  },
});
