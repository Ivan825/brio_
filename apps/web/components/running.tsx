"use client";

import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from "react";

interface RunningState {
  /** True while any mission, task or request in the app is running. Drives the blinking cursor. */
  running: boolean;
  setRunning: (key: string, isRunning: boolean) => void;
}

const RunningContext = createContext<RunningState | null>(null);

export function RunningProvider({ children }: { children: ReactNode }) {
  const [keys, setKeys] = useState<ReadonlySet<string>>(new Set());

  const setRunning = useCallback((key: string, isRunning: boolean) => {
    setKeys((prev) => {
      if (prev.has(key) === isRunning) return prev;
      const next = new Set(prev);
      if (isRunning) next.add(key);
      else next.delete(key);
      return next;
    });
  }, []);

  const value = useMemo(() => ({ running: keys.size > 0, setRunning }), [keys, setRunning]);
  return <RunningContext.Provider value={value}>{children}</RunningContext.Provider>;
}

export function useRunning(): RunningState {
  const ctx = useContext(RunningContext);
  if (!ctx) throw new Error("useRunning must be used inside <RunningProvider>");
  return ctx;
}
