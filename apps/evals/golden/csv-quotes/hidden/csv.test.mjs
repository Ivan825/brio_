import assert from "node:assert/strict";
import { test } from "node:test";
import { parseLine } from "../src/csv.mjs";

test("escaped quote", () => assert.deepEqual(parseLine('"say ""hi""",x'), ['say "hi"', "x"]));
test("empty fields", () => assert.deepEqual(parseLine("a,,b,"), ["a", "", "b", ""]));
