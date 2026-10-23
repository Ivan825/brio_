import assert from "node:assert/strict";
import { test } from "node:test";
import { add, mul } from "../src/calc.mjs";

test("signs", () => {
  assert.equal(add(-1, 1), 0);
  assert.equal(add(-2, -3), -5);
});
test("mul untouched", () => assert.equal(mul(3, 4), 12));
