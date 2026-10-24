import type { FastifyBaseLogger } from "fastify";

export interface Mail {
  to: string;
  subject: string;
  text: string;
  /** The link the email carries (magic link, invitation). */
  link?: string;
  sentAt: string;
}

export interface Mailer {
  send(mail: Omit<Mail, "sentAt">): Promise<void>;
}

/**
 * The development mailer: emails are logged locally (BUILD_PLAN M0 acceptance: "invite member (email logged locally)") and kept in
 * a small in-memory outbox for the dev/test outbox endpoint. A real provider arrives with notifications in M9.
 */
export class LogMailer implements Mailer {
  private readonly outbox: Mail[] = [];
  private log: Pick<FastifyBaseLogger, "info"> | null = null;

  constructor(private readonly capacity = 200) {}

  attachLogger(log: Pick<FastifyBaseLogger, "info">): void {
    this.log = log;
  }

  async send(mail: Omit<Mail, "sentAt">): Promise<void> {
    const m: Mail = { ...mail, sentAt: new Date().toISOString() };
    this.outbox.push(m);
    if (this.outbox.length > this.capacity) this.outbox.shift();
    this.log?.info(
      { mail: { to: m.to, subject: m.subject, link: m.link } },
      `email to ${m.to}: ${m.subject}`,
    );
  }

  messagesFor(email: string): Mail[] {
    return this.outbox.filter((m) => m.to.toLowerCase() === email.toLowerCase());
  }
}

/**
 * Email through Resend's API (M9; POST /emails with a bearer key, verified against resend.com/docs on 24 Oct 2026).
 * Every email is also kept in the local outbox when that is on (development and tests).
 */
export class ResendMailer implements Mailer {
  constructor(
    private readonly o: {
      apiKey: string;
      from: string;
      fetch: (url: string, init: RequestInit) => Promise<Response>;
      outbox?: LogMailer;
      appName?: string;
    },
  ) {}

  async send(mail: Omit<Mail, "sentAt">): Promise<void> {
    await this.o.outbox?.send(mail);
    const res = await this.o.fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${this.o.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: this.o.from,
        to: [mail.to],
        subject: mail.subject,
        text: mail.link && !mail.text.includes(mail.link) ? `${mail.text}\n\n${mail.link}` : mail.text,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Resend refused the email (HTTP ${res.status}): ${body.slice(0, 200)}`);
    }
  }
}
