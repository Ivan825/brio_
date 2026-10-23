// What Brio's MCP server does (ARCHITECTURE §4.5, PRD F39): any agent — Claude Code, Cursor, Codex — hands Brio a goal
// and gets the result back, asks a mission's agents questions, reads its brief and contracts, and asks a person for a
// review. Every tool acts as the caller in the caller's workspace, through the same rules as the web app.
import { renderMissionReport } from "@brio/core";
import { schema } from "@brio/db";
import { and, asc, desc, eq, inArray, ne } from "drizzle-orm";
import type { AppContext } from "../context";
import { HttpError, one, requireMember, type SessionInfo } from "../http";
import { createMission } from "../missions";
import { approvePlan } from "../orchestrator/plans";
import { missionReport } from "../orchestrator/report";

const { contracts, handoffs, messages, missions, plans, tasks } = schema;

/** Who is calling and from where: a person (by API token or OAuth) in one workspace, through one MCP client. */
export interface Caller {
  session: SessionInfo;
  workspaceId: string;
  /** The MCP client's name, for the events (actor "user:<id>" acts through it). */
  client: string;
}

const ACTIVE = ["running", "verifying"];
const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
  });

export class BrioTools {
  constructor(
    private readonly ctx: AppContext,
    private readonly caller: Caller,
    private readonly opts: { pollMs?: number } = {},
  ) {}

  private get boardUrl() {
    return this.ctx.config.APP_URL.replace(/\/+$/, "");
  }

  private async mission(id: string) {
    const [m] = await this.ctx.db.select().from(missions).where(eq(missions.id, id));
    // A mission of another workspace is "not found", as the REST API says.
    if (!m || m.workspaceId !== this.caller.workspaceId)
      throw new HttpError(404, "mission not found", "not_found");
    await requireMember(this.ctx, m.workspaceId, this.caller.session);
    return m;
  }

  private async report(id: string): Promise<string> {
    const m = await this.mission(id);
    const saved = (m.report as { final?: Parameters<typeof renderMissionReport>[0] } | null)?.final;
    const r = saved ?? (await missionReport(this.ctx.db, m.id));
    return r ? renderMissionReport(r) : `Mission ${m.id}: ${m.status}`;
  }

  /** Waits for a mission to settle (done, failed, cancelled, or waiting for a person), up to `minutes`. */
  private async settle(id: string, minutes: number, signal?: AbortSignal, onProgress?: (s: string) => void) {
    const until = Date.now() + minutes * 60_000;
    let last = "";
    for (;;) {
      const m = await this.mission(id);
      if (m.status !== last) {
        last = m.status;
        onProgress?.(m.status);
      }
      if (["done", "failed", "cancelled", "awaiting_approval"].includes(m.status)) return m;
      if (m.status === "draft" && m.blockedReason) return m;
      if (Date.now() >= until || signal?.aborted) return m;
      await sleep(this.opts.pollMs ?? 2000, signal);
    }
  }

  private link(id: string) {
    return `${this.boardUrl}/missions/${id}`;
  }

  /** Delegates a goal: Brio plans it, routes each piece to the best agent, verifies the work and reports. */
  async delegate(
    a: {
      task: string;
      title?: string;
      project_id?: string;
      priority?: "quality" | "balanced" | "cheap" | "fast";
      budget_usd?: number;
      wait_minutes?: number;
    },
    signal?: AbortSignal,
    onProgress?: (s: string) => void,
  ): Promise<string> {
    const m = await createMission(
      this.ctx,
      this.caller.session,
      this.caller.workspaceId,
      {
        goal: a.task,
        ...(a.title ? { title: a.title } : {}),
        ...(a.project_id ? { projectId: a.project_id } : {}),
        priority: a.priority ?? "balanced",
        ...(a.budget_usd ? { budget: { usd: a.budget_usd } } : {}),
        // The caller asked for the work: a clean, small plan starts without a second confirmation.
        autoApprove: true,
      },
      `user:${this.caller.session.userId}`,
    );
    const wait = Math.max(0, Math.min(a.wait_minutes ?? 15, 60));
    if (wait === 0)
      return `Mission ${m.id} started: ${this.link(m.id)}. Call mission_status or report to follow it.`;
    const end = await this.settle(m.id, wait, signal, onProgress);
    if (end.status === "awaiting_approval")
      return `Mission ${m.id} has a plan waiting for approval (larger than a quick start allows, or with questions): ${this.link(m.id)}. Call approve_plan to start it.\n\n${await this.planText(m.id)}`;
    if (end.status === "draft" && end.blockedReason)
      return `Mission ${m.id} cannot start: ${end.blockedReason}`;
    if (!["done", "failed", "cancelled"].includes(end.status))
      return `Mission ${m.id} is still ${end.status} after ${wait} minutes: ${this.link(m.id)}. Call mission_status or report later.`;
    return this.report(m.id);
  }

  private async planText(missionId: string): Promise<string> {
    const [p] = await this.ctx.db
      .select()
      .from(plans)
      .where(eq(plans.missionId, missionId))
      .orderBy(desc(plans.version))
      .limit(1);
    if (!p) return "No plan yet.";
    const g = p.graph as {
      tasks: Array<{ key: string; type: string; title: string; dependsOn: string[] }>;
      questions?: string[];
    };
    return [
      `Plan v${p.version} (${p.status}):`,
      ...g.tasks.map(
        (t) =>
          `- ${t.key} (${t.type}): ${t.title}${t.dependsOn.length ? ` — after ${t.dependsOn.join(", ")}` : ""}`,
      ),
      ...(g.questions?.length ? ["Questions:", ...g.questions.map((q) => `- ${q}`)] : []),
    ].join("\n");
  }

  /** Plans a goal without running it: the plan comes back for review, and approve_plan starts it. */
  async planMission(a: { goal: string; project_id?: string }, signal?: AbortSignal): Promise<string> {
    const m = await createMission(this.ctx, this.caller.session, this.caller.workspaceId, {
      goal: a.goal,
      ...(a.project_id ? { projectId: a.project_id } : {}),
    });
    const end = await this.settle(m.id, 5, signal);
    if (end.status === "draft" && end.blockedReason)
      return `Mission ${m.id} cannot be planned: ${end.blockedReason}`;
    return `Mission ${m.id}: ${this.link(m.id)}\n\n${await this.planText(m.id)}`;
  }

  async approvePlan(a: { mission_id: string }): Promise<string> {
    const m = await this.mission(a.mission_id);
    if (m.status !== "awaiting_approval")
      return `Mission ${m.id} is ${m.status}; there is no plan to approve.`;
    const [p] = await this.ctx.db
      .select()
      .from(plans)
      .where(and(eq(plans.missionId, m.id), eq(plans.status, "proposed")))
      .orderBy(desc(plans.version))
      .limit(1);
    if (!p) return `Mission ${m.id} has no proposed plan.`;
    await requireMember(this.ctx, m.workspaceId, this.caller.session, ["owner", "admin", "member"]);
    const userId = this.caller.session.userId;
    await approvePlan(this.ctx, m, p.version, `user:${userId}`, userId);
    this.ctx.orchestrator.schedule(m.id);
    return `Plan v${p.version} approved; mission ${m.id} is running: ${this.link(m.id)}`;
  }

  async missionStatus(a: { mission_id: string }): Promise<string> {
    const m = await this.mission(a.mission_id);
    const ts = await this.ctx.db
      .select()
      .from(tasks)
      .where(and(eq(tasks.missionId, m.id), ne(tasks.planVersion, 0)))
      .orderBy(asc(tasks.createdAt));
    const latest = Math.max(0, ...ts.map((t) => t.planVersion));
    const open = await this.ctx.db
      .select()
      .from(messages)
      .where(and(eq(messages.missionId, m.id), eq(messages.toUser, true), eq(messages.status, "open")))
      .orderBy(asc(messages.createdAt));
    return [
      `${m.title} — ${m.status}${m.blockedReason ? ` (${m.blockedReason})` : ""}`,
      this.link(m.id),
      ...ts
        .filter((t) => t.planVersion === latest)
        .map((t) => `- ${t.key} (${t.type}): ${t.status}${t.blockedReason ? ` — ${t.blockedReason}` : ""}`),
      ...(open.length
        ? ["Waiting for you:", ...open.map((q) => `- [${q.id}] ${q.kind}: ${q.body.slice(0, 500)}`)]
        : []),
    ].join("\n");
  }

  report_(a: { mission_id: string }) {
    return this.report(a.mission_id);
  }

  /** Asks the agent working on a task a question; waits a while for its answer. */
  async askAgent(
    a: { mission_id: string; task_key: string; question: string; wait_seconds?: number },
    signal?: AbortSignal,
  ) {
    const m = await this.mission(a.mission_id);
    await requireMember(this.ctx, m.workspaceId, this.caller.session, ["owner", "admin", "member"]);
    const [t] = await this.ctx.db
      .select()
      .from(tasks)
      .where(and(eq(tasks.missionId, m.id), eq(tasks.key, a.task_key), ne(tasks.planVersion, 0)))
      .orderBy(desc(tasks.planVersion))
      .limit(1);
    if (!t) return `There is no task ${a.task_key} in mission ${m.id}.`;
    if (!ACTIVE.includes(t.status))
      return `Nobody is working on ${a.task_key} right now (it is ${t.status}).`;
    const q = one(
      await this.ctx.db
        .insert(messages)
        .values({
          workspaceId: m.workspaceId,
          missionId: m.id,
          toTaskId: t.id,
          kind: "question",
          body: a.question,
        })
        .returning(),
      "message",
    );
    await this.ctx.events.append(this.ctx.db, {
      workspaceId: m.workspaceId,
      missionId: m.id,
      taskId: t.id,
      type: "message.sent",
      actor: `user:${this.caller.session.userId}`,
      payload: {
        messageId: q.id,
        kind: "question",
        to: a.task_key,
        from: "user",
        body: a.question,
        via: this.caller.client,
      },
    });
    const until = Date.now() + Math.max(5, Math.min(a.wait_seconds ?? 120, 600)) * 1000;
    while (Date.now() < until && !signal?.aborted) {
      const [ans] = await this.ctx.db.select().from(messages).where(eq(messages.replyToId, q.id)).limit(1);
      if (ans) return `${a.task_key} answered: ${ans.body}`;
      await sleep(this.opts.pollMs ?? 1000, signal);
    }
    return `No answer from ${a.task_key} yet; the question stays in its inbox (message ${q.id}).`;
  }

  /** Answers a question a mission's agent asked you. */
  async answer(a: { message_id: string; text: string }) {
    const [q] = await this.ctx.db.select().from(messages).where(eq(messages.id, a.message_id));
    if (!q?.toUser || q.workspaceId !== this.caller.workspaceId)
      return "There is no question for you with that id.";
    await requireMember(this.ctx, q.workspaceId, this.caller.session, ["owner", "admin", "member"]);
    if (q.status !== "open") return "That question is already answered.";
    await this.ctx.db.transaction(async (tx) => {
      await tx.insert(messages).values({
        workspaceId: q.workspaceId,
        missionId: q.missionId,
        toAttemptId: q.fromAttemptId,
        toUser: q.fromAttemptId === null,
        kind: "answer",
        replyToId: q.id,
        body: a.text,
      });
      await tx
        .update(messages)
        .set({ status: q.kind === "question" ? "answered" : "closed" })
        .where(eq(messages.id, q.id));
      await this.ctx.events.append(tx, {
        workspaceId: q.workspaceId,
        missionId: q.missionId,
        type: "message.answered",
        actor: `user:${this.caller.session.userId}`,
        payload: { questionId: q.id, from: "user", body: a.text, via: this.caller.client },
      });
    });
    return "Answered.";
  }

  /** The mission brief: goal, plan, what finished tasks handed over and the contracts in force. */
  async getBrief(a: { mission_id: string }) {
    const m = await this.mission(a.mission_id);
    const done = await this.ctx.db
      .select({ key: tasks.key, title: tasks.title })
      .from(tasks)
      .where(and(eq(tasks.missionId, m.id), eq(tasks.status, "done"), ne(tasks.planVersion, 0)));
    const packets = await this.ctx.db
      .select({ packet: handoffs.packet })
      .from(handoffs)
      .innerJoin(tasks, eq(tasks.id, handoffs.toTaskId))
      .where(eq(tasks.missionId, m.id));
    const active = await this.ctx.db
      .select({ name: contracts.name, version: contracts.version })
      .from(contracts)
      .where(and(eq(contracts.missionId, m.id), eq(contracts.status, "active")));
    const decisions = [
      ...new Map(packets.flatMap((p) => p.packet.decisions).map((d) => [d.id, d.statement])).values(),
    ];
    return [
      `Goal: ${m.goal}`,
      `Status: ${m.status}`,
      await this.planText(m.id),
      done.length ? `Done: ${done.map((d) => `${d.key} (${d.title})`).join("; ")}` : "Nothing finished yet.",
      decisions.length ? `Decisions:\n${decisions.map((d) => `- ${d}`).join("\n")}` : "",
      active.length
        ? `Contracts: ${active.map((c) => `${c.name} v${c.version}`).join(", ")}`
        : "No contracts yet.",
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  async getContract(a: { mission_id: string; name: string }) {
    const m = await this.mission(a.mission_id);
    const [c] = await this.ctx.db
      .select()
      .from(contracts)
      .where(
        and(
          eq(contracts.missionId, m.id),
          eq(contracts.name, a.name),
          inArray(contracts.status, ["active", "draft"]),
        ),
      )
      .orderBy(desc(contracts.createdAt))
      .limit(1);
    if (!c) return `No contract named ${a.name} in mission ${m.id}.`;
    return `${c.name} v${c.version} (${c.status})\n\n${typeof c.spec === "string" ? c.spec : JSON.stringify(c.spec, null, 2)}`;
  }

  /** Asks a person on the mission's board to review something (it lands in their inbox). */
  async requestReview(a: { mission_id: string; note: string }) {
    const m = await this.mission(a.mission_id);
    await requireMember(this.ctx, m.workspaceId, this.caller.session, ["owner", "admin", "member"]);
    const r = one(
      await this.ctx.db
        .insert(messages)
        .values({
          workspaceId: m.workspaceId,
          missionId: m.id,
          toUser: true,
          kind: "review_request",
          body: a.note,
        })
        .returning(),
      "message",
    );
    await this.ctx.events.append(this.ctx.db, {
      workspaceId: m.workspaceId,
      missionId: m.id,
      type: "message.sent",
      actor: `user:${this.caller.session.userId}`,
      payload: { messageId: r.id, kind: "review_request", to: "user", body: a.note, via: this.caller.client },
    });
    return `Review requested on the board (message ${r.id}): ${this.link(m.id)}`;
  }

  async listMissions() {
    const rows = await this.ctx.db
      .select()
      .from(missions)
      .where(eq(missions.workspaceId, this.caller.workspaceId))
      .orderBy(desc(missions.createdAt))
      .limit(20);
    await requireMember(this.ctx, this.caller.workspaceId, this.caller.session);
    return rows.length ? rows.map((m) => `- ${m.id} ${m.status}: ${m.title}`).join("\n") : "No missions yet.";
  }
}
