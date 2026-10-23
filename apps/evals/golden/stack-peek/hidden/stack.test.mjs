import assert from "node:assert/strict";
import { test } from "node:test";
import { Stack } from "../src/stack.mjs";

test("empty", () => assert.equal(new Stack().peek(), undefined));
test("size", () => {
  const s = new Stack();
  s.push(1);
  s.push(2);
  s.peek();
  s.pop();
  assert.equal(s.size, 1);
});
