// Vendor webhooks. Public routes, so nothing is trusted until the signature checks out: each receiver URL names its
// connector, whose key fetches the vendor's signing key. A verified event goes on the attempt's board at once; runs
// still follow their jobs by polling, so a lost or forged webhook can neither finish nor fail anything.
import { manusEvent, manusPublicKey, ServiceClient, verifyManusSignature } from "@brio/adapters";
import { schema } from "@brio/db";
import { and, eq, isNull } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { connectorConfig, credentialOf } from "../connectors";
import type { AppContext } from "../context";
import { HttpError } from "../http";

const { attempts, connectors, tasks } = schema;
const Params = z.object({ connectorId: z.uuid() });

/** The URL Brio registers with Manus for a connector (also what its signatures cover). */
export const manusHookUrl = (appUrl: string, connectorId: string) =>
  `${appUrl.replace(/\/+$/, "")}/v1/hooks/manus/${connectorId}`;

export async function hookRoutes(app: FastifyInstance, ctx: AppContext) {
  const keys = new Map<string, { pem: string; until: number }>();

  await app.register(async (sub) => {
    // Signatures cover the exact bytes: keep the body as sent.
    sub.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) =>
      done(null, body),
    );

    sub.post("/v1/hooks/manus/:connectorId", async (req, reply) => {
      const { connectorId } = Params.parse(req.params);
      const [row] = await ctx.db
        .select()
        .from(connectors)
        .where(
          and(
            eq(connectors.id, connectorId),
            eq(connectors.registryKey, "manus"),
            isNull(connectors.deletedAt),
          ),
        );
      if (!row) throw new HttpError(404, "no such receiver", "not_found");
      const body = typeof req.body === "string" ? req.body : "";
      let key = keys.get(row.id);
      if (!key || key.until < Date.now()) {
        const api = new ServiceClient(connectorConfig(row), {
          credential: await credentialOf(ctx, row),
          fetch: ctx.fetch,
        });
        key = { pem: await manusPublicKey(api), until: Date.now() + 60 * 60_000 };
        keys.set(row.id, key);
      }
      const header = (h: string) => {
        const v = req.headers[h];
        return Array.isArray(v) ? v[0] : v;
      };
      const ok = verifyManusSignature({
        publicKey: key.pem,
        url: manusHookUrl(ctx.config.APP_URL, row.id),
        body,
        timestamp: header("x-webhook-timestamp"),
        signature: header("x-webhook-signature"),
      });
      if (!ok) throw new HttpError(401, "the signature does not check out", "bad_signature");

      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        throw new HttpError(400, "not JSON", "bad_request");
      }
      const e = manusEvent(parsed);
      if (e.taskId) {
        const [hit] = await ctx.db
          .select({ attempt: attempts, missionId: tasks.missionId })
          .from(attempts)
          .innerJoin(tasks, eq(tasks.id, attempts.taskId))
          .where(and(eq(attempts.workspaceId, row.workspaceId), eq(attempts.transcriptRef, e.taskId)));
        if (hit)
          await ctx.events.append(ctx.db, {
            workspaceId: row.workspaceId,
            missionId: hit.missionId,
            taskId: hit.attempt.taskId,
            attemptId: hit.attempt.id,
            type: "attempt.message",
            actor: "system",
            payload: {
              role: "progress",
              text: `Manus: ${e.type.replace(/_/g, " ")}${e.stopReason ? ` (${e.stopReason})` : ""}${e.message ? `: ${e.message.slice(0, 500)}` : ""}`,
            },
          });
      }
      return reply.status(200).send({ ok: true });
    });
  });
}
