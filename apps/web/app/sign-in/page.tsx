import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getSessionUser, serverApi } from "@/lib/server-api";
import { SignInForm } from "./sign-in-form";

export const metadata: Metadata = { title: "Sign in" };
export const dynamic = "force-dynamic";

/** The authorization request parameters an MCP client sent, to resume it after sign-in. */
const OAUTH_PARAMS = [
  "response_type",
  "client_id",
  "redirect_uri",
  "scope",
  "state",
  "code_challenge",
  "code_challenge_method",
  "resource",
  "prompt",
  "nonce",
];

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const next = typeof params.next === "string" ? params.next : undefined;
  // Sent here by an OAuth authorization (an MCP client signing in): carry on with it once signed in.
  const oauth = new URLSearchParams();
  if (typeof params.client_id === "string")
    for (const k of OAUTH_PARAMS) {
      const v = params[k];
      if (typeof v === "string") oauth.set(k, v);
    }
  const safeNext = oauth.has("client_id")
    ? `/oauth/continue?${oauth}`
    : next?.startsWith("/") && !next.startsWith("//")
      ? next
      : "/missions";
  if (await getSessionUser()) redirect(safeNext);
  const { data } = await serverApi<{ google: boolean }>("/v1/auth/providers");
  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center gap-8 px-6">
      <SignInForm next={safeNext} google={data?.google ?? false} />
    </main>
  );
}
