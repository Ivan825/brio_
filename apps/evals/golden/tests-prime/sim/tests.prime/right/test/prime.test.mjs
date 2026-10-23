import assert from "node:assert/strict";
import { test } from "node:test";
import { isPrime } from "../src/prime.mjs";

test("edges", () => {
  assert.equal(isPrime(0), false);
  assert.equal(isPrime(1), false);
  assert.equal(isPrime(2), true);
});
test("composites", () => {
  for (const n of [4, 9, 15, 25, 49]) assert.equal(isPrime(n), false);
});
test("primes", () => {
  for (const n of [3, 5, 7, 97]) assert.equal(isPrime(n), true);
});
