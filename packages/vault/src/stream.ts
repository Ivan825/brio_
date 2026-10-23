import { Writable } from "node:stream";
import { redactor as defaultRedactor, type Redactor } from "./redactor";

/**
 * Wraps a log destination so every line is redacted before it is written. Lines are buffered until a newline, so a
 * secret split across two writes is still caught. Use as the pino/Fastify logger stream.
 */
export function redactingStream(dest: NodeJS.WritableStream, r: Redactor = defaultRedactor): Writable {
  let pending = "";
  return new Writable({
    decodeStrings: false,
    write(chunk: Buffer | string, _encoding, callback) {
      pending += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      const lastNewline = pending.lastIndexOf("\n");
      if (lastNewline === -1) return callback();
      const complete = pending.slice(0, lastNewline + 1);
      pending = pending.slice(lastNewline + 1);
      dest.write(r.redact(complete), callback);
    },
    final(callback) {
      if (pending) dest.write(r.redact(pending));
      pending = "";
      if (dest === process.stdout || dest === process.stderr) return callback();
      dest.end(callback);
    },
  });
}
