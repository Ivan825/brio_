// D-106: email through any SMTP server (a mailbox you already have, no domain of your own). The mailer signs in, sends
// the link in the body, and when the server refuses, says why without repeating the credentials. A small fake SMTP
// server stands in for Gmail; the configuration picks Resend first, then SMTP, then the log.
import { once } from "node:events";
import { type AddressInfo, createServer, type Server, type Socket } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";
import { LogMailer, SmtpMailer } from "../src/mailer";

const USER = "brio.owner@gmail.example";
const PASSWORD = ["abcd", "efgh", "ijkl", "mnop"].join("");

interface Received {
  auth: string | null;
  from: string;
  to: string[];
  data: string;
}

/** Just enough ESMTP (EHLO, AUTH PLAIN/LOGIN, MAIL, RCPT, DATA, QUIT) to receive what nodemailer sends. */
function fakeSmtp(password: string) {
  const received: Received[] = [];
  const server = createServer((socket: Socket) => {
    let buffer = "";
    let inData = false;
    let pending: "plain" | "login-user" | "login-pass" | null = null;
    let loginUser = "";
    let mail: Received = { auth: null, from: "", to: [], data: "" };
    const say = (line: string) => socket.write(`${line}\r\n`);
    const authenticate = (user: string, pass: string) => {
      if (pass === password) {
        mail.auth = user;
        say("235 2.7.0 Accepted");
      } else say("535 5.7.8 Username and Password not accepted");
    };
    const plain = (b64: string) => {
      const [, user = "", pass = ""] = Buffer.from(b64, "base64").toString().split("\0");
      authenticate(user, pass);
    };
    say("220 fake.smtp ESMTP");
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      for (let i = buffer.indexOf("\r\n"); i >= 0; i = buffer.indexOf("\r\n")) {
        const line = buffer.slice(0, i);
        buffer = buffer.slice(i + 2);
        if (inData) {
          if (line === ".") {
            inData = false;
            received.push(mail);
            mail = { auth: mail.auth, from: "", to: [], data: "" };
            say("250 2.0.0 queued");
          } else mail.data += `${line.startsWith("..") ? line.slice(1) : line}\n`;
          continue;
        }
        if (pending === "plain") {
          pending = null;
          plain(line);
          continue;
        }
        if (pending === "login-user") {
          loginUser = Buffer.from(line, "base64").toString();
          pending = "login-pass";
          say("334 UGFzc3dvcmQ6");
          continue;
        }
        if (pending === "login-pass") {
          pending = null;
          authenticate(loginUser, Buffer.from(line, "base64").toString());
          continue;
        }
        const [verb = "", ...rest] = line.split(" ");
        switch (verb.toUpperCase()) {
          case "EHLO":
            say("250-fake.smtp");
            say("250 AUTH PLAIN LOGIN");
            break;
          case "AUTH":
            if (rest[0]?.toUpperCase() === "PLAIN" && rest[1]) plain(rest[1]);
            else if (rest[0]?.toUpperCase() === "PLAIN") {
              pending = "plain";
              say("334 ");
            } else {
              pending = "login-user";
              say("334 VXNlcm5hbWU6");
            }
            break;
          case "MAIL":
            mail.from = line.slice(line.indexOf(":") + 1).trim();
            say("250 2.1.0 OK");
            break;
          case "RCPT":
            mail.to.push(line.slice(line.indexOf(":") + 1).trim());
            say("250 2.1.5 OK");
            break;
          case "DATA":
            inData = true;
            say("354 go ahead");
            break;
          case "QUIT":
            say("221 2.0.0 bye");
            socket.end();
            break;
          default:
            say("250 OK");
        }
      }
    });
    socket.on("error", () => {});
  });
  return { server, received };
}

describe("SMTP email (D-106)", () => {
  let server: Server;
  let received: Received[];
  let port: number;

  beforeAll(async () => {
    ({ server, received } = fakeSmtp(PASSWORD));
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => {
    server.close();
  });

  it("signs in and sends the email, with its link in the body", async () => {
    const outbox = new LogMailer();
    const mailer = new SmtpMailer(
      { host: "127.0.0.1", port, tls: "none", auth: { user: USER, pass: PASSWORD } },
      { from: `Brio <${USER}>`, outbox },
    );
    await mailer.send({
      to: "teammate@example.com",
      subject: "Sign in to Brio",
      text: "Open this link to sign in.",
      link: "https://brio.example.ts.net/api/auth/magic-link/verify?token=abc",
    });
    expect(received).toHaveLength(1);
    const [m] = received;
    expect(m!.auth).toBe(USER);
    expect(m!.from).toContain(USER);
    expect(m!.to).toEqual(["<teammate@example.com>"]);
    expect(m!.data).toMatch(/^Subject: Sign in to Brio$/m);
    expect(m!.data).toContain("Open this link to sign in.");
    expect(m!.data.replace(/=\n/g, "")).toContain("token=abc");
    // The development outbox keeps a copy.
    expect(outbox.messagesFor("teammate@example.com")).toHaveLength(1);
  });

  it("says why the server refused, without the password", async () => {
    const wrong = ["wrong", "password", "zzzz"].join("-");
    const mailer = new SmtpMailer(
      { host: "127.0.0.1", port, tls: "none", auth: { user: USER, pass: wrong } },
      { from: `Brio <${USER}>` },
    );
    const err = await mailer.send({ to: "teammate@example.com", subject: "Hi", text: "Hi" }).then(
      () => null,
      (e: Error) => e,
    );
    expect(err?.message).toMatch(/SMTP server refused the email \(535\)/);
    expect(err?.message).not.toContain(wrong);
    expect(err?.message).not.toContain(Buffer.from(`\0${USER}\0${wrong}`).toString("base64"));
  });
});

describe("choosing who sends email", () => {
  const BASE = {
    DATABASE_URL: "postgres://brio:brio@localhost:5432/brio",
    BETTER_AUTH_SECRET: "x".repeat(40),
  };
  const RESEND = ["re", "choose0123456789"].join("_");

  it("logs emails when nothing is set", () => {
    const c = loadConfig(BASE);
    expect(c.email).toBe("log");
    expect(c.smtp).toBeNull();
    expect(c.BRIO_EMAIL_FROM).toBe("Brio <onboarding@resend.dev>");
  });

  it("sends through SMTP as the mailbox by default, TLS by port", () => {
    const gmail = loadConfig({
      ...BASE,
      BRIO_SMTP_HOST: "smtp.gmail.com",
      BRIO_SMTP_USER: USER,
      BRIO_SMTP_PASSWORD: PASSWORD,
    });
    expect(gmail.email).toBe("smtp");
    expect(gmail.smtp).toEqual({
      host: "smtp.gmail.com",
      port: 465,
      tls: "implicit",
      auth: { user: USER, pass: PASSWORD },
    });
    expect(gmail.BRIO_EMAIL_FROM).toBe(`Brio <${USER}>`);
    const submission = loadConfig({
      ...BASE,
      BRIO_SMTP_HOST: "smtp.office365.com",
      BRIO_SMTP_PORT: "587",
      BRIO_SMTP_USER: USER,
      BRIO_SMTP_PASSWORD: PASSWORD,
      BRIO_EMAIL_FROM: "Brio <brio@example.com>",
    });
    expect(submission.smtp?.tls).toBe("starttls");
    expect(submission.BRIO_EMAIL_FROM).toBe("Brio <brio@example.com>");
  });

  it("prefers Resend when both are set", () => {
    const c = loadConfig({ ...BASE, RESEND_API_KEY: RESEND, BRIO_SMTP_HOST: "smtp.gmail.com" });
    expect(c.email).toBe("resend");
    expect(c.BRIO_EMAIL_FROM).toBe("Brio <onboarding@resend.dev>");
  });

  it("refuses half a configuration, and a password without TLS in production", () => {
    expect(() => loadConfig({ ...BASE, BRIO_SMTP_HOST: "smtp.gmail.com", BRIO_SMTP_USER: USER })).toThrow(
      /go together/,
    );
    expect(() => loadConfig({ ...BASE, BRIO_SMTP_USER: USER, BRIO_SMTP_PASSWORD: PASSWORD })).toThrow(
      /BRIO_SMTP_HOST/,
    );
    expect(() =>
      loadConfig({
        ...BASE,
        NODE_ENV: "production",
        BRIO_SMTP_HOST: "mail.example.com",
        BRIO_SMTP_TLS: "none",
        BRIO_SMTP_USER: USER,
        BRIO_SMTP_PASSWORD: PASSWORD,
      }),
    ).toThrow(/without TLS/);
  });
});
