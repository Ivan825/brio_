import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/server-api";
import { ConsentForm } from "./consent-form";

export const metadata: Metadata = { title: "Allow access" };
export const dynamic = "force-dynamic";

/** What a scope lets an MCP client do, in words a person can judge. */
const SCOPES: Record<string, string> = {
  brio: "Start missions, read their reports and status, and talk to their agents — as you, in your workspace",
  openid: "Know who you are",
  profile: "See your name",
  email: "See your email address",
  offline_access: "Stay signed in until you revoke it",
};

export default async function ConsentPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const user = await getSessionUser();
  const query = new URLSearchParams(
    Object.entries(params).flatMap(([k, v]) =>
      typeof v === "string" ? [[k, v]] : (v ?? []).map((x) => [k, x]),
    ),
  );
  if (!user) redirect(`/sign-in?next=${encodeURIComponent(`/oauth/consent?${query}`)}`);
  const clientId = typeof params.client_id === "string" ? params.client_id : "";
  let client = clientId;
  try {
    // Client ID Metadata Documents name the client by URL: its host is what a person recognises.
    client = new URL(clientId).host || clientId;
  } catch {}
  const scopes = (typeof params.scope === "string" ? params.scope : "").split(" ").filter(Boolean);
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-6 px-6">
      <header className="flex flex-col gap-1">
        <p className="font-mono text-2xs uppercase tracking-[0.08em] text-fg-muted">allow access</p>
        <h1 className="text-xl font-semibold tracking-tight">An agent wants to use Brio as you</h1>
        <p className="text-fg-muted">
          <span className="font-mono text-fg">{client}</span> asks to connect to your Brio account (
          {user.email}).
        </p>
      </header>
      <ul className="flex flex-col gap-2" aria-label="What it may do">
        {scopes.map((s) => (
          <li key={s} className="rounded-md border border-line bg-surface px-3 py-2 text-sm">
            {SCOPES[s] ?? s}
          </li>
        ))}
      </ul>
      <ConsentForm />
      <p className="text-xs text-fg-subtle">
        You can revoke it any time. Only allow agents you started yourself.
      </p>
    </main>
  );
}
