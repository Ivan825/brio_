import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { AppShell } from "@/components/app-shell";
import { UserMenu } from "@/components/user-menu";
import { WorkspaceSwitcher } from "@/components/workspace-switcher";
import { getSessionUser, getWorkspaces } from "@/lib/server-api";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: ReactNode }) {
  const user = await getSessionUser();
  if (!user) redirect("/sign-in");
  const { workspaces } = await getWorkspaces();
  return (
    <AppShell
      workspaceSwitcher={<WorkspaceSwitcher workspaces={workspaces} />}
      userMenu={<UserMenu email={user.email} />}
    >
      {children}
    </AppShell>
  );
}
