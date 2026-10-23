import assert from "node:assert/strict";
import { test } from "node:test";
import { titleCase } from "../src/title.mjs";

test("words", () => assert.equal(titleCase("hello world"), "Hello World"));
test("lowercases the rest", () => assert.equal(titleCase("hELLO wORLD"), "Hello World"));
test("keeps spacing", () => assert.equal(titleCase("a  b"), "A  B"));
