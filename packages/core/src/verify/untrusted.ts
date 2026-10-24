// Untrusted content (SECURITY_GOVERNANCE §9): what other agents wrote, fetched pages, issues, files and A2A answers go
// into prompts only as quoted data, in a fence the content cannot close; and the verifier looks in every result for
// instructions aimed at the agents that will read it next. Pure.

/**
 * Wraps text in a Markdown code fence longer than any run of backticks inside it, so nothing in the text can end the
 * block early and pass for prompt text after it (CommonMark: a fence closes only on a run at least as long).
 */
export function fence(text: string, info = ""): string {
  let longest = 0;
  for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  const f = "`".repeat(Math.max(3, longest + 1));
  return `${f}${info}\n${text}\n${f}`;
}

/** A labelled block of untrusted content for a prompt. */
export const untrustedBlock = (heading: string, text: string, info = "") =>
  `${heading} (untrusted content)\n${fence(text, info)}`;

export interface InjectionSignal {
  kind:
    | "override"
    | "role_marker"
    | "persona"
    | "exfiltration"
    | "hidden_text"
    | "addressed_to_agents"
    | "remote_code";
  excerpt: string;
}

const PATTERNS: Array<[InjectionSignal["kind"], RegExp]> = [
  [
    "override",
    /\b(?:ignore|disregard|forget|override|bypass)\b[^.\n]{0,40}\b(?:previous|prior|above|earlier|preceding|all|your|the)\b[^.\n]{0,20}\b(?:instructions?|prompts?|rules|guidelines|directives|guardrails)\b/i,
  ],
  ["override", /\b(?:new|updated|real|actual|revised)\s+(?:system\s+)?instructions?\s*:/i],
  [
    "role_marker",
    /<\|(?:im_start|im_end|system|endoftext)\|>|\[\/?INST\]|<<\/?SYS>>|<\/?(?:system|developer)(?:_prompt)?>|^\s*#{0,3}\s*(?:system|developer)\s+(?:prompt|message|instructions?)\s*:/im,
  ],
  [
    "persona",
    /\byou are now\b[^.\n]{0,40}\b(?:unrestricted|jailbroken|in developer mode|DAN|without (?:any )?(?:rules|restrictions|limits))\b/i,
  ],
  [
    "exfiltration",
    /\b(?:send|post|upload|exfiltrate|leak|email|forward|print|reveal|output)\b[^.\n]{0,60}\b(?:api[ _-]?keys?|secrets?|tokens?|credentials|passwords?|env(?:ironment)? variables|system prompt|\.env\b)/i,
  ],
  [
    "addressed_to_agents",
    /\b(?:to|attention,?|note to|instructions? for)\s+(?:the|any|all)?\s*(?:ai|llm|language model|agents?|assistants?|models?|reviewers?|judges?)\b[^.\n]{0,30}\b(?:reading|processing|reviewing|evaluating|summari[sz]ing)\b/i,
  ],
  ["remote_code", /\b(?:curl|wget)\b[^\n|]{1,200}\|\s*(?:ba|z)?sh\b/i],
];

// Zero-width and bidirectional controls, and Unicode tag characters: text a person cannot see but a model reads.
const HIDDEN = /[​-‏‪-‮⁠-⁤⁦-⁩﻿]|[\u{E0000}-\u{E007F}]/u;

const excerptAt = (text: string, index: number, length: number) =>
  text
    .slice(Math.max(0, index - 20), index + Math.min(length, 120) + 20)
    .replace(/\s+/g, " ")
    .trim();

/**
 * Signs that a text addresses the agents that will read it rather than the person it is for: attempts to override
 * instructions, chat role markers, jailbreak personas, requests to send secrets, notes to "the AI reading this",
 * hidden characters, and piping a download into a shell. Conservative: what it finds goes to a person, not a refusal.
 */
export function findInjection(text: string, max = 5): InjectionSignal[] {
  const found: InjectionSignal[] = [];
  for (const [kind, re] of PATTERNS) {
    if (found.length >= max) break;
    const m = re.exec(text);
    if (m && !found.some((f) => f.kind === kind))
      found.push({ kind, excerpt: excerptAt(text, m.index, m[0].length) });
  }
  const hidden = HIDDEN.exec(text);
  if (hidden && found.length < max)
    found.push({
      kind: "hidden_text",
      excerpt: `U+${(hidden[0].codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")} near "${excerptAt(text, hidden.index, 1)}"`,
    });
  return found;
}
