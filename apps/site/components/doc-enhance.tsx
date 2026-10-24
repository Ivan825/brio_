"use client";

import { useEffect } from "react";

/** Adds a copy button to each code block of a rendered doc (the HTML comes from Markdown at build time). */
export function DocEnhance({ root }: { root: string }) {
  useEffect(() => {
    const body = document.getElementById(root);
    if (!body) return;
    const added: HTMLButtonElement[] = [];
    for (const block of body.querySelectorAll<HTMLElement>(".code-block")) {
      const label = block.querySelector(".code-label");
      const code = block.querySelector("pre code");
      if (!label || !code || label.querySelector("button")) continue;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "code-copy";
      button.textContent = "copy";
      button.setAttribute("aria-label", "Copy this code");
      button.addEventListener("click", () => {
        navigator.clipboard?.writeText(code.textContent ?? "").then(
          () => {
            button.textContent = "copied";
            setTimeout(() => {
              button.textContent = "copy";
            }, 1500);
          },
          () => {},
        );
      });
      label.append(button);
      added.push(button);
    }
    return () => {
      for (const b of added) b.remove();
    };
  }, [root]);
  return null;
}
