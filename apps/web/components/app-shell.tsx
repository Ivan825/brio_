import Link from "next/link";
import type { ReactNode } from "react";
import { Breadcrumb } from "./breadcrumb";
import { NavLinks } from "./nav-links";
import { ThemeToggle } from "./theme-toggle";
import { Wordmark } from "./wordmark";

export function AppShell({
  children,
  workspaceSwitcher,
  userMenu,
}: {
  children: ReactNode;
  workspaceSwitcher?: ReactNode;
  userMenu?: ReactNode;
}) {
  return (
    <div className="flex min-h-dvh flex-col">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-2 focus:z-50 focus:rounded-md focus:bg-surface focus:px-3 focus:py-1.5"
      >
        Skip to content
      </a>
      <header className="sticky top-0 z-40 flex h-12 items-center gap-4 border-b border-line bg-bg px-4">
        <Link href="/missions" className="rounded-sm text-md" aria-label="Brio home">
          <Wordmark />
        </Link>
        {workspaceSwitcher}
        <div className="min-w-0 flex-1 overflow-hidden">
          <Breadcrumb />
        </div>
        <ThemeToggle />
        {userMenu}
      </header>
      <nav aria-label="Primary" className="border-b border-line px-2 py-1.5 md:hidden">
        <NavLinks orientation="horizontal" />
      </nav>
      <div className="flex flex-1">
        <nav aria-label="Primary" className="hidden w-52 shrink-0 border-r border-line p-2 md:block">
          <NavLinks />
        </nav>
        <main id="main" className="min-w-0 flex-1">
          {children}
        </main>
      </div>
    </div>
  );
}
