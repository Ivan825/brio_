import { eq } from "drizzle-orm";
import type { Db } from "./client";
import { members, projects, users, workspaces } from "./schema/index";

/** Fixed ids so seeding is idempotent. */
export const DEMO = {
  userId: "01900000-0000-7000-8000-000000000001",
  workspaceId: "01900000-0000-7000-8000-000000000002",
  projectId: "01900000-0000-7000-8000-000000000003",
  email: "demo@brio.local",
} as const;

/** Demo user, workspace (owner membership) and project. Safe to run repeatedly. */
export async function seedDemo(db: Db): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .insert(users)
      .values({ id: DEMO.userId, name: "Demo", email: DEMO.email, emailVerified: true })
      .onConflictDoNothing();
    await tx
      .insert(workspaces)
      .values({ id: DEMO.workspaceId, name: "Demo workspace", slug: "demo" })
      .onConflictDoNothing();
    const existing = await tx.select().from(members).where(eq(members.workspaceId, DEMO.workspaceId));
    if (existing.length === 0) {
      await tx.insert(members).values({ workspaceId: DEMO.workspaceId, userId: DEMO.userId, role: "owner" });
    }
    await tx
      .insert(projects)
      .values({
        id: DEMO.projectId,
        workspaceId: DEMO.workspaceId,
        name: "demo",
        kind: "git",
        repoUrl: "https://github.com/Ivan825/brio_",
        defaultBranch: "main",
      })
      .onConflictDoNothing();
  });
}
