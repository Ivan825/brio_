import type { Metadata } from "next";
import { StatusBoard } from "./status-board";

export const metadata: Metadata = { title: "Status" };

/** Public: whether each part of Brio works (GET /v1/status), refreshed every half minute. */
export default function StatusPage() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-2xl flex-col gap-6 bg-bg px-4 py-10 text-fg">
      <header className="flex flex-col gap-1">
        <p className="font-mono text-2xs uppercase tracking-[0.08em] text-fg-muted">status</p>
        <h1 className="text-xl font-semibold tracking-tight">Is Brio working?</h1>
      </header>
      <StatusBoard />
    </main>
  );
}
