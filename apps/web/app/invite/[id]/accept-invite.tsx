"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/button";
import { FormError } from "@/components/field";
import { authClient } from "@/lib/auth-client";

export function AcceptInvite({ invitationId, email }: { invitationId: string; email: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function accept() {
    setBusy(true);
    setError(null);
    const res = await authClient.organization.acceptInvitation({ invitationId });
    if (res.error) {
      setError(res.error.message ?? "could not accept the invitation");
      setBusy(false);
      return;
    }
    const workspaceId = res.data?.invitation.organizationId;
    if (workspaceId) await fetch(`/v1/workspaces/${workspaceId}/activate`, { method: "POST" });
    router.push("/missions");
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-fg-muted">
        Signed in as <span className="font-mono text-fg">{email}</span>.
      </p>
      <Button variant="primary" onClick={accept} disabled={busy}>
        Accept invitation
      </Button>
      <FormError>{error}</FormError>
    </div>
  );
}
