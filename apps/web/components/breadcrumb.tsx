"use client";

import { usePathname } from "next/navigation";

/** `~/missions` style location, in mono (brand/BRAND.md §4). */
export function Breadcrumb() {
  const pathname = usePathname();
  return (
    <span className="truncate font-mono text-xs text-fg-subtle" data-testid="breadcrumb">
      ~{pathname === "/" ? "" : pathname}
    </span>
  );
}
