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

export interface ApiTokenRow {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
}

/**
 * Workspace API tokens for the brio CLI, its stdio MCP server, remote MCP clients and A2A clients. A new token is shown
 * once, with the lines that connect Claude Code, Codex and Cursor to Brio.
 */
export function ApiTokens({ tokens, origin }: { tokens: ApiTokenRow[]; origin: string }) {
  const [name, setName] = useState("");
  const [days, setDays] = useState("90");
  const [fresh, setFresh] = useState<string | null>(null);
  const { busy, error, run } = useAction();
  const create = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const r = await api<{ token: { value: string } }>("/v1/tokens", {
        method: "POST",
        body: { name, ...(days ? { expiresInDays: Number(days) } : {}) },
      });
      setFresh(r.token.value);
      setName("");
    }, "created");
  };
  const live = tokens.filter((t) => !t.revokedAt);
  return (
    <div className="flex flex-col gap-3">
      {fresh && (
        <div
          className="flex flex-col gap-2 rounded-md border border-line bg-surface p-3"
          data-testid="new-token"
        >
          <p className="text-xs text-fg-muted">
            Copy it now: Brio keeps only a hash and cannot show it again.
          </p>
          <code className="break-all font-mono text-xs">{fresh}</code>
          <p className="text-xs text-fg-muted">Connect an agent to Brio:</p>
          <pre className="overflow-x-auto font-mono text-2xs text-fg-subtle">
            {[
              `claude mcp add --transport http brio ${origin}/mcp --header "Authorization: Bearer ${fresh}"`,
              `BRIO_TOKEN=${fresh} BRIO_URL=${origin} brio mcp   # stdio`,
              `codex mcp add brio --url ${origin}/mcp   # with bearer_token_env_var = "BRIO_TOKEN"`,
            ].join("\n")}
          </pre>
        </div>
      )}
      <ul className="divide-y divide-line rounded-lg border border-line" aria-label="API tokens">
        {live.length === 0 && <li className="px-4 py-2.5 text-xs text-fg-muted">No tokens yet.</li>}
        {live.map((t) => (
          <li key={t.id} className="flex items-center gap-3 px-4 py-2.5" data-testid="api-token">
            <span className="min-w-0 flex-1 truncate">{t.name}</span>
            <span className="font-mono text-2xs text-fg-subtle">{t.prefix}…</span>
            <span className="hidden font-mono text-2xs text-fg-subtle sm:inline">
              {t.lastUsedAt ? `used ${new Date(t.lastUsedAt).toLocaleDateString()}` : "never used"}
              {t.expiresAt ? ` · expires ${new Date(t.expiresAt).toLocaleDateString()}` : ""}
            </span>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => void run(() => api(`/v1/tokens/${t.id}`, { method: "DELETE" }), "revoked")}
            >
              Revoke
            </Button>
          </li>
        ))}
      </ul>
      <form onSubmit={create} className="flex flex-wrap items-end gap-2" aria-label="New API token">
        <div className="flex min-w-48 flex-1 flex-col gap-1">
          <Label htmlFor="token-name">Token name</Label>
          <Input
            id="token-name"
            required
            maxLength={80}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="flex w-32 flex-col gap-1">
          <Label htmlFor="token-days">Expires (days)</Label>
          <Input
            id="token-days"
            type="number"
            min="1"
            max="366"
            value={days}
            onChange={(e) => setDays(e.target.value)}
            className="font-mono"
          />
        </div>
        <Button type="submit" variant="primary" disabled={busy || !name.trim()}>
          Create token
        </Button>
      </form>
      <FormError>{error}</FormError>
    </div>
  );
}
