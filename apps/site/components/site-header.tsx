"use client";

import { BRAND } from "@brio/brand";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { Wordmark } from "@/components/section";
import { LINKS } from "@/lib/content";
import { NAV } from "@/lib/routes";

const isActive = (path: string, href: string) => (href === "/" ? path === "/" : path.startsWith(href));

/** The bar on every page: the wordmark home, the pages, GitHub. Below md the pages fold into a menu. */
export function SiteHeader() {
  const path = usePathname() ?? "/";
  const [open, setOpen] = useState(false);
  // A new page closes the menu.
  // biome-ignore lint/correctness/useExhaustiveDependencies: closes on navigation only
  useEffect(() => setOpen(false), [path]);

  return (
    <header className="sticky top-0 z-20 border-b border-line bg-bg">
      <nav
        className="mx-auto flex h-14 max-w-6xl items-center justify-between gap-4 px-4 sm:px-6"
        aria-label="Main"
      >
        <Link href="/" className="text-lg" aria-label={`${BRAND.name}, home`}>
          <Wordmark />
        </Link>
        <div className="hidden items-center gap-6 md:flex">
          {NAV.map((n) => (
            <Link
              key={n.href}
              href={n.href}
              aria-current={isActive(path, n.href) ? "page" : undefined}
              className={`text-sm transition-colors duration-fast ${isActive(path, n.href) ? "text-fg" : "text-fg-muted hover:text-fg"}`}
            >
              {n.label}
            </Link>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <a
            href={LINKS.github}
            className="hidden rounded-md border border-line px-3 py-1.5 text-sm text-fg transition-colors duration-fast hover:border-line-strong hover:bg-surface sm:inline-flex"
          >
            GitHub
          </a>
          <Link
            href={LINKS.gettingStarted}
            className="hidden rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-fg transition-colors duration-fast hover:bg-primary-hover md:inline-flex"
          >
            Get started
          </Link>
          <button
            type="button"
            className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-line text-fg md:hidden"
            aria-expanded={open}
            aria-controls="mobile-nav"
            aria-label={open ? "Close the menu" : "Open the menu"}
            onClick={() => setOpen((o) => !o)}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
              {open ? (
                <path d="M3 3l10 10M13 3L3 13" stroke="currentColor" strokeWidth="1.5" />
              ) : (
                <path d="M2 4h12M2 8h12M2 12h12" stroke="currentColor" strokeWidth="1.5" />
              )}
            </svg>
          </button>
        </div>
      </nav>
      {open ? (
        <div id="mobile-nav" className="border-t border-line bg-bg md:hidden">
          <ul className="mx-auto max-w-6xl space-y-1 px-4 py-3">
            {[{ href: "/", label: "Home" }, ...NAV].map((n) => (
              <li key={n.href}>
                <Link
                  href={n.href}
                  aria-current={isActive(path, n.href) ? "page" : undefined}
                  className={`block rounded-md px-3 py-2 text-base ${isActive(path, n.href) ? "bg-surface text-fg" : "text-fg-muted"}`}
                >
                  {n.label}
                </Link>
              </li>
            ))}
            <li className="flex gap-2 pt-2">
              <Link
                href={LINKS.gettingStarted}
                className="flex-1 rounded-md bg-primary px-3 py-2 text-center text-sm font-medium text-primary-fg"
              >
                Get started
              </Link>
              <a
                href={LINKS.github}
                className="flex-1 rounded-md border border-line px-3 py-2 text-center text-sm text-fg"
              >
                GitHub
              </a>
            </li>
          </ul>
        </div>
      ) : null}
    </header>
  );
}
