import assert from "node:assert/strict";
import { test } from "node:test";
import { clamp } from "../src/clamp.mjs";

test("inside", () => assert.equal(clamp(5, 0, 10), 5));
test("bounds", () => {
  assert.equal(clamp(0, 0, 10), 0);
  assert.equal(clamp(10, 0, 10), 10);
});
test("outside", () => {
  assert.equal(clamp(-3, 0, 10), 0);
  assert.equal(clamp(42, 0, 10), 10);
});
