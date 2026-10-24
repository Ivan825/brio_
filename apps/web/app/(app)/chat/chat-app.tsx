"use client";

import { agentColorVar } from "@brio/brand";
import { EVENT_TYPES } from "@brio/schema";
import { ArrowUp, Check, Copy, MessageSquarePlus, Square, Trash2, Workflow } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, type KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/button";
import { Chip } from "@/components/chip";
import { FormError } from "@/components/field";
import { useRunning } from "@/components/running";
import { api } from "@/lib/api";
import { usd } from "@/lib/format";
import { renderMarkdown } from "@/lib/markdown";
import type { AgentSummary } from "@/lib/types";
import { cn } from "@/lib/utils";

export interface ChatListItem {
  id: string;
  title: string;
  updatedAt: string;
}

type Mode = "auto" | "together" | "review" | "debate";

export interface ChatTurn {
  id: string;
  message: string;
  mode: Mode;
  agentIds: string[];
  status: string;
  createdAt: string;
  answer: string | null;
  error: string | null;
  costUsd: number;
  route: { mode: string; agents: Array<{ agentId: string; role?: string }>; degraded: string | null } | null;
  attempts: Array<{
    id: string;
    agentId: string;
    agent: string;
    model: string;
    role: string;
    status: string;
    costUsd: number;
    exitReason: string | null;
  }>;
}

export interface ChatView {
  chat: { id: string; title: string; createdAt: string; updatedAt: string };
  turns: ChatTurn[];
}

const MODES: Array<{ id: Mode; label: string; hint: string; needs: number }> = [
  { id: "auto", label: "Auto", hint: "the best agent for it answers", needs: 1 },
  { id: "together", label: "Together", hint: "each picked agent answers, then one merges them", needs: 2 },
  { id: "review", label: "Review", hint: "one answers, another checks it and asks for fixes", needs: 2 },
  { id: "debate", label: "Debate", hint: "they argue it out and a judge decides", needs: 2 },
];

const WORKING = new Set(["pending", "ready", "leased", "running", "verifying", "revise", "blocked"]);

const STATUS_LABEL: Record<string, string> = {
  pending: "queued",
  ready: "queued",
  leased: "starting",
  running: "thinking",
  verifying: "checking",
  revise: "retrying",
  blocked: "waiting",
  done: "done",
  failed: "failed",
  cancelled: "stopped",
};

const ROLE_LABEL: Record<string, string> = {
  maker: "answered",
  candidate: "answered",
  merger: "merged",
  checker: "checked",
  judge: "judged",
};

interface LiveEvent {
  seq: number;
  type: string;
  taskId: string | null;
  attemptId: string | null;
  payload: Record<string, unknown>;
}

/** Talk to your agents: one answers, or several work on the reply together. */
export function ChatApp({
  chats: initialChats,
  agents,
  initial,
}: {
  chats: ChatListItem[];
  agents: AgentSummary[];
  initial: ChatView | null;
}) {
  const router = useRouter();
  const { setRunning } = useRunning();
  const usable = useMemo(() => agents.filter((a) => a.runnable), [agents]);
  const idle = useMemo(() => agents.filter((a) => !a.runnable), [agents]);
  const colour = useMemo(() => new Map(agents.map((a, i) => [a.id, agentColorVar(i)])), [agents]);
  const [view, setView] = useState<ChatView | null>(initial);
  const [chats, setChats] = useState(initialChats);
  const [message, setMessage] = useState("");
  const [mode, setMode] = useState<Mode>(() => (usable.length >= 2 ? "together" : "auto"));
  const [picked, setPicked] = useState<string[]>([]);
  const [sending, setSending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState<Record<string, string>>({});
  const bottom = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const chatId = view?.chat.id ?? null;

  const team = picked.length ? picked : usable.map((a) => a.id);
  const teamSize = team.length;
  const active = view?.turns.find((t) => WORKING.has(t.status)) ?? null;

  const reload = useCallback(async () => {
    if (!chatId) return;
    try {
      setView(await api<ChatView>(`/v1/chats/${chatId}`));
    } catch {
      // the next event retries
    }
  }, [chatId]);

  // Live: every event of the chat re-reads it (debounced); agents' running messages show as they arrive.
  useEffect(() => {
    if (!chatId) return;
    const source = new EventSource(`/v1/missions/${chatId}/events`);
    let timer: ReturnType<typeof setTimeout> | null = null;
    let last = 0;
    const onEvent = (msg: MessageEvent<string>) => {
      const e = JSON.parse(msg.data) as LiveEvent;
      if (e.seq <= last) return;
      last = e.seq;
      if (e.type === "attempt.message" && e.attemptId) {
        const text = String((e.payload as { text?: string }).text ?? "").trim();
        if (text) setLive((prev) => ({ ...prev, [e.attemptId as string]: text }));
      }
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void reload(), 200);
    };
    source.onmessage = onEvent;
    for (const t of EVENT_TYPES) source.addEventListener(t, onEvent as EventListener);
    return () => {
      source.close();
      if (timer) clearTimeout(timer);
    };
  }, [chatId, reload]);

  useEffect(() => {
    setRunning("chat", Boolean(active) || sending !== null);
    return () => setRunning("chat", false);
  }, [active, sending, setRunning]);

  const turnCount = view?.turns.length ?? 0;
  const lastStatus = view?.turns.at(-1)?.status;
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll when a turn arrives or changes state
  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [turnCount, lastStatus, sending]);

  const send = async (e?: FormEvent) => {
    e?.preventDefault();
    const text = message.trim();
    if (!text || sending || active) return;
    setError(null);
    setSending(text);
    setMessage("");
    const body = { message: text, mode, agentIds: picked };
    try {
      if (!chatId) {
        const { chat } = await api<{ chat: { id: string; title: string } }>("/v1/chats", {
          method: "POST",
          body,
        });
        setChats((prev) => [
          { id: chat.id, title: chat.title, updatedAt: new Date().toISOString() },
          ...prev,
        ]);
        router.push(`/chat/${chat.id}`);
        return;
      }
      await api(`/v1/chats/${chatId}/messages`, { method: "POST", body });
      await reload();
    } catch (err) {
      setError((err as Error).message);
      setMessage(text);
    } finally {
      setSending(null);
      input.current?.focus();
    }
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    }
  };

  const stop = async () => {
    if (!chatId || !active) return;
    try {
      await api(`/v1/chats/${chatId}/turns/${active.id}/stop`, { method: "POST" });
      await reload();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const archive = async (id: string) => {
    try {
      await api(`/v1/chats/${id}`, { method: "DELETE" });
      setChats((prev) => prev.filter((c) => c.id !== id));
      if (id === chatId) router.push("/chat");
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const toggle = (id: string) =>
    setPicked((prev) => {
      const base = prev.length ? prev : usable.map((a) => a.id);
      const next = base.includes(id) ? base.filter((x) => x !== id) : [...base, id];
      return next.length === usable.length ? [] : next;
    });

  return (
    <div className="flex h-[calc(100dvh-6rem)] min-h-0 md:h-[calc(100dvh-3rem)]" data-testid="chat">
      <aside className="hidden w-60 shrink-0 flex-col border-r border-line md:flex" aria-label="Chats">
        <div className="p-3">
          <Button className="w-full justify-start" onClick={() => router.push("/chat")}>
            <MessageSquarePlus className="h-4 w-4" aria-hidden />
            New chat
          </Button>
        </div>
        <ul className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
          {chats.map((c) => (
            <li key={c.id} className="group relative">
              <Link
                href={`/chat/${c.id}`}
                className={cn(
                  "block truncate rounded-md px-2.5 py-1.5 pr-8 text-sm",
                  c.id === chatId ? "bg-surface-2 text-fg" : "text-fg-muted hover:bg-surface hover:text-fg",
                )}
              >
                {c.title}
              </Link>
              <button
                type="button"
                onClick={() => void archive(c.id)}
                aria-label={`Archive ${c.title}`}
                className="absolute right-1.5 top-1.5 hidden rounded-sm p-0.5 text-fg-subtle hover:text-danger group-hover:block"
              >
                <Trash2 className="h-3.5 w-3.5" aria-hidden />
              </button>
            </li>
          ))}
          {!chats.length && <li className="px-2.5 py-1.5 text-xs text-fg-subtle">No chats yet.</li>}
        </ul>
      </aside>

      <section className="flex min-w-0 flex-1 flex-col" aria-label="Conversation">
        <div className="flex items-center gap-2 border-b border-line px-4 py-2 md:hidden">
          <label htmlFor="chat-switch" className="sr-only">
            Chats
          </label>
          <select
            id="chat-switch"
            value={chatId ?? ""}
            onChange={(e) => router.push(e.target.value ? `/chat/${e.target.value}` : "/chat")}
            className="h-8 min-w-0 flex-1 rounded-md border border-line bg-surface px-2 text-sm text-fg"
          >
            <option value="">New chat</option>
            {chats.map((c) => (
              <option key={c.id} value={c.id}>
                {c.title}
              </option>
            ))}
          </select>
          <Button size="icon" onClick={() => router.push("/chat")} aria-label="New chat">
            <MessageSquarePlus className="h-4 w-4" aria-hidden />
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-6 sm:px-6">
            {!view?.turns.length && !sending && (
              <Welcome agents={usable} hasAny={agents.length > 0} onPick={(t) => setMessage(t)} />
            )}
            {view?.turns.map((t) => (
              <Turn key={t.id} turn={t} chatId={view.chat.id} colour={colour} live={live} />
            ))}
            {sending && (
              <div className="flex flex-col gap-2">
                <You text={sending} />
                <p className="font-mono text-xs text-fg-subtle">
                  sending
                  <span className="brio-cursor ml-1" aria-hidden />
                </p>
              </div>
            )}
            <div ref={bottom} />
          </div>
        </div>

        <form
          onSubmit={send}
          className="border-t border-line bg-bg px-4 py-3 sm:px-6"
          aria-label="Send a message"
        >
          <div className="mx-auto flex max-w-3xl flex-col gap-2">
            {idle.length > 0 && (
              <p className="text-xs text-warning" data-testid="idle-agents">
                {idle.map((a) => a.name).join(", ")} can&apos;t answer yet:{" "}
                {idle[0]?.notRunnableBecause ?? "its connector is not ready"}
                {idle.length > 1 ? " (and others)" : ""}.{" "}
                <Link href="/agents" className="underline underline-offset-2">
                  Fix it on Agents
                </Link>
              </p>
            )}
            {usable.length > 0 && (
              <fieldset className="flex flex-wrap items-center gap-1.5">
                <legend className="sr-only">Who answers, and how</legend>
                <span className="mr-1 font-mono text-2xs uppercase tracking-[0.08em] text-fg-subtle">
                  agents
                </span>
                {usable.map((a) => {
                  const on = team.includes(a.id);
                  return (
                    <button
                      key={a.id}
                      type="button"
                      aria-pressed={on}
                      onClick={() => toggle(a.id)}
                      title={`${a.name} · ${a.model}`}
                      className={cn(
                        "inline-flex items-center gap-1.5 rounded-sm border px-2 py-0.5 font-mono text-2xs transition-colors duration-fast",
                        on ? "border-line-strong text-fg" : "border-line text-fg-subtle line-through",
                      )}
                    >
                      <span
                        className="h-1.5 w-1.5 rounded-xs"
                        style={{ background: colour.get(a.id) }}
                        aria-hidden
                      />
                      {a.name}
                    </button>
                  );
                })}
                {idle.map((a) => (
                  <span
                    key={a.id}
                    title={a.notRunnableBecause ?? "can't run yet"}
                    className="inline-flex cursor-not-allowed items-center gap-1.5 rounded-sm border border-dashed border-line px-2 py-0.5 font-mono text-2xs text-fg-subtle"
                  >
                    <span
                      className="h-1.5 w-1.5 rounded-xs"
                      style={{ background: colour.get(a.id) }}
                      aria-hidden
                    />
                    {a.name} · can&apos;t run
                  </span>
                ))}
                <span className="mx-1 h-4 w-px bg-line" aria-hidden />
                <span className="flex flex-wrap gap-1">
                  {MODES.map((m) => {
                    const disabled = teamSize < m.needs;
                    return (
                      <button
                        key={m.id}
                        type="button"
                        aria-pressed={mode === m.id}
                        disabled={disabled}
                        title={disabled ? `needs ${m.needs} agents` : m.hint}
                        onClick={() => setMode(m.id)}
                        className={cn(
                          "rounded-sm px-2 py-0.5 font-mono text-2xs transition-colors duration-fast disabled:opacity-40",
                          mode === m.id ? "bg-surface-2 text-fg" : "text-fg-muted hover:text-fg",
                        )}
                      >
                        {m.label}
                      </button>
                    );
                  })}
                </span>
              </fieldset>
            )}
            <div className="flex items-end gap-2 rounded-lg border border-line bg-surface p-2 focus-within:border-line-strong">
              <label htmlFor="chat-input" className="sr-only">
                Message
              </label>
              <textarea
                id="chat-input"
                ref={input}
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                onKeyDown={onKey}
                rows={Math.min(8, Math.max(1, message.split("\n").length))}
                placeholder={
                  usable.length
                    ? "Ask anything, or describe what to build…"
                    : "Connect an agent first (Connectors), then ask anything"
                }
                disabled={!usable.length}
                className="max-h-56 min-h-[2.25rem] flex-1 resize-none bg-transparent px-1.5 py-1 text-base text-fg placeholder:text-fg-subtle focus:outline-none"
              />
              {active ? (
                <Button
                  variant="secondary"
                  size="icon"
                  onClick={() => void stop()}
                  aria-label="Stop the reply"
                >
                  <Square className="h-3.5 w-3.5" aria-hidden />
                </Button>
              ) : (
                <Button
                  type="submit"
                  variant="primary"
                  size="icon"
                  aria-label="Send"
                  disabled={!message.trim() || !usable.length || sending !== null}
                >
                  <ArrowUp className="h-4 w-4" aria-hidden />
                </Button>
              )}
            </div>
            <div className="flex items-center justify-between gap-2 text-2xs text-fg-subtle">
              <span className="font-mono">
                {MODES.find((m) => m.id === mode)?.hint} · enter sends, shift+enter for a new line
              </span>
              <FormError>{error}</FormError>
            </div>
          </div>
        </form>
      </section>
    </div>
  );
}

function You({ text }: { text: string }) {
  return (
    <div className="flex flex-col items-end gap-1">
      <span className="font-mono text-2xs text-fg-subtle">you</span>
      <div className="max-w-[85%] whitespace-pre-wrap rounded-lg border border-line bg-surface-2 px-3.5 py-2 text-base text-fg">
        {text}
      </div>
    </div>
  );
}

function Welcome({
  agents,
  hasAny,
  onPick,
}: {
  agents: AgentSummary[];
  hasAny: boolean;
  onPick: (text: string) => void;
}) {
  if (!agents.length)
    return (
      <div className="flex flex-col gap-3 py-12">
        <h1 className="text-xl font-semibold tracking-tight">Chat with your agents</h1>
        <p className="text-fg-muted">
          {hasAny
            ? "None of your agents can run right now: check their connectors' keys."
            : "Connect a model or an agent first, then talk to it here — or to several at once."}
        </p>
        <Link href="/connectors" className="self-start text-sm text-focus underline underline-offset-2">
          Add a connector
        </Link>
      </div>
    );
  const ideas = [
    "Explain how OAuth's PKCE flow works, with a diagram in text",
    "Write a landing page headline and three taglines for a note-taking app",
    "Compare Postgres and SQLite for a small SaaS, as a table",
  ];
  return (
    <div className="flex flex-col gap-4 py-10">
      <h1 className="text-xl font-semibold tracking-tight">What should your agents work on?</h1>
      <p className="max-w-xl text-fg-muted">
        Ask anything. With two or more agents, pick <span className="font-mono text-fg">Together</span>,{" "}
        <span className="font-mono text-fg">Review</span> or <span className="font-mono text-fg">Debate</span>{" "}
        and they build the reply between them. Every reply is checked, costed and teaches the scoreboard who
        is best at what.
      </p>
      <ul className="flex flex-col gap-2">
        {ideas.map((i) => (
          <li key={i}>
            <button
              type="button"
              onClick={() => onPick(i)}
              className="w-full rounded-md border border-line px-3 py-2 text-left text-sm text-fg-muted transition-colors duration-fast hover:border-line-strong hover:text-fg"
            >
              {i}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Turn({
  turn,
  chatId,
  colour,
  live,
}: {
  turn: ChatTurn;
  chatId: string;
  colour: Map<string, string>;
  live: Record<string, string>;
}) {
  const router = useRouter();
  const working = WORKING.has(turn.status);
  const [copied, setCopied] = useState(false);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [handing, setHanding] = useState(false);
  const html = useMemo(() => (turn.answer ? renderMarkdown(turn.answer) : ""), [turn.answer]);
  const team = [...new Map(turn.attempts.map((a) => [a.agentId, a])).values()];
  const running = turn.attempts.filter((a) => a.status === "running" || a.status === "queued");
  const result = [...turn.attempts]
    .reverse()
    .find((a) => a.status === "succeeded" && ["merger", "maker", "candidate"].includes(a.role));

  const copy = async () => {
    if (!turn.answer) return;
    await navigator.clipboard?.writeText(turn.answer).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  const toMission = async () => {
    setHanding(true);
    setError(null);
    try {
      const { mission } = await api<{ mission: { id: string } }>(`/v1/chats/${chatId}/mission`, {
        method: "POST",
        body: { goal: turn.message },
      });
      router.push(`/missions/${mission.id}`);
    } catch (err) {
      setError((err as Error).message);
      setHanding(false);
    }
  };

  return (
    <article className="flex flex-col gap-3" data-testid="chat-turn" data-status={turn.status}>
      <You text={turn.message} />
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-2xs text-fg-subtle">agents</span>
          {team.map((a) => (
            <span key={a.agentId} className="inline-flex items-center gap-1 font-mono text-2xs text-fg-muted">
              <span
                className="h-1.5 w-1.5 rounded-xs"
                style={{ background: colour.get(a.agentId) }}
                aria-hidden
              />
              {a.agent}
            </span>
          ))}
          {turn.route && turn.route.mode !== "single" && (
            <Chip tone="info">{turn.route.mode.replace("_", " ")}</Chip>
          )}
          <Chip
            tone={
              turn.status === "done"
                ? "success"
                : turn.status === "failed"
                  ? "danger"
                  : turn.status === "cancelled"
                    ? "muted"
                    : "running"
            }
          >
            {STATUS_LABEL[turn.status] ?? turn.status}
          </Chip>
          {turn.costUsd > 0 && <span className="font-mono text-2xs text-fg-subtle">{usd(turn.costUsd)}</span>}
        </div>
        {turn.route?.degraded && <p className="font-mono text-2xs text-warning">{turn.route.degraded}</p>}

        {turn.answer ? (
          <div
            className="md rounded-lg border border-line bg-surface px-4 py-3"
            data-testid="chat-answer"
            // biome-ignore lint/security/noDangerouslySetInnerHtml: renderMarkdown escapes raw HTML and allows only http(s)/mailto links
            dangerouslySetInnerHTML={{ __html: html }}
          />
        ) : working ? (
          <div className="flex flex-col gap-1 rounded-lg border border-line bg-surface px-4 py-3 font-mono text-xs text-fg-muted">
            {running.length ? (
              running.map((a) => (
                <p key={a.id} className="truncate">
                  <span className="text-fg">{a.agent}</span>{" "}
                  <span className="text-fg-subtle">
                    {ROLE_LABEL[a.role] === "answered"
                      ? "is answering"
                      : `is ${a.role === "merger" ? "merging" : a.role === "checker" ? "checking" : "judging"}`}
                  </span>
                  {live[a.id] ? <span className="text-fg-subtle"> · {live[a.id]?.slice(0, 160)}</span> : null}
                </p>
              ))
            ) : (
              <p>{STATUS_LABEL[turn.status] ?? "working"}</p>
            )}
            <span className="brio-cursor" aria-hidden />
          </div>
        ) : (
          <p className="rounded-lg border border-line px-4 py-3 text-sm text-danger" data-testid="chat-error">
            {turn.error === "stopped" ? "Stopped." : `No reply: ${turn.error ?? turn.status}`}
          </p>
        )}

        {!working && (
          <div className="flex flex-wrap items-center gap-1">
            {turn.answer && (
              <Button size="sm" variant="ghost" onClick={() => void copy()} aria-label="Copy the reply">
                {copied ? (
                  <Check className="h-3.5 w-3.5" aria-hidden />
                ) : (
                  <Copy className="h-3.5 w-3.5" aria-hidden />
                )}
                {copied ? "copied" : "copy"}
              </Button>
            )}
            {turn.attempts.length > 1 && (
              <Button size="sm" variant="ghost" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
                {open ? "hide" : "show"} how they worked
              </Button>
            )}
            {result && <Rate attemptId={result.id} />}
            <Button size="sm" variant="ghost" onClick={() => void toMission()} disabled={handing}>
              <Workflow className="h-3.5 w-3.5" aria-hidden />
              Turn into a mission
            </Button>
            <FormError>{error}</FormError>
          </div>
        )}
        {open && <Contributions turn={turn} colour={colour} />}
      </div>
    </article>
  );
}

function Contributions({ turn, colour }: { turn: ChatTurn; colour: Map<string, string> }) {
  return (
    <ol className="flex flex-col gap-2 border-l border-line pl-3" aria-label="How the agents worked">
      {turn.attempts.map((a) => (
        <li key={a.id} className="flex flex-col gap-1">
          <p className="flex flex-wrap items-center gap-2 font-mono text-2xs text-fg-muted">
            <span
              className="h-1.5 w-1.5 rounded-xs"
              style={{ background: colour.get(a.agentId) }}
              aria-hidden
            />
            <span className="text-fg">{a.agent}</span>
            <span>{ROLE_LABEL[a.role] ?? a.role}</span>
            <span className="text-fg-subtle">{a.model}</span>
            <span className={a.status === "succeeded" ? "text-success" : "text-fg-subtle"}>{a.status}</span>
            {a.costUsd > 0 && <span className="text-fg-subtle">{usd(a.costUsd)}</span>}
          </p>
          {a.status === "succeeded" ? (
            <Output attemptId={a.id} />
          ) : a.exitReason ? (
            <p className="font-mono text-2xs text-fg-subtle">{a.exitReason}</p>
          ) : null}
        </li>
      ))}
    </ol>
  );
}

function Output({ attemptId }: { attemptId: string }) {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    fetch(`/v1/attempts/${attemptId}/output`, { credentials: "same-origin" })
      .then((r) => (r.ok ? r.text() : ""))
      .then((t) => live && setText(t))
      .catch(() => live && setText(""));
    return () => {
      live = false;
    };
  }, [attemptId]);
  const html = useMemo(() => (text ? renderMarkdown(text) : ""), [text]);
  if (text === null) return <p className="font-mono text-2xs text-fg-subtle">loading…</p>;
  if (!text) return null;
  return (
    <div
      className="md max-h-72 overflow-y-auto rounded-md border border-line bg-bg px-3 py-2 text-sm"
      // biome-ignore lint/security/noDangerouslySetInnerHtml: renderMarkdown escapes raw HTML and allows only http(s)/mailto links
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

function Rate({ attemptId }: { attemptId: string }) {
  const [rated, setRated] = useState<1 | -1 | null>(null);
  const rate = async (rating: 1 | -1) => {
    try {
      await api(`/v1/attempts/${attemptId}/rating`, { method: "POST", body: { rating } });
      setRated(rating);
    } catch {
      // rating is best effort
    }
  };
  if (rated !== null)
    return <span className="px-2 font-mono text-2xs text-fg-subtle">rated {rated > 0 ? "up" : "down"}</span>;
  return (
    <>
      <Button size="sm" variant="ghost" aria-label="Good reply" onClick={() => void rate(1)}>
        +1
      </Button>
      <Button size="sm" variant="ghost" aria-label="Bad reply" onClick={() => void rate(-1)}>
        −1
      </Button>
    </>
  );
}
