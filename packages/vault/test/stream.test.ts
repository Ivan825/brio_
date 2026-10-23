import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { Redactor } from "../src/redactor";
import { redactingStream } from "../src/stream";

const planted = "brio-planted-9f8e7d6c5b4a39281706f5e4d3c2b1a0";

describe("redactingStream", () => {
  it("never lets a planted secret reach the underlying log sink", async () => {
    const r = new Redactor();
    r.register(planted);
    const chunks: string[] = [];
    const sink = new Writable({
      write(chunk, _enc, cb) {
        chunks.push(String(chunk));
        cb();
      },
    });
    const out = redactingStream(sink, r);
    out.write(`{"msg":"calling with ${planted}"}\n`);
    // a secret split across two writes is still caught because lines are buffered
    out.write(`{"msg":"${planted.slice(0, 20)}`);
    out.write(`${planted.slice(20)}"}\n`);
    await new Promise<void>((resolve) => out.end(resolve));
    const all = chunks.join("");
    expect(all).not.toContain(planted);
    expect(all.split("\n").filter(Boolean)).toHaveLength(2);
  });
});
