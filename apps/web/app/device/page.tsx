import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/server-api";
import { DeviceForm } from "./device-form";

export const metadata: Metadata = { title: "Sign in the CLI" };
export const dynamic = "force-dynamic";

/** The device flow's verification page (RFC 8628): the person confirms the code `brio login` shows in the terminal. */
export default async function DevicePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const code = typeof params.user_code === "string" ? params.user_code : "";
  const user = await getSessionUser();
  if (!user) redirect(`/sign-in?next=${encodeURIComponent(`/device${code ? `?user_code=${code}` : ""}`)}`);
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-6 px-6">
      <header className="flex flex-col gap-1">
        <p className="font-mono text-2xs uppercase tracking-[0.08em] text-fg-muted">brio login</p>
        <h1 className="text-xl font-semibold tracking-tight">Sign in the Brio CLI</h1>
        <p className="text-fg-muted">
          The terminal will act as you ({user.email}): start and follow missions, approve plans and pull
          requests. Check the code matches the one in your terminal.
        </p>
      </header>
      <DeviceForm initialCode={code} />
      <p className="text-xs text-fg-subtle">
        Only approve a code you got from a terminal you started yourself.
      </p>
    </main>
  );
}
