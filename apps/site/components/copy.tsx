"use client";

import { useState } from "react";

/** Copies text (a command) to the clipboard and says so for a moment. */
export function CopyButton({
  text,
  label = "Copy",
  large = false,
}: {
  text: string;
  label?: string;
  large?: boolean;
}) {
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
      className={`rounded-sm border font-mono transition-colors duration-fast ${large ? "border-line-strong px-3 py-1 text-xs text-fg hover:border-primary hover:text-primary" : "border-line px-2 py-0.5 text-2xs text-fg-muted hover:border-line-strong hover:text-fg"}`}
      aria-label={copied ? "Copied" : `${label}: ${text}`}
    >
      {copied ? "copied" : label.toLowerCase()}
    </button>
  );
}
