"use client";

import { BRAND } from "@brio/brand";
import { KeyRound, Mail } from "lucide-react";
import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import { Button } from "@/components/button";
import { FormError, Input, Label } from "@/components/field";
import { useRunning } from "@/components/running";
import { Wordmark } from "@/components/wordmark";
import { authClient } from "@/lib/auth-client";

export function SignInForm({
  next,
  google,
  linkFailed = false,
}: {
  next: string;
  google: boolean;
  /** The emailed link was already used or has expired. */
  linkFailed?: boolean;
}) {
  const router = useRouter();
  const { setRunning } = useRunning();
  const [email, setEmail] = useState("");
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(fn: () => Promise<{ error?: { message?: string } | null } | undefined>) {
    setBusy(true);
    setRunning("sign-in", true);
    setError(null);
    try {
      const res = await fn();
      if (res?.error) throw new Error(res.error.message ?? "sign-in failed");
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
      setRunning("sign-in", false);
    }
  }

  async function magic(e: FormEvent) {
    e.preventDefault();
    // A used or expired link comes back to this page with ?error=…, rather than to a bare error.
    const errorCallbackURL = `/sign-in?next=${encodeURIComponent(next)}`;
    if (await run(() => authClient.signIn.magicLink({ email, callbackURL: next, errorCallbackURL })))
      setSentTo(email);
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Wordmark className="text-2xl" />
        <p className="text-fg-muted">{BRAND.tagline}</p>
      </div>

      {linkFailed && !sentTo ? (
        <p
          role="alert"
          data-testid="link-failed"
          className="rounded-md border border-warning px-3 py-2 text-sm text-fg-muted"
        >
          That sign-in link was already used or has expired: each link works once, for 15 minutes. If you
          opened it before in another window or browser, you are signed in there. Otherwise, ask for a new one
          below.
        </p>
      ) : null}

      {sentTo ? (
        <section
          className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-4"
          aria-live="polite"
        >
          <h1 className="text-md font-semibold">Check your email</h1>
          <p className="text-fg-muted">
            We sent a sign-in link to <span className="font-mono text-fg">{sentTo}</span>. It works for 15
            minutes.
          </p>
          <p className="font-mono text-xs text-fg-subtle">
            running locally? the link is printed in the API log. open it once: it works only once.
          </p>
          <Button variant="ghost" size="sm" className="self-start" onClick={() => setSentTo(null)}>
            Use a different email
          </Button>
        </section>
      ) : (
        <section className="flex flex-col gap-4">
          <h1 className="text-lg font-semibold tracking-tight">Sign in</h1>
          <form onSubmit={magic} className="flex flex-col gap-2">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              autoComplete="email webauthn"
              required
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <Button type="submit" variant="primary" disabled={busy || !email}>
              <Mail className="h-4 w-4" aria-hidden="true" />
              Email me a sign-in link
            </Button>
          </form>
          <div className="flex items-center gap-3 font-mono text-2xs text-fg-subtle">
            <span className="h-px flex-1 bg-line" />
            or
            <span className="h-px flex-1 bg-line" />
          </div>
          <Button
            disabled={busy}
            onClick={async () => {
              if (await run(() => authClient.signIn.passkey())) {
                router.push(next);
                router.refresh();
              }
            }}
          >
            <KeyRound className="h-4 w-4" aria-hidden="true" />
            Sign in with a passkey
          </Button>
          {google && (
            <Button
              disabled={busy}
              onClick={() => run(() => authClient.signIn.social({ provider: "google", callbackURL: next }))}
            >
              Continue with Google
            </Button>
          )}
          <FormError>{error}</FormError>
        </section>
      )}
    </div>
  );
}
