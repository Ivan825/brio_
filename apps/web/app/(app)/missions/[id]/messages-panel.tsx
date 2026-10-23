"use client";

import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { Button } from "@/components/button";
import { FormError, Label, Textarea } from "@/components/field";
import { api } from "@/lib/api";

export interface MissionMessage {
  id: string;
  kind: string;
  body: string;
  status: string;
  to: string;
  replyToId: string | null;
  createdAt: string;
}

const LABEL: Record<string, string> = {
  question: "An agent asks",
  blocker: "An agent is blocked",
  review_request: "An agent asks for a review",
};

function OpenMessage({ m }: { m: MissionMessage }) {
  const router = useRouter();
  const id = useId();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <li className="flex flex-col gap-2 rounded-md border border-line p-3" data-testid="message-to-user">
      <p className="font-mono text-2xs uppercase tracking-[0.08em] text-warning">{LABEL[m.kind] ?? m.kind}</p>
      <p>{m.body}</p>
      <Label htmlFor={id}>Your answer</Label>
      <Textarea id={id} value={text} onChange={(e) => setText(e.target.value)} className="min-h-16" />
      <div>
        <Button
          size="sm"
          variant="primary"
          disabled={busy || !text.trim()}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              await api(`/v1/messages/${m.id}/answer`, { method: "POST", body: { text } });
              router.refresh();
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          Send answer
        </Button>
      </div>
      <FormError>{error}</FormError>
    </li>
  );
}

/** Questions, blockers and review requests the agents addressed to a person. */
export function MessagesPanel({ messages }: { messages: MissionMessage[] }) {
  return (
    <section
      aria-labelledby="inbox-title"
      className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-4"
    >
      <h2 id="inbox-title" className="font-medium">
        Waiting for you · {messages.length}
      </h2>
      <ul className="flex flex-col gap-2">
        {messages.map((m) => (
          <OpenMessage key={m.id} m={m} />
        ))}
      </ul>
    </section>
  );
}
