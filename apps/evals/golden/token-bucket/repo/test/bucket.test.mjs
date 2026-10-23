import assert from "node:assert/strict";
import { test } from "node:test";
import { createBucket } from "../src/bucket.mjs";

test("capacity", () => {
  const b = createBucket({ capacity: 2, refillPerSec: 1, now: () => 0 });
  assert.deepEqual([b.allow(), b.allow(), b.allow()], [true, true, false]);
});
