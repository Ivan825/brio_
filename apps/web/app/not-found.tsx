import Link from "next/link";
import { buttonVariants } from "@/components/button";

export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-xl flex-col justify-center gap-4 px-6">
      <p className="font-mono text-2xs uppercase tracking-[0.08em] text-fg-muted">404</p>
      <h1 className="text-xl font-semibold tracking-tight">Nothing at this path</h1>
      <pre className="rounded-md border border-line bg-surface px-3 py-2.5 font-mono text-sm">
        <span className="text-fg-subtle">$ </span>cd ~/missions
      </pre>
      <div>
        <Link href="/missions" className={buttonVariants({ variant: "primary" })}>
          Go to missions
        </Link>
      </div>
    </main>
  );
}
