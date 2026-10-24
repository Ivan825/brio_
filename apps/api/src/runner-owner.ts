// A project that lives on a person's machine (a local runner) is theirs to steer (security review H2, D-101): its
// agents run commands there as that person. Only they change what runs there — the agents bound to the runner, the
// project, a mission's plan (edits, replans, approvals), reviews of its results, its memory and its deliveries.
import { type DbOrTx, schema } from "@brio/db";
import type { Actor } from "@brio/schema";
import { and, eq, isNull } from "drizzle-orm";
import { HttpError } from "./http";

const { projects, runners, users } = schema;

export interface RunnerOwner {
  runnerId: string;
  name: string;
  ownerId: string;
  owner: string;
}

/** The local runner a project lives on, with its owner; null for a project that does not live on one. */
export async function projectRunnerOwner(db: DbOrTx, projectId: string | null): Promise<RunnerOwner | null> {
  if (!projectId) return null;
  const [r] = await db
    .select({ runnerId: runners.id, name: runners.name, ownerId: runners.ownerId, owner: users.email })
    .from(projects)
    .innerJoin(runners, eq(runners.id, projects.runnerId))
    .innerJoin(users, eq(users.id, runners.ownerId))
    .where(and(eq(projects.id, projectId), isNull(runners.revokedAt)));
  return r ?? null;
}

/** The person an actor ("user:<id>", or a bare user id) is; null for the system and agents. */
export const userOf = (actor: Actor | string | null): string | null =>
  !actor || actor === "system"
    ? null
    : actor.startsWith("user:")
      ? actor.slice(5)
      : actor.includes(":")
        ? null
        : actor;

/**
 * Throws unless the person is the owner of the runner the project lives on (a no-op for other projects). `what` says
 * what was refused, for the message.
 */
export async function requireRunnerOwner(
  db: DbOrTx,
  projectId: string | null,
  who: Actor | string | null,
  what: string,
): Promise<void> {
  const r = await projectRunnerOwner(db, projectId);
  if (!r) return;
  if (userOf(who) !== r.ownerId)
    throw new HttpError(
      403,
      `${r.name} is ${r.owner}'s machine: only they can ${what} for work that runs there`,
      "runner_owner_only",
    );
}

/** Throws unless the person owns this local runner (for what is bound to it: agents). */
export async function requireOwnRunner(
  db: DbOrTx,
  runnerId: string | null,
  who: Actor | string | null,
  what: string,
): Promise<void> {
  if (!runnerId) return;
  const [r] = await db
    .select({ name: runners.name, ownerId: runners.ownerId, owner: users.email })
    .from(runners)
    .innerJoin(users, eq(users.id, runners.ownerId))
    .where(eq(runners.id, runnerId));
  if (r && userOf(who) !== r.ownerId)
    throw new HttpError(
      403,
      `${r.name} is ${r.owner}'s machine: only they can ${what} on it`,
      "runner_owner_only",
    );
}
