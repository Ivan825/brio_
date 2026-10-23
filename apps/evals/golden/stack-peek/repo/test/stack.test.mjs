import assert from "node:assert/strict";
import { test } from "node:test";
import { Stack } from "../src/stack.mjs";

test("peek", () => {
  const s = new Stack();
  s.push(1);
  s.push(2);
  assert.equal(s.peek(), 2);
  assert.equal(s.pop(), 2);
});
