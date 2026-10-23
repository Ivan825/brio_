"use client";

import { type FormEvent, useState } from "react";
import { Button } from "@/components/button";
import { FormError, Input, Label } from "@/components/field";
import { authClient } from "@/lib/auth-client";

type Step = "enter" | "confirm" | "approved" | "denied";

/** Enter (or confirm) the code, then approve or deny it. */
export function DeviceForm({ initialCode }: { initialCode: string }) {
  const [code, setCode] = useState(initialCode);
  const [step, setStep] = useState<Step>("enter");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const userCode = code.trim().replaceAll("-", "").toUpperCase();

  async function check(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await authClient.$fetch<{ status: string }>("/device", {
      method: "GET",
      query: { user_code: userCode },
    });
    setBusy(false);
    if (res.error || !res.data) {
      setError(res.error?.message ?? "that code is not known or has expired");
      return;
    }
    if (res.data.status !== "pending") {
      setError(`that code was already ${res.data.status}`);
      return;
    }
    setStep("confirm");
  }

  async function decide(approve: boolean) {
    setBusy(true);
    setError(null);
    const res = await authClient.$fetch(approve ? "/device/approve" : "/device/deny", {
      method: "POST",
      body: { userCode },
    });
    setBusy(false);
    if (res.error) {
      setError(res.error.message ?? "the request could not be completed");
      return;
    }
    setStep(approve ? "approved" : "denied");
  }

  if (step === "approved")
    return (
      <p role="status" className="rounded-md border border-line bg-surface px-3 py-2 text-sm text-success">
        The CLI is signed in. You can close this tab.
      </p>
    );
  if (step === "denied")
    return (
      <p role="status" className="rounded-md border border-line bg-surface px-3 py-2 text-sm">
        Denied. The CLI was not signed in.
      </p>
    );
  if (step === "confirm")
    return (
      <div className="flex flex-col gap-3">
        <p className="font-mono text-2xl tracking-[0.2em]" data-testid="device-code">
          {userCode}
        </p>
        <div className="flex gap-2">
          <Button variant="primary" disabled={busy} onClick={() => void decide(true)}>
            Approve
          </Button>
          <Button variant="ghost" disabled={busy} onClick={() => void decide(false)}>
            Deny
          </Button>
        </div>
        <FormError>{error}</FormError>
      </div>
    );
  return (
    <form onSubmit={check} className="flex flex-col gap-2">
      <Label htmlFor="user-code">Code from the terminal</Label>
      <Input
        id="user-code"
        autoComplete="off"
        autoCapitalize="characters"
        value={code}
        onChange={(e) => setCode(e.target.value)}
        className="font-mono tracking-[0.2em]"
      />
      <div>
        <Button type="submit" variant="primary" disabled={busy || userCode.length < 4}>
          Continue
        </Button>
      </div>
      <FormError>{error}</FormError>
    </form>
  );
}
