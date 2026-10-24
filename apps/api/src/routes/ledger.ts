// The audit ledger (M9, SECURITY_GOVERNANCE §8): the workspace's hash-chained record of spend, decisions, keys,
// policies and side effects — read page by page, verified end to end (anyone can check that nothing was changed,
// removed or inserted), and exported for auditors as JSON Lines or CSV. Owners and admins only.
import { schema } from "@brio/db";
import { type ChainEntry, canonicalJson, verifyChain } from "@brio/governance";
import { LedgerKind } from "@brio/schema";
import { and, asc, desc, eq, isNotNull, lt } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context";
import { requireMember, requireSession, workspaceFor } from "../http";

const { ledger } = schema;

const Page = z.object({
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  kind: LedgerKind.optional(),
});
const Export = z.object({ format: z.enum(["jsonl", "csv"]).default("jsonl") });

const csvCell = (v: unknown) => {
  const s = typeof v === "string" ? v : canonicalJson(v);
  return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
};

export async function ledgerRoutes(app: FastifyInstance, ctx: AppContext) {
  const auditor = async (req: Parameters<typeof requireSession>[1]) => {
    const s = await requireSession(ctx, req);
    const workspaceId = workspaceFor(req, s);
    await requireMember(ctx, workspaceId, s, ["owner", "admin"]);
    // Entries written a moment ago are chained before anyone reads (D-98).
    await ctx.ledger.chain(ctx.db, workspaceId);
    return workspaceId;
  };
  const chain = async (workspaceId: string) =>
    (
      await ctx.db
        .select()
        .from(ledger)
        .where(and(eq(ledger.workspaceId, workspaceId), isNotNull(ledger.hash)))
        .orderBy(asc(ledger.seq))
    ).map(
      (r) =>
        ({
          workspaceId: r.workspaceId,
          seq: r.seq,
          kind: r.kind,
          payload: r.payload,
          prevHash: r.prevHash,
          hash: r.hash,
          createdAt: r.createdAt,
        }) as ChainEntry & { createdAt: Date },
    );

  /** Newest first, a page at a time (`before` a seq). */
  app.get("/v1/ledger", async (req) => {
    const workspaceId = await auditor(req);
    const q = Page.parse(req.query);
    const rows = await ctx.db
      .select()
      .from(ledger)
      .where(
        and(
          eq(ledger.workspaceId, workspaceId),
          isNotNull(ledger.hash),
          ...(q.before ? [lt(ledger.seq, q.before)] : []),
          ...(q.kind ? [eq(ledger.kind, q.kind)] : []),
        ),
      )
      .orderBy(desc(ledger.seq))
      .limit(q.limit);
    return {
      entries: rows.map(({ seq, kind, payload, hash, prevHash, createdAt }) => ({
        seq,
        kind,
        payload,
        hash,
        prevHash,
        createdAt,
      })),
      next: rows.length === q.limit ? rows.at(-1)?.seq : null,
    };
  });

  /** Recomputes every hash from the first entry: whether the chain is whole, or where it breaks. */
  app.get("/v1/ledger/verify", async (req) => {
    const workspaceId = await auditor(req);
    const entries = await chain(workspaceId);
    return { ...verifyChain(entries), checkedAt: new Date().toISOString() };
  });

  app.get("/v1/ledger/export", async (req, reply) => {
    const workspaceId = await auditor(req);
    const { format } = Export.parse(req.query);
    const entries = await chain(workspaceId);
    const day = new Date().toISOString().slice(0, 10);
    reply.header("content-disposition", `attachment; filename="brio-ledger-${day}.${format}"`);
    if (format === "csv") {
      const lines = [
        "seq,created_at,kind,payload,prev_hash,hash",
        ...entries.map((e) =>
          [e.seq, e.createdAt.toISOString(), e.kind, e.payload, e.prevHash, e.hash].map(csvCell).join(","),
        ),
      ];
      return reply.type("text/csv; charset=utf-8").send(`${lines.join("\n")}\n`);
    }
    return reply.type("application/x-ndjson; charset=utf-8").send(
      entries
        .map((e) => JSON.stringify({ ...e, createdAt: e.createdAt.toISOString() }))
        .join("\n")
        .concat("\n"),
    );
  });
}
