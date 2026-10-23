import assert from "node:assert/strict";
import { test } from "node:test";
import { toRoman } from "../src/roman.mjs";

test("small", () => {
  assert.equal(toRoman(4), "IV");
  assert.equal(toRoman(9), "IX");
  assert.equal(toRoman(14), "XIV");
});
