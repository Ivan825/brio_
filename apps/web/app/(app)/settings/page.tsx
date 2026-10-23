import type { Metadata } from "next";
import { EmptyState } from "@/components/empty-state";
import { getWorkspaces, serverApi } from "@/lib/server-api";
import { InviteMember, PasskeySettings, RenameWorkspace } from "./settings-forms";

export const metadata: Metadata = { title: "Settings" };

interface MembersResponse {
  members: { userId: string; name: string; email: string; role: string; joinedAt: string }[];
  invitations: { id: string; email: string; role: string; expiresAt: string }[];
}

export default async function SettingsPage() {
  const { workspaces } = await getWorkspaces();
  const active = workspaces.find((w) => w.active);
  if (!active) {
    return (
      <EmptyState label="settings" command="brio workspace show" title="Workspace settings">
        Create or switch to a workspace from the header to manage its name, members and invitations.
      </EmptyState>
    );
  }
  const { data } = await serverApi<MembersResponse>(`/v1/workspaces/${active.id}/members`);
  const canManage = active.role === "owner" || active.role === "admin";

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-10 px-6 py-8">
      <header className="flex flex-col gap-1">
        <p className="font-mono text-2xs uppercase tracking-[0.08em] text-fg-muted">settings</p>
        <h1 className="text-xl font-semibold tracking-tight">Workspace settings</h1>
        <p className="font-mono text-xs text-fg-subtle">
          {active.slug} · you are {active.role}
        </p>
      </header>

      <section aria-labelledby="general" className="flex flex-col gap-3">
        <h2 id="general" className="font-mono text-2xs uppercase tracking-[0.08em] text-fg-muted">
          General
        </h2>
        <RenameWorkspace id={active.id} name={active.name} disabled={!canManage} />
      </section>

      <section aria-labelledby="members" className="flex flex-col gap-3">
        <h2 id="members" className="font-mono text-2xs uppercase tracking-[0.08em] text-fg-muted">
          Members
        </h2>
        <ul className="divide-y divide-line rounded-lg border border-line" aria-label="Members">
          {data?.members.map((m) => (
            <li key={m.userId} className="flex items-center gap-3 px-4 py-2.5">
              <span className="min-w-0 flex-1 truncate">{m.name || m.email}</span>
              <span className="hidden truncate font-mono text-xs text-fg-muted sm:inline">{m.email}</span>
              <span className="font-mono text-2xs text-fg-subtle">{m.role}</span>
            </li>
          ))}
          {data?.invitations.map((i) => (
            <li key={i.id} className="flex items-center gap-3 px-4 py-2.5 text-fg-muted">
              <span className="min-w-0 flex-1 truncate font-mono text-xs">{i.email}</span>
              <span className="font-mono text-2xs text-fg-subtle">invited · {i.role}</span>
            </li>
          ))}
        </ul>
        {canManage && <InviteMember workspaceId={active.id} />}
      </section>

      <section aria-labelledby="security" className="flex flex-col gap-3">
        <h2 id="security" className="font-mono text-2xs uppercase tracking-[0.08em] text-fg-muted">
          Your account
        </h2>
        <PasskeySettings />
      </section>
    </div>
  );
}
