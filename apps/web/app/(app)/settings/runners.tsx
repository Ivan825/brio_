"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/button";
import { Chip } from "@/components/chip";
import { FormError } from "@/components/field";
import { api } from "@/lib/api";
import type { RunnerSummary } from "@/lib/types";

/** The workspace's local runners: online or not, the CLIs each found, host-mode consent; revoke one. */
export function LocalRunners({ runners, origin }: { runners: RunnerSummary[]; origin: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="flex flex-col gap-3">
      {runners.length > 0 && (
        <ul className="divide-y divide-line rounded-lg border border-line" aria-label="Local runners">
          {runners.map((r) => (
            <li key={r.id} className="flex flex-col gap-1 px-4 py-2.5" data-testid="runner">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{r.name}</span>
                <Chip tone={r.online ? "success" : "muted"}>{r.online ? "online" : "offline"}</Chip>
                <Chip tone={r.mode === "host" ? "warning" : "muted"}>
                  {r.mode === "host" ? "host mode" : "docker"}
                </Chip>
                <span className="ml-auto">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={async () => {
                      try {
                        await api(`/v1/runners/${r.id}`, { method: "DELETE" });
                        router.refresh();
                      } catch (e) {
                        setError((e as Error).message);
                      }
                    }}
                  >
                    Revoke
                  </Button>
                </span>
              </div>
              <p className="font-mono text-2xs text-fg-muted">
                {(r.capabilities.clis ?? []).map((c) => c.key).join(", ") || "no coding CLIs found yet"}
                {r.capabilities.docker ? " · docker" : ""}
                {r.lastSeenAt
                  ? ` · last seen ${new Date(r.lastSeenAt).toLocaleString()}`
                  : " · never connected"}
              </p>
              {r.consent && (
                <p className="text-2xs text-fg-subtle">
                  Host mode agreed {new Date(r.consent.host.at).toLocaleDateString()}: {r.consent.host.text}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
      <pre className="overflow-x-auto rounded-md border border-line bg-bg p-3 font-mono text-xs leading-relaxed">
        {`brio login --url ${origin}
brio runner register --name laptop        # add --host to run without Docker (asks for consent)
brio runner start`}
      </pre>
      <FormError>{error}</FormError>
    </div>
  );
}
