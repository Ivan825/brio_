import assert from "node:assert/strict";
import { test } from "node:test";
import { isPrime } from "../src/prime.mjs";

test("seven", () => assert.equal(isPrime(7), true));
