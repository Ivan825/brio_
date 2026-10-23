import assert from "node:assert/strict";
import { test } from "node:test";
import { retry } from "../src/retry.mjs";

test("exact count", async () => {
  let n = 0;
  await assert.rejects(
    retry(async () => {
      n++;
      throw new Error("e" + n);
    }, 4),
    /e4/,
  );
  assert.equal(n, 4);
});
test("one try", async () => {
  let n = 0;
  await assert.rejects(
    retry(async () => {
      n++;
      throw new Error("x");
    }, 1),
  );
  assert.equal(n, 1);
});
