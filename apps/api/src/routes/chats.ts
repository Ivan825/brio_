// Chat (D-109): conversations with your agents. Each message becomes a task the orchestrator routes to the best agent,
// or to several working together; the reply streams onto the chat's events (GET /v1/missions/:id/events).
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  archiveChat,
  ChatTurnInput,
  chatToMission,
  chatView,
  createChat,
  listChats,
  sendMessage,
  stopTurn,
} from "../chats";
import type { AppContext } from "../context";
import { requireSession, workspaceFor } from "../http";
import { presentMission } from "./missions";

const Params = z.object({ id: z.uuid() });
const TurnParams = z.object({ id: z.uuid(), turnId: z.uuid() });

export async function chatRoutes(app: FastifyInstance, ctx: AppContext) {
  /** The workspace's chats, most recent first. */
  app.get("/v1/chats", async (req) => {
    const s = await requireSession(ctx, req);
    return { chats: await listChats(ctx, s, workspaceFor(req, s)) };
  });

  /** Starts a chat; with a `message`, its first turn starts at once. */
  app.post("/v1/chats", async (req, reply) => {
    const s = await requireSession(ctx, req);
    const body = z
      .object({ message: z.string().optional() })
      .passthrough()
      .parse(req.body ?? {});
    const chat = await createChat(
      ctx,
      s,
      workspaceFor(req, s),
      body.message ? ChatTurnInput.parse(body) : undefined,
    );
    return reply.status(201).send({ chat: { id: chat.id, title: chat.title } });
  });

  /** A chat with every turn: the message, who answered and how, the reply, its cost. */
  app.get("/v1/chats/:id", async (req) => {
    const s = await requireSession(ctx, req);
    return chatView(ctx, s, Params.parse(req.params).id);
  });

  /** Sends a message: `mode` (auto, together, review, debate) and `agentIds` say who answers and how. */
  app.post("/v1/chats/:id/messages", async (req, reply) => {
    const s = await requireSession(ctx, req);
    const turn = await sendMessage(ctx, s, Params.parse(req.params).id, ChatTurnInput.parse(req.body));
    return reply.status(202).send({ turn: { id: turn.id } });
  });

  /** Stops the reply being worked on. */
  app.post("/v1/chats/:id/turns/:turnId/stop", async (req) => {
    const s = await requireSession(ctx, req);
    const { id, turnId } = TurnParams.parse(req.params);
    return { stopped: await stopTurn(ctx, s, id, turnId) };
  });

  /** Archives a chat (it leaves the list; anything running stops). */
  app.delete("/v1/chats/:id", async (req, reply) => {
    const s = await requireSession(ctx, req);
    await archiveChat(ctx, s, Params.parse(req.params).id);
    return reply.status(204).send();
  });

  /** Hands the conversation to a full mission (planned, run, checked, reported), with the chat as its context. */
  app.post("/v1/chats/:id/mission", async (req, reply) => {
    const s = await requireSession(ctx, req);
    const { goal } = z.object({ goal: z.string().max(5_000).optional() }).parse(req.body ?? {});
    const mission = await chatToMission(ctx, s, Params.parse(req.params).id, goal);
    return reply.status(201).send({ mission: presentMission(mission) });
  });
}
