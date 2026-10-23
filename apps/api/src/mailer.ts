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
 * M0 mailer: emails are logged locally (BUILD_PLAN M0 acceptance: "invite member (email logged locally)") and kept in
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
