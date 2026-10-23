import assert from "node:assert/strict";
import { test } from "node:test";
import { createBucket } from "../src/bucket.mjs";

test("refills", () => {
  let t = 0;
  const b = createBucket({ capacity: 1, refillPerSec: 2, now: () => t });
  assert.equal(b.allow(), true);
  assert.equal(b.allow(), false);
  t = 500;
  assert.equal(b.allow(), true);
});
test("never above capacity", () => {
  let t = 0;
  const b = createBucket({ capacity: 2, refillPerSec: 10, now: () => t });
  t = 10000;
  assert.deepEqual([b.allow(), b.allow(), b.allow()], [true, true, false]);
});
