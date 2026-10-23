import type { Redactor } from "@brio/vault";
import type { Logger } from "./types";

type Sink = (level: "debug" | "info" | "warn" | "error", obj: Record<string, unknown>, msg?: string) => void;

/** Adapters log only through this: every field passes the redactor before it reaches the sink (CLAUDE.md rule 7). */
export function redactingLogger(
  sink: Sink,
  redactor: Redactor,
  bindings: Record<string, unknown> = {},
): Logger {
  const log =
    (level: "debug" | "info" | "warn" | "error") => (obj: Record<string, unknown> | string, msg?: string) => {
      const fields = typeof obj === "string" ? { msg: obj } : obj;
      const safe = redactor.redactDeep({ ...bindings, ...fields }) as Record<string, unknown>;
      sink(level, safe, msg === undefined ? undefined : redactor.redact(msg));
    };
  return { debug: log("debug"), info: log("info"), warn: log("warn"), error: log("error") };
}

/** For pino-style loggers (Fastify's app.log). */
export function pinoSink(
  p: Record<"debug" | "info" | "warn" | "error", (obj: object, msg?: string) => void>,
): Sink {
  return (level, obj, msg) => p[level](obj, msg);
}
