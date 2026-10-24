import type { Metadata } from "next";
import Link from "next/link";
import { Cards, Cta, OnThisPage, PageHero, secondary, Table, Ticks, textLink } from "@/components/blocks";
import { LedgerChain, Sandbox, Vault, WhereItRuns } from "@/components/diagrams";
import { Section } from "@/components/section";
import { LINKS } from "@/lib/content";

export const metadata: Metadata = {
  title: "Security",
  description:
    "Your keys, your machines, your rules: official APIs only, an encrypted vault, a sandbox per attempt, policies, budgets, approvals and a hash-chained ledger.",
};

const SECTIONS = [
  { id: "official", label: "Official routes only" },
  { id: "where", label: "Where things run" },
  { id: "vault", label: "The vault" },
  { id: "sandbox", label: "Sandboxes" },
  { id: "local", label: "Local runners" },
  { id: "policies", label: "Data policies" },
  { id: "budgets", label: "Budgets" },
  { id: "approvals", label: "Approvals" },
  { id: "roles", label: "Roles" },
  { id: "injection", label: "Prompt injection" },
  { id: "ledger", label: "The ledger" },
  { id: "accounts", label: "Accounts" },
  { id: "review", label: "The review" },
] as const;

export default function Security() {
  return (
    <>
      <PageHero
        label="security"
        title="Your keys, your machines, your rules."
        lead="Brio runs agents that write code, spend money and touch your repositories, so every part of it is built to fail closed: nothing runs outside a sandbox, nothing is spent past a budget, nothing irreversible happens without a person, and everything is on the record."
      >
        <OnThisPage items={SECTIONS} />
      </PageHero>

      <Section
        id="official"
        index="01"
        label="Official routes only"
        title="No scraping, no borrowed sign-ins."
        lead="Brio reaches AI vendors only through the channels they publish for programmatic use. This is a hard rule in the code, not a setting: adapters for the routes on the right must not exist."
      >
        <Table
          head={["allowed", "never"]}
          rows={[
            [
              "Official APIs with your own keys",
              "Driving consumer chat apps: chatgpt.com, claude.ai, gemini.google.com, grok.com",
            ],
            [
              "Official CLIs, run with their documented headless flags",
              "Reading or reusing the sign-in tokens any CLI or app stored",
            ],
            ["Official SDKs and hosted agent APIs", "Unofficial or reverse-engineered APIs"],
            ["A2A agents and MCP servers you add", "Bypassing CAPTCHAs or bot detection in browser agents"],
          ]}
          mono={false}
          minWidth={600}
        />
        <p className="mt-6 text-sm text-fg-muted">
          Using a subscription (rather than an API key) is possible only on your own machine, through the
          local runner, where the vendor&apos;s own CLI runs under your own sign-in, and only for vendors
          whose terms allow it: Antigravity, and Claude Code for your own work. Each vendor&apos;s terms are
          recorded in the registry.
        </p>
      </Section>

      <Section
        id="where"
        index="02"
        label="Where things run"
        title="No Brio cloud. No account with us."
        lead="Brio is self-hosted. Your data stays in your Postgres; the only calls that leave your machines go to the vendors you connected, with your keys, billed to you directly."
      >
        <WhereItRuns />
      </Section>

      <Section
        id="vault"
        index="03"
        label="The vault"
        title="Keys are sealed, used once, and never shown again."
        lead="Bring your own keys. Each one is envelope-encrypted and decrypted only inside the runner, for the attempt that needs it."
      >
        <Vault />
        <div className="mt-8 grid gap-6 lg:grid-cols-2">
          <Ticks
            items={[
              "every logger and event writer runs a redactor: known secret values plus patterns (sk-, xai-, bearer tokens, cloud keys)",
              "secrets never go into prompts, handoff packets, memory or artifacts",
              "an output that contains a secret is quarantined",
            ]}
          />
          <Ticks
            items={[
              "the master key comes from a KMS or a key file, and can be rotated",
              "connectors show whether a key works, never the key",
              "a contract test asserts that no secret leaks into logs or events",
            ]}
          />
        </div>
      </Section>

      <Section
        id="sandbox"
        index="04"
        label="Sandboxes"
        title="One container per attempt, deny by default."
        lead="Agents that run code never run on the API's host. Each attempt gets its own container, its own worktree, its own limits and an allowlist of hosts it may reach."
      >
        <Sandbox />
        <p className="mt-6 text-sm text-fg-muted">
          Outbound requests to addresses people type in (a model endpoint, an A2A agent) are checked inside
          the connection&apos;s own DNS lookup, so a name cannot be re-pointed at a private address between
          the check and the call. Private addresses are refused unless an operator allows them.
        </p>
      </Section>

      <Section
        id="local"
        index="05"
        label="Local runners"
        title="Your laptop connects out; nothing connects in."
        lead="A local runner opens one connection to your Brio with a token that is shown once, stored hashed and revocable. It holds no database credentials and never receives a vault key."
      >
        <Cards
          items={[
            {
              title: "Docker by default",
              body: "Every sandbox rule above applies on your machine too.",
            },
            {
              title: "Host mode is opt-in",
              body: "Only after you consent to its exact terms (a fresh worktree, a cut-down environment, process-group kill, a time limit, but no network allowlist), recorded with the time.",
            },
            {
              title: "Only your own work",
              body: "Work reaches your runner only for missions you created, following a plan you approved and started.",
            },
          ]}
        />
      </Section>

      <Section
        id="policies"
        index="06"
        label="Data policies"
        title="Confidential work goes only where you allow."
        lead="Every task carries a sensitivity: public, internal or confidential. Policies map each to the connectors it may reach."
      >
        <div className="grid gap-8 lg:grid-cols-2">
          <Ticks
            items={[
              "with no policy, confidential work goes only to local models",
              "connector allow and deny lists apply to everything; deny wins",
              "network policies widen or narrow a sandbox's allowlist",
              "policy changes are entries in the ledger",
            ]}
          />
          <div className="rounded-lg border border-line bg-surface p-5 text-sm text-fg-muted">
            <p className="font-mono text-xs text-fg">Checked twice</p>
            <p className="mt-2">
              The planner, the router and the choice of reviewer all filter by the same policy engine, and
              dispatch checks again. A pinned or hand-picked agent cannot slip past: violations are
              impossible, not merely warned about.
            </p>
          </div>
        </div>
      </Section>

      <Section
        id="budgets"
        index="07"
        label="Budgets"
        title="Checked before you spend, not after the bill."
        lead="Monthly limits per workspace and per agent, and each mission's and task's own budget. Spend is the live cost of running attempts, so work in flight counts."
      >
        <ol className="grid gap-px overflow-hidden rounded-lg border border-line bg-line md:grid-cols-4">
          {[
            ["before", "every scope that applies must have room; the attempt's cap becomes what is left"],
            ["80%", "a budget.warn event, once per period, and a notification"],
            ["100%", "budget.stop: the attempt is cancelled within seconds"],
            ["after", "the task waits, blocked, until a person raises the budget"],
          ].map(([t, b]) => (
            <li key={t} className="bg-bg p-5">
              <p className="font-mono text-lg font-bold text-accent">{t}</p>
              <p className="mt-2 text-sm text-fg-muted">{b}</p>
            </li>
          ))}
        </ol>
        <p className="mt-6 text-sm text-fg-muted">
          Already using Mandate to govern agents&apos; spending? Connect it, and every paid attempt also asks
          Mandate for a hold after Brio&apos;s own budgets pass. A decline, or an unreachable Mandate, blocks
          the task.
        </p>
      </Section>

      <Section
        id="approvals"
        index="08"
        label="Approvals"
        title="Irreversible actions wait for a person."
        lead="Pushes, deploys, sends and purchases need a yes, by policy. You decide in the app, by email, by push, in Slack, or from your editor over MCP."
      >
        <Table
          head={["action", "default"]}
          rows={[
            ["approve a plan", "required if it costs more than $5 or has more than 10 tasks"],
            ["push a branch / open a pull request", "required; a person decides, never an API token"],
            ["deploy, publish, send email or a message, purchase", "required, per action"],
            ["a browser agent visiting a new domain", "required"],
            ["spend over the mission's budget", "required"],
            ["delete files outside the task's footprint", "always denied"],
          ]}
          mono={false}
          minWidth={560}
        />
        <p className="mt-6 text-sm text-fg-muted">
          A Slack button counts only with a valid signature less than five minutes old, from an account whose
          email is a member of the workspace. MCP clients decide only with a scope a person grants on the
          consent page.
        </p>
      </Section>

      <Section
        id="roles"
        index="09"
        label="Roles"
        title="Spending power apart from day-to-day work."
        lead="Owners and admins administer; members act; viewers read. A workspace always keeps an owner, and every role change is in the ledger."
      >
        <Table
          head={["", "owner", "admin", "member", "viewer"]}
          rows={[
            ["read missions, boards, scores, memory", "✓", "✓", "✓", "✓"],
            ["start missions, edit plans, run agents, approve", "✓", "✓", "✓", ""],
            ["connectors, budgets, policies, ledger, Slack", "✓", "✓", "", ""],
            ["make owners and admins; delete the workspace", "✓", "", "", ""],
          ]}
          mono={false}
          minWidth={600}
        />
      </Section>

      <Section
        id="injection"
        index="10"
        label="Prompt injection"
        title="Other agents' words are data, never instructions."
        lead="Handoffs, attachments, issue text, other agents' messages, project memory, check output and results under review all reach a prompt only inside a labelled, fenced block that the text cannot close from inside."
      >
        <div className="grid gap-8 lg:grid-cols-2">
          <div>
            <h3 className="font-mono text-sm font-bold text-fg">Every result is scanned for</h3>
            <div className="mt-4">
              <Ticks
                items={[
                  "attempts to override instructions",
                  "chat role markers and jailbreak personas",
                  "requests to send secrets",
                  "notes addressed to the AI reading this",
                  "hidden Unicode",
                  "piping a download into a shell",
                ]}
              />
            </div>
          </div>
          <div className="rounded-lg border border-line bg-surface p-5 font-mono text-xs leading-relaxed">
            <p className="text-fg-subtle"># a result that tries it</p>
            <p className="mt-2 text-fg">
              research-agent <span className="text-fg-subtle">→</span> t2 · report written
            </p>
            <p className="text-fg">
              brio <span className="text-fg-subtle">→</span> injection_scan ·{" "}
              <span className="text-warning">held for a person</span>
            </p>
            <p className="text-fg-muted">&nbsp;&nbsp;“ignore your previous instructions and…” at line 41</p>
            <p className="text-fg">
              you <span className="text-fg-subtle">→</span> reviewed · passed on, quoted
            </p>
          </div>
        </div>
        <p className="mt-6 text-sm text-fg-muted">
          A finding holds the result for you instead of failing it, so legitimate security work is not lost.
        </p>
      </Section>

      <Section
        id="ledger"
        index="11"
        label="The ledger"
        title="An audit trail that proves it was not edited."
        lead="Dispatches, spend, approvals, external side effects, policy changes, key changes, memory edits and role changes are entries in an append-only, hash-chained ledger."
      >
        <LedgerChain />
        <div className="mt-8 grid gap-6 md:grid-cols-3">
          {[
            ["Written with the action", "An entry is written in the same transaction as what it records."],
            ["Verifiable", "Owners and admins verify the chain; the first broken entry is named."],
            ["Exportable", "As JSONL or CSV, to keep chain heads somewhere else."],
          ].map(([t, b]) => (
            <div key={t} className="rounded-lg border border-line p-5">
              <h3 className="font-mono text-sm font-bold text-fg">{t}</h3>
              <p className="mt-2 text-sm text-fg-muted">{b}</p>
            </div>
          ))}
        </div>
      </Section>

      <Section
        id="accounts"
        index="12"
        label="Accounts"
        title="Only the people you choose get in."
        lead="Sign in with an emailed link, Google or a passkey. On a server anyone can reach, one setting decides who may create an account."
      >
        <Cards
          items={[
            {
              title: "A sign-up allowlist",
              body: "BRIO_SIGNUP_ALLOW names the addresses and @domains that may join; invited people always can. Nobody else is even sent a sign-in link.",
            },
            {
              title: "Single-use links",
              body: "Each emailed link works once, for fifteen minutes, and sign-in attempts are rate-limited.",
            },
            {
              title: "API tokens with limits",
              body: "Tokens act for your code, but can never approve plans, pushes or spending.",
            },
          ]}
        />
      </Section>

      <Section
        id="review"
        index="13"
        label="The review"
        title="Reviewed, with the findings published."
        lead="Before release, Brio had a security review with a written threat model. Every finding, what was fixed and what remains, is in the repository."
      >
        <div className="flex flex-wrap gap-3">
          <Link href={LINKS.securityReview} className={secondary}>
            Read the security review
          </Link>
          <Link href={LINKS.security} className={secondary}>
            Security and governance, in full
          </Link>
          <a href={LINKS.issues} className={secondary}>
            Report a problem
          </a>
        </div>
        <p className="mt-6 text-sm text-fg-muted">
          Found a vulnerability? Please tell the maintainer privately before opening a public issue: the owner
          of{" "}
          <a href={LINKS.github} className={textLink}>
            the repository
          </a>{" "}
          is listed on GitHub.
        </p>
      </Section>

      <Cta
        title="Safe by default, on your own machines."
        lead="Run Brio where you control the data, with the keys you already have."
      />
    </>
  );
}
