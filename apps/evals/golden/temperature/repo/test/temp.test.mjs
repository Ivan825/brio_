import assert from "node:assert/strict";
import { test } from "node:test";
import { fToC } from "../src/temp.mjs";

test("boiling", () => assert.equal(fToC(212), 100));
