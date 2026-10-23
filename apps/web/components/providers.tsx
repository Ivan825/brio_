"use client";

import { ThemeProvider } from "next-themes";
import type { ReactNode } from "react";
import { RunningProvider } from "./running";

export function Providers({ children }: { children: ReactNode }) {
  return (
    <ThemeProvider attribute="data-theme" defaultTheme="dark" enableSystem={false} themes={["dark", "light"]}>
      <RunningProvider>{children}</RunningProvider>
    </ThemeProvider>
  );
}
