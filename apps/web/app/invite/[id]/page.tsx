import type { Metadata } from "next";
import Link from "next/link";
import { buttonVariants } from "@/components/button";
import { Wordmark } from "@/components/wordmark";
import { getSessionUser } from "@/lib/server-api";
import { AcceptInvite } from "./accept-invite";

export const metadata: Metadata = { title: "Invitation" };
export const dynamic = "force-dynamic";

export default async function InvitePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getSessionUser();
  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center gap-6 px-6">
      <Wordmark className="text-2xl" />
      <h1 className="text-lg font-semibold tracking-tight">You have been invited to a workspace</h1>
      {user ? (
        <AcceptInvite invitationId={id} email={user.email} />
      ) : (
        <>
          <p className="text-fg-muted">Sign in with the email address the invitation was sent to.</p>
          <Link
            href={`/sign-in?next=${encodeURIComponent(`/invite/${id}`)}`}
            className={buttonVariants({ variant: "primary" })}
          >
            Sign in to accept
          </Link>
        </>
      )}
    </main>
  );
}
