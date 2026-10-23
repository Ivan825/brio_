import assert from "node:assert/strict";
import { test } from "node:test";
import { slugify } from "../src/slugify.mjs";

test("words", () => assert.equal(slugify("Hello World"), "hello-world"));
test("spaces", () => assert.equal(slugify("  A  B "), "a-b"));
