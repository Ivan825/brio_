"use client";

import { useState } from "react";
import { Button } from "@/components/button";
import { FormError } from "@/components/field";
import { authClient } from "@/lib/auth-client";

/** Allow or deny: Better Auth checks the signed authorization request this page was opened with. */
export function ConsentForm() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function decide(accept: boolean) {
    setBusy(true);
    setError(null);
    const res = await authClient.$fetch<{ url: string }>("/oauth2/consent", {
      method: "POST",
      body: { accept },
    });
    if (res.error || !res.data?.url) {
      setError(res.error?.message ?? "the request could not be completed");
      setBusy(false);
      return;
    }
    window.location.href = res.data.url;
  }
  return (
    <div className="flex flex-col gap-2">
      <div className="flex gap-2">
        <Button variant="primary" disabled={busy} onClick={() => void decide(true)}>
          Allow
        </Button>
        <Button variant="ghost" disabled={busy} onClick={() => void decide(false)}>
          Deny
        </Button>
      </div>
      <FormError>{error}</FormError>
    </div>
  );
}
