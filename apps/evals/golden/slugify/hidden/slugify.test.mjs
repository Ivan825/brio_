import assert from "node:assert/strict";
import { test } from "node:test";
import { slugify } from "../src/slugify.mjs";

test("punctuation", () => assert.equal(slugify("C'est la vie!"), "cest-la-vie"));
test("dashes", () => assert.equal(slugify("a -- b"), "a-b"));
test("digits", () => assert.equal(slugify("Top 10 Tips"), "top-10-tips"));
