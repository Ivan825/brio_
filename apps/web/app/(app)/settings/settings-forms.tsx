"use client";

import { KeyRound } from "lucide-react";
import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import { Button } from "@/components/button";
import { FormError, Input, Label } from "@/components/field";
import { api } from "@/lib/api";
import { authClient } from "@/lib/auth-client";

function useAction() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  async function run(fn: () => Promise<unknown>, message: string) {
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      await fn();
      setDone(message);
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, done, run };
}

export function RenameWorkspace({ id, name, disabled }: { id: string; name: string; disabled: boolean }) {
  const [value, setValue] = useState(name);
  const { busy, error, run } = useAction();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run(() => api(`/v1/workspaces/${id}`, { method: "PATCH", body: { name: value } }), "saved");
  };
  return (
    <form onSubmit={submit} className="flex flex-col gap-2">
      <Label htmlFor="ws-name">Name</Label>
      <div className="flex gap-2">
        <Input
          id="ws-name"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          disabled={disabled}
          maxLength={80}
        />
        <Button type="submit" disabled={disabled || busy || !value.trim() || value === name}>
          Save
        </Button>
      </div>
      <FormError>{error}</FormError>
    </form>
  );
}

export function InviteMember({ workspaceId }: { workspaceId: string }) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"member" | "admin">("member");
  const { busy, error, done, run } = useAction();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      await api(`/v1/workspaces/${workspaceId}/invitations`, { method: "POST", body: { email, role } });
      setEmail("");
    }, `invitation sent to ${email}`);
  };
  return (
    <form onSubmit={submit} className="flex flex-col gap-2 rounded-lg border border-line bg-surface p-4">
      <Label htmlFor="invite-email">Invite by email</Label>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Input
          id="invite-email"
          type="email"
          required
          placeholder="teammate@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <select
          aria-label="Role"
          value={role}
          onChange={(e) => setRole(e.target.value as "member" | "admin")}
          className="h-8 rounded-md border border-line bg-surface px-2 text-sm text-fg"
        >
          <option value="member">member</option>
          <option value="admin">admin</option>
        </select>
        <Button type="submit" variant="primary" disabled={busy || !email}>
          Send invite
        </Button>
      </div>
      {done && (
        <p className="font-mono text-xs text-success" role="status">
          {done}
        </p>
      )}
      <FormError>{error}</FormError>
    </form>
  );
}

export function PasskeySettings() {
  const { busy, error, done, run } = useAction();
  return (
    <div className="flex flex-col gap-2">
      <p className="text-fg-muted">
        Sign in with your fingerprint, face or device PIN instead of an email link.
      </p>
      <Button
        className="self-start"
        disabled={busy}
        onClick={() =>
          run(async () => {
            const res = await authClient.passkey.addPasskey();
            if (res?.error) throw new Error(res.error.message ?? "could not add a passkey");
          }, "passkey added")
        }
      >
        <KeyRound className="h-4 w-4" aria-hidden="true" />
        Add a passkey
      </Button>
      {done && (
        <p className="font-mono text-xs text-success" role="status">
          {done}
        </p>
      )}
      <FormError>{error}</FormError>
    </div>
  );
}
