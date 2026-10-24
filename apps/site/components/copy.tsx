"use client";

import { useState } from "react";

/** Copies text (a command) to the clipboard and says so for a moment. */
export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard?.writeText(text).then(
          () => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          },
          () => {},
        );
      }}
      className="rounded-sm border border-line px-2 py-0.5 font-mono text-2xs text-fg-muted transition-colors duration-fast hover:border-line-strong hover:text-fg"
      aria-label={copied ? "Copied" : `${label}: ${text}`}
    >
      {copied ? "copied" : label.toLowerCase()}
    </button>
  );
}
