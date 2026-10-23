// The Brio mailbox (ADAPTER_SPEC §2.6) as the runner serves it to one attempt: questions between agents of a mission,
// blockers and review requests to the user, contracts and the brief. Everything is a message row and an event, so the
// board shows the whole conversation.
import type { InboxMessage, Mailbox } from "@brio/adapters";
import { type Db, type EventWriter, schema } from "@brio/db";
import type { Actor, EventType } from "@brio/schema";
import { and, desc, eq, inArray, ne } from "drizzle-orm";

const { contracts, handoffs, messages, missions, tasks } = schema;

export interface MailboxScope {
  workspaceId: string;
  missionId: string;
  taskId: string;
  taskKey: string;
  attemptId: string;
  agentId: string;
}

const ACTIVE = ["running", "verifying", "revise", "leased"];

export class RunnerMailbox implements Mailbox {
  private readonly delivered = new Set<string>();

  constructor(
    private readonly db: Db,
    private readonly events: EventWriter,
    private readonly scope: MailboxScope,
    private readonly opts: { answerWaitMs: number; pollMs?: number; signal?: AbortSignal } = {
      answerWaitMs: 180_000,
    },
  ) {}

  private emit(type: EventType, payload: Record<string, unknown>) {
    const actor: Actor = `agent:${this.scope.agentId}`;
    return this.events.append(this.db, {
      workspaceId: this.scope.workspaceId,
      missionId: this.scope.missionId,
      taskId: this.scope.taskId,
      attemptId: this.scope.attemptId,
      type,
      actor,
      payload,
    });
  }

  private async send(
    to: { taskId: string; taskKey: string } | "user",
    kind: "question" | "blocker" | "review_request" | "note",
    body: string,
  ) {
    const [row] = await this.db
      .insert(messages)
      .values({
        workspaceId: this.scope.workspaceId,
        missionId: this.scope.missionId,
        fromAttemptId: this.scope.attemptId,
        toTaskId: to === "user" ? null : to.taskId,
        toUser: to === "user",
        kind,
        body,
      })
      .returning();
    if (!row) throw new Error("message insert returned nothing");
    await this.emit("message.sent", {
      messageId: row.id,
      kind,
      from: this.scope.taskKey,
      to: to === "user" ? "user" : to.taskKey,
      body,
    });
    return row;
  }

  async askAgent(taskKey: string, question: string): Promise<string> {
    const [target] = await this.db
      .select()
      .from(tasks)
      .where(and(eq(tasks.missionId, this.scope.missionId), eq(tasks.key, taskKey), ne(tasks.planVersion, 0)))
      .orderBy(desc(tasks.planVersion))
      .limit(1);
    if (!target) return `there is no task ${taskKey} in this mission`;
    if (target.id === this.scope.taskId) return "that is your own task";
    // Nobody is working on a task that is not running: the question goes to the user instead.
    const to = ACTIVE.includes(target.status) ? { taskId: target.id, taskKey } : ("user" as const);
    const q = await this.send(to, "question", question);
    const until = Date.now() + this.opts.answerWaitMs;
    while (Date.now() < until && !this.opts.signal?.aborted) {
      const [answer] = await this.db.select().from(messages).where(eq(messages.replyToId, q.id)).limit(1);
      if (answer) return `${to === "user" ? "the user" : taskKey} answered: ${answer.body}`;
      await new Promise((r) => setTimeout(r, this.opts.pollMs ?? 500));
    }
    return `no answer yet from ${to === "user" ? "the user" : taskKey}; carry on with your best assumption and say what you assumed`;
  }

  async askUser(question: string, opts: { waitMs?: number } = {}): Promise<string | null> {
    const q = await this.send("user", "question", question);
    const until = Date.now() + (opts.waitMs ?? this.opts.answerWaitMs);
    while (Date.now() < until && !this.opts.signal?.aborted) {
      const [answer] = await this.db.select().from(messages).where(eq(messages.replyToId, q.id)).limit(1);
      if (answer) return answer.body;
      await new Promise((r) => setTimeout(r, this.opts.pollMs ?? 500));
    }
    return null;
  }

  async inbox(): Promise<InboxMessage[]> {
    const rows = await this.db
      .select({ m: messages, from: tasks.key })
      .from(messages)
      .leftJoin(schema.attempts, eq(schema.attempts.id, messages.fromAttemptId))
      .leftJoin(tasks, eq(tasks.id, schema.attempts.taskId))
      .where(
        and(
          eq(messages.toTaskId, this.scope.taskId),
          eq(messages.status, "open"),
          inArray(messages.kind, ["question", "note"]),
        ),
      )
      .orderBy(messages.createdAt);
    const fresh = rows.filter(
      (r) => !this.delivered.has(r.m.id) && r.m.fromAttemptId !== this.scope.attemptId,
    );
    for (const r of fresh) this.delivered.add(r.m.id);
    // Notes need no reply; reading them closes them.
    const notes = fresh.filter((r) => r.m.kind === "note").map((r) => r.m.id);
    if (notes.length)
      await this.db.update(messages).set({ status: "closed" }).where(inArray(messages.id, notes));
    return fresh.map((r) => ({ id: r.m.id, kind: r.m.kind, from: r.from ?? "user", body: r.m.body }));
  }

  async answer(messageId: string, text: string): Promise<void> {
    const [q] = await this.db
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.id, messageId),
          eq(messages.toTaskId, this.scope.taskId),
          eq(messages.kind, "question"),
        ),
      );
    if (!q) throw new Error(`no question ${messageId} for this task`);
    if (q.status === "answered") throw new Error("that question was already answered");
    const [row] = await this.db
      .insert(messages)
      .values({
        workspaceId: this.scope.workspaceId,
        missionId: this.scope.missionId,
        fromAttemptId: this.scope.attemptId,
        toAttemptId: q.fromAttemptId,
        toUser: q.fromAttemptId === null,
        kind: "answer",
        replyToId: q.id,
        body: text,
      })
      .returning();
    await this.db.update(messages).set({ status: "answered" }).where(eq(messages.id, q.id));
    await this.emit("message.answered", {
      messageId: row?.id,
      questionId: q.id,
      from: this.scope.taskKey,
      body: text,
    });
  }

  async reportBlocker(description: string): Promise<void> {
    await this.send("user", "blocker", description);
  }

  async requestReview(note: string): Promise<void> {
    await this.send("user", "review_request", note);
  }

  async reportProgress(note: string): Promise<void> {
    await this.emit("attempt.message", { role: "progress", text: note });
  }

  async getContract(name: string): Promise<string> {
    const [c] = await this.db
      .select()
      .from(contracts)
      .where(
        and(
          eq(contracts.missionId, this.scope.missionId),
          eq(contracts.name, name),
          eq(contracts.status, "active"),
        ),
      )
      .orderBy(desc(contracts.createdAt))
      .limit(1);
    if (!c) return `no contract named ${name} yet`;
    return `${c.name} v${c.version}\n\n${typeof c.spec === "string" ? c.spec : JSON.stringify(c.spec, null, 2)}`;
  }

  async getBrief(): Promise<string> {
    const [m] = await this.db.select().from(missions).where(eq(missions.id, this.scope.missionId));
    const active = await this.db
      .select({ name: contracts.name, version: contracts.version })
      .from(contracts)
      .where(and(eq(contracts.missionId, this.scope.missionId), eq(contracts.status, "active")));
    const incoming = await this.db.select().from(handoffs).where(eq(handoffs.toTaskId, this.scope.taskId));
    return [
      `Mission goal: ${m?.goal ?? "unknown"}`,
      active.length
        ? `Contracts: ${active.map((c) => `${c.name} v${c.version}`).join(", ")}`
        : "No contracts yet.",
      ...incoming.map((h) => `From ${h.packet.from.taskKey}: ${h.packet.done.join("; ")}`),
    ].join("\n");
  }
}
