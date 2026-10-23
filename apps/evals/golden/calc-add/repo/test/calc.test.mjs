import assert from "node:assert/strict";
import { test } from "node:test";
import { add } from "../src/calc.mjs";

test("adds", () => assert.equal(add(2, 3), 5));
