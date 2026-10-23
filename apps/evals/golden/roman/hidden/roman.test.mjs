import assert from "node:assert/strict";
import { test } from "node:test";
import { toRoman } from "../src/roman.mjs";

test("large", () => {
  assert.equal(toRoman(1994), "MCMXCIV");
  assert.equal(toRoman(3999), "MMMCMXCIX");
  assert.equal(toRoman(40), "XL");
});
