import assert from "node:assert/strict";
import { test } from "node:test";
import { retry } from "../src/retry.mjs";

test("third time lucky", async () => {
  let n = 0;
  assert.equal(
    await retry(async () => {
      if (++n < 3) throw new Error("no");
      return "ok";
    }, 3),
    "ok",
  );
});
