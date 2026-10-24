// Who may create an account (D-107). By default anyone who can reach Brio may sign up and make workspaces of their own.
// With BRIO_SIGNUP_ALLOW set — a Brio on a public address, such as a laptop behind a tunnel — only the listed addresses
// (or domains, "@example.com") and people with a pending invitation may; everyone who already has an account still
// signs in. Sign-in links are not even sent to anyone else, so a public sign-in page cannot make the owner's mailbox
// write to strangers.
import { type Db, schema } from "@brio/db";
import { and, eq, gt, sql } from "drizzle-orm";

const { invitations, users } = schema;

/** BRIO_SIGNUP_ALLOW parsed: exact addresses and "@domain" entries, lowercased; null when sign-up is open. */
export function signupAllowList(raw: string | undefined): string[] | null {
  if (raw === undefined) return null;
  return raw
    .split(/[\s,]+/)
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

export class SignupPolicy {
  private readonly allow: string[] | null;

  constructor(
    private readonly db: Db,
    raw: string | undefined,
  ) {
    this.allow = signupAllowList(raw);
  }

  get open(): boolean {
    return this.allow === null;
  }

  /** Whether a new account may be created for this address. */
  async maySignUp(email: string): Promise<boolean> {
    if (!this.allow) return true;
    const e = email.trim().toLowerCase();
    if (this.allow.some((a) => (a.startsWith("@") ? e.endsWith(a) : e === a))) return true;
    const [invited] = await this.db
      .select({ id: invitations.id })
      .from(invitations)
      .where(
        and(
          sql`lower(${invitations.email}) = ${e}`,
          eq(invitations.status, "pending"),
          gt(invitations.expiresAt, new Date()),
        ),
      )
      .limit(1);
    return Boolean(invited);
  }

  /** Whether Brio may email this address a sign-in link: an existing account, or one that may be created. */
  async maySignIn(email: string): Promise<boolean> {
    if (!this.allow) return true;
    const [user] = await this.db
      .select({ id: users.id })
      .from(users)
      .where(sql`lower(${users.email}) = ${email.trim().toLowerCase()}`)
      .limit(1);
    return Boolean(user) || this.maySignUp(email);
  }
}
