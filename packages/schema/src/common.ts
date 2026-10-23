import { z } from "zod";

/** UUID (v7 in practice; any RFC 4122 version accepted on input). */
export const Id = z.uuid();
export type Id = z.infer<typeof Id>;

/** Accepts Date objects (from the DB) and ISO strings (from JSON). */
export const Timestamp = z.coerce.date();

/** USD amount; stored as numeric(12,6) in Postgres. */
export const Usd = z.number().finite().nonnegative();

export const Json = z.record(z.string(), z.unknown());
export type Json = z.infer<typeof Json>;

/** Fields every workspace-scoped table carries (ARCHITECTURE §3). */
export const WorkspaceScoped = z.object({
  id: Id,
  workspaceId: Id,
  createdAt: Timestamp,
  updatedAt: Timestamp,
});

export const SoftDeletable = z.object({ deletedAt: Timestamp.nullable() });

/** Who did something: the system, a user or an agent. */
export const Actor = z.union([
  z.literal("system"),
  z.templateLiteral(["user:", z.string().min(1)]),
  z.templateLiteral(["agent:", z.string().min(1)]),
]);
export type Actor = z.infer<typeof Actor>;

export const Sha256 = z.string().regex(/^[0-9a-f]{64}$/, "lowercase hex sha256");
