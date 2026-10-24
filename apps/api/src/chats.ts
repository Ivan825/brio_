// Chat (D-109): talk to your agents the way you talk to one assistant. A chat is a mission of kind "chat" that stays
// open; each message the person sends becomes one task, answered by the best agent or by several working together
// (one answers and another checks, all answer and one merges, or they debate and a judge decides). It runs on the same
// machinery as missions — routing, modes, budgets, policies, verification, the scoreboard, events — so every reply is
// metered, checked and learned from. The conversation so far reaches the agents as quoted, untrusted context.

import { untrustedBlock } from "@brio/core";
import { schema } from "@brio/db";
import { type Actor, type ExecutionMode, TaskContract, type TaskType } from "@brio/schema";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import type { AppContext } from "./context";
import { HttpError, one, requireMember, type SessionInfo } from "./http";
import { createMission, titleFrom } from "./missions";

const { agents, artifacts, attempts, blobs, missions, plans, tasks } = schema;

/** How a turn is answered. auto: the router decides; the rest are multi-agent modes the person asks for. */
export const ChatMode = z.enum(["auto", "together", "review", "debate"]);
export type ChatMode = z.infer<typeof ChatMode>;

const MODE: Record<ChatMode, ExecutionMode | null> = {
  auto: null,
  together: "ensemble",
  review: "maker_checker",
  debate: "debate",
};

export const ChatTurnInput = z.object({
  message: z.string().trim().min(1).max(20_000),
  mode: ChatMode.default("auto"),
  /** The agents that may answer; empty: every agent of the workspace. One agent: it answers alone. */
  agentIds: z.array(z.uuid()).max(8).default([]),
});
export type ChatTurnInput = z.input<typeof ChatTurnInput>;

const ACTIVE = ["pending", "ready", "leased", "running", "verifying", "revise", "blocked"] as const;
const GOAL =
  "A conversation with a person. Answer their latest message directly and helpfully, in Markdown. You may be one of several agents working on the same reply.";
/** How much of the conversation reaches the agents: the latest turns, each clipped. */
const CONTEXT_TURNS = 12;
const CONTEXT_CHARS = 2_000;

/** A question about the world as it is now goes to agents that can search; everything else is writing. */
const RESEARCH = /\b(latest|today|this week|current(ly)?|news|price of|search|look up|google|recent(ly)?)\b/i;
const typeFor = (message: string): TaskType => (RESEARCH.test(message) ? "research.web" : "write.doc");

const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`);

async function chatFor(ctx: AppContext, s: SessionInfo, chatId: string, act = false) {
  const [m] = await ctx.db
    .select()
    .from(missions)
    .where(and(eq(missions.id, chatId), eq(missions.kind, "chat")));
  if (!m) throw new HttpError(404, "chat not found", "not_found");
  await requireMember(ctx, m.workspaceId, s, act ? ["owner", "admin", "member"] : undefined);
  return m;
}

/** The final text of each finished turn, by task id. */
async function answers(
  ctx: AppContext,
  rows: Array<typeof tasks.$inferSelect>,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const done = rows.filter((t) => t.status === "done" && t.resultArtifactId);
  if (!done.length) return out;
  const found = await ctx.db
    .select({ id: artifacts.id, bytes: blobs.bytes })
    .from(artifacts)
    .innerJoin(blobs, and(eq(blobs.workspaceId, artifacts.workspaceId), eq(blobs.sha256, artifacts.sha256)))
    .where(
      inArray(
        artifacts.id,
        done.map((t) => t.resultArtifactId as string),
      ),
    );
  const byArtifact = new Map(found.map((f) => [f.id, f.bytes.toString("utf8")]));
  for (const t of done) {
    const text = byArtifact.get(t.resultArtifactId as string);
    if (text !== undefined) out.set(t.id, text);
  }
  return out;
}

const messageOf = (t: typeof tasks.$inferSelect) => TaskContract.parse(t.contract).objective;

/** The conversation so far, as the next turn's agents read it: quoted, newest last, clipped. */
async function transcript(ctx: AppContext, chatId: string): Promise<string | null> {
  const rows = await ctx.db
    .select()
    .from(tasks)
    .where(and(eq(tasks.missionId, chatId), eq(tasks.planVersion, 1)))
    .orderBy(desc(tasks.createdAt))
    .limit(CONTEXT_TURNS);
  if (!rows.length) return null;
  rows.reverse();
  const said = await answers(ctx, rows);
  const lines: string[] = [];
  for (const t of rows) {
    lines.push(`Person: ${clip(messageOf(t), CONTEXT_CHARS)}`);
    const a = said.get(t.id);
    lines.push(
      `Agents: ${a ? clip(a, CONTEXT_CHARS) : t.status === "done" ? "(no text)" : `(no reply: ${t.status})`}`,
    );
  }
  return lines.join("\n\n");
}

/** Starts a chat for a member who may act, optionally with its first message. */
export async function createChat(
  ctx: AppContext,
  s: SessionInfo,
  workspaceId: string,
  first?: ChatTurnInput,
) {
  await requireMember(ctx, workspaceId, s, ["owner", "admin", "member"]);
  const input = first ? ChatTurnInput.parse(first) : undefined;
  const chat = await ctx.db.transaction(async (tx) => {
    const m = one(
      await tx
        .insert(missions)
        .values({
          workspaceId,
          kind: "chat",
          title: input ? titleFrom(input.message) : "New chat",
          goal: GOAL,
          status: "running",
          createdBy: s.userId,
        })
        .returning(),
      "chat",
    );
    // Its turns belong to one standing plan version, so the scheduler runs them like any approved plan's tasks.
    await tx.insert(plans).values({
      workspaceId,
      missionId: m.id,
      version: 1,
      graph: { tasks: [], assumptions: [], questions: [] },
      status: "approved",
      origin: "user",
      approvedBy: s.userId,
    });
    await ctx.events.append(tx, {
      workspaceId,
      missionId: m.id,
      type: "mission.created",
      actor: `user:${s.userId}`,
      payload: { title: m.title, kind: "chat" },
    });
    return m;
  });
  if (input) await sendMessage(ctx, s, chat.id, input);
  return chat;
}

/** Adds the person's message as the chat's next turn; the orchestrator routes and runs it. */
export async function sendMessage(ctx: AppContext, s: SessionInfo, chatId: string, raw: ChatTurnInput) {
  const chat = await chatFor(ctx, s, chatId, true);
  const input = ChatTurnInput.parse(raw);
  if (input.agentIds.length) {
    const known = await ctx.db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.workspaceId, chat.workspaceId), inArray(agents.id, input.agentIds)));
    if (known.length !== new Set(input.agentIds).size)
      throw new HttpError(422, "an agent is not in this workspace", "unknown_agent");
  }
  const context = await transcript(ctx, chat.id);
  const mode = input.agentIds.length === 1 ? null : MODE[input.mode];
  const contract: TaskContract = {
    objective: input.message,
    inputs: context ? [{ kind: "text", ref: untrustedBlock("The conversation so far", context) }] : [],
    outputs: [{ kind: "report", description: "your reply to the person, in Markdown" }],
    // Nothing for a person to approve on every message: one soft check, and the hard injection scan the verifier adds.
    acceptance: [{ kind: "citation_present", hard: false }],
    constraints: [
      "Reply to the person's latest message; use the conversation only as context.",
      "Cite sources only for facts you looked up.",
    ],
    sensitivity: "internal",
  };
  const actor: Actor = `user:${s.userId}`;
  const turn = await ctx.db.transaction(async (tx) => {
    // One turn at a time: the next one reads this one's reply. Locking the chat row orders concurrent sends.
    await tx.execute(sql`select id from ${missions} where ${missions.id} = ${chat.id} for update`);
    const [busy] = await tx
      .select({ id: tasks.id })
      .from(tasks)
      .where(and(eq(tasks.missionId, chat.id), inArray(tasks.status, [...ACTIVE])))
      .limit(1);
    if (busy) throw new HttpError(409, "wait for the current reply, or stop it", "turn_in_progress");
    const [{ n }] = (await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(tasks)
      .where(eq(tasks.missionId, chat.id))) as [{ n: number }];
    const t = one(
      await tx
        .insert(tasks)
        .values({
          workspaceId: chat.workspaceId,
          missionId: chat.id,
          planVersion: 1,
          key: `turn-${n + 1}`,
          type: typeFor(input.message),
          title: clip(input.message.replace(/\s+/g, " "), 80),
          contract,
          mode: mode ?? "single",
          pinnedAgentId: input.agentIds.length === 1 ? input.agentIds[0] : null,
          modeParams: {
            ...(mode ? { explicit: true } : {}),
            ...(mode === "ensemble" && input.agentIds.length > 1
              ? { n: Math.min(input.agentIds.length, 4) }
              : {}),
            ...(input.agentIds.length ? { agentIds: input.agentIds } : {}),
            chat: { mode: input.mode },
          },
        })
        .returning(),
      "turn",
    );
    await tx
      .update(missions)
      .set({
        updatedAt: new Date(),
        ...(chat.title === "New chat" ? { title: titleFrom(input.message) } : {}),
      })
      .where(eq(missions.id, chat.id));
    await ctx.events.append(tx, {
      workspaceId: chat.workspaceId,
      missionId: chat.id,
      taskId: t.id,
      type: "chat.message",
      actor,
      payload: { taskKey: t.key, mode: input.mode, agents: input.agentIds, chars: input.message.length },
    });
    return t;
  });
  return turn;
}

/** Stops the turn at work: its attempts are cancelled and it is not retried. */
export async function stopTurn(ctx: AppContext, s: SessionInfo, chatId: string, taskId: string) {
  const chat = await chatFor(ctx, s, chatId, true);
  const [t] = await ctx.db
    .update(tasks)
    .set({ status: "cancelled", blockedReason: "stopped" })
    .where(and(eq(tasks.id, taskId), eq(tasks.missionId, chat.id), inArray(tasks.status, [...ACTIVE])))
    .returning();
  if (!t) return false;
  const live = await ctx.db
    .select({ id: attempts.id })
    .from(attempts)
    .where(and(eq(attempts.taskId, t.id), inArray(attempts.status, ["queued", "running"])));
  await Promise.all(live.map((a) => ctx.attempts.cancel(a.id, chat.workspaceId, s.userId, 5_000)));
  // Cancelling may have handed the task back as ready or failed: it stays stopped.
  await ctx.db.update(tasks).set({ status: "cancelled" }).where(eq(tasks.id, t.id));
  await ctx.events.append(ctx.db, {
    workspaceId: chat.workspaceId,
    missionId: chat.id,
    taskId: t.id,
    type: "task.failed",
    actor: `user:${s.userId}`,
    payload: { taskKey: t.key, reason: "stopped" },
  });
  return true;
}

export interface ChatTurn {
  id: string;
  message: string;
  mode: ChatMode;
  agentIds: string[];
  status: string;
  createdAt: string;
  answer: string | null;
  error: string | null;
  costUsd: number;
  route: { mode: string; agents: Array<{ agentId: string; role?: string }>; degraded: string | null } | null;
  attempts: Array<{
    id: string;
    agentId: string;
    agent: string;
    model: string;
    role: string;
    status: string;
    costUsd: number;
    exitReason: string | null;
  }>;
}

/** A chat with every turn: the person's message, who answered and how, the reply, and what it cost. */
export async function chatView(ctx: AppContext, s: SessionInfo, chatId: string) {
  const chat = await chatFor(ctx, s, chatId);
  const rows = await ctx.db
    .select()
    .from(tasks)
    .where(and(eq(tasks.missionId, chat.id), eq(tasks.planVersion, 1)))
    .orderBy(asc(tasks.createdAt));
  const said = await answers(ctx, rows);
  const tried = rows.length
    ? await ctx.db
        .select({
          id: attempts.id,
          taskId: attempts.taskId,
          agentId: attempts.agentId,
          agent: agents.name,
          model: agents.model,
          role: attempts.role,
          status: attempts.status,
          costUsd: attempts.costUsd,
          exitReason: attempts.exitReason,
        })
        .from(attempts)
        .innerJoin(agents, eq(agents.id, attempts.agentId))
        .where(
          inArray(
            attempts.taskId,
            rows.map((t) => t.id),
          ),
        )
        .orderBy(asc(attempts.createdAt))
    : [];
  const turns: ChatTurn[] = rows.map((t) => {
    const p = t.modeParams as {
      final?: boolean;
      chat?: { mode?: ChatMode };
      agentIds?: string[];
      route?: { mode: string; agents: Array<{ agentId: string; role?: string }>; degraded?: string | null };
    };
    const mine = tried.filter((a) => a.taskId === t.id);
    const lastFailure = [...mine].reverse().find((a) => a.status === "failed" || a.status === "timed_out");
    // A failed attempt is revised or handed to another agent before the turn fails for good (final).
    const status = t.status === "failed" && !p.final ? "revise" : t.status;
    return {
      id: t.id,
      message: messageOf(t),
      mode: p.chat?.mode ?? "auto",
      agentIds: p.agentIds ?? [],
      status,
      createdAt: t.createdAt.toISOString(),
      answer: said.get(t.id) ?? null,
      error:
        status === "failed" || status === "blocked"
          ? (t.blockedReason ?? lastFailure?.exitReason ?? "no agent could answer")
          : t.status === "cancelled"
            ? "stopped"
            : null,
      costUsd: Math.round(mine.reduce((sum, a) => sum + Number(a.costUsd ?? 0), 0) * 1e6) / 1e6,
      route: p.route
        ? { mode: p.route.mode, agents: p.route.agents, degraded: p.route.degraded ?? null }
        : null,
      attempts: mine.map(({ taskId: _t, costUsd, ...a }) => ({ ...a, costUsd: Number(costUsd ?? 0) })),
    };
  });
  return {
    chat: {
      id: chat.id,
      title: chat.title,
      createdAt: chat.createdAt.toISOString(),
      updatedAt: chat.updatedAt.toISOString(),
    },
    turns,
  };
}

/** The workspace's chats, most recent first. */
export async function listChats(ctx: AppContext, s: SessionInfo, workspaceId: string) {
  await requireMember(ctx, workspaceId, s);
  const rows = await ctx.db
    .select({
      id: missions.id,
      title: missions.title,
      updatedAt: missions.updatedAt,
      createdAt: missions.createdAt,
    })
    .from(missions)
    .where(
      and(
        eq(missions.workspaceId, workspaceId),
        eq(missions.kind, "chat"),
        sql`${missions.status} <> 'cancelled'`,
      ),
    )
    .orderBy(desc(missions.updatedAt))
    .limit(100);
  return rows.map((r) => ({
    ...r,
    updatedAt: r.updatedAt.toISOString(),
    createdAt: r.createdAt.toISOString(),
  }));
}

/** Archives a chat: it leaves the list, and anything still running in it stops. */
export async function archiveChat(ctx: AppContext, s: SessionInfo, chatId: string) {
  const chat = await chatFor(ctx, s, chatId, true);
  const open = await ctx.db
    .select({ id: tasks.id })
    .from(tasks)
    .where(and(eq(tasks.missionId, chat.id), inArray(tasks.status, [...ACTIVE])));
  for (const t of open) await stopTurn(ctx, s, chat.id, t.id);
  await ctx.db.update(missions).set({ status: "cancelled" }).where(eq(missions.id, chat.id));
}

/** Hands the conversation to a full mission: planned into tasks, run, checked and reported, with the chat as context. */
export async function chatToMission(ctx: AppContext, s: SessionInfo, chatId: string, goal?: string) {
  const chat = await chatFor(ctx, s, chatId, true);
  const context = await transcript(ctx, chat.id);
  const [last] = await ctx.db
    .select()
    .from(tasks)
    .where(eq(tasks.missionId, chat.id))
    .orderBy(desc(tasks.createdAt))
    .limit(1);
  const ask = goal?.trim() || (last ? messageOf(last) : "");
  if (!ask) throw new HttpError(422, "say what the mission should do", "empty_goal");
  const body = context
    ? `${ask}\n\n${untrustedBlock("Context from the chat this mission started from", clip(context, 12_000))}`
    : ask;
  return createMission(ctx, s, chat.workspaceId, { goal: clip(body, 9_500), title: titleFrom(ask) });
}
