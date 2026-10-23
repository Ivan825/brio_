import assert from "node:assert/strict";
import { test } from "node:test";
import { cToF, fToC } from "../src/temp.mjs";

test("minus forty", () => assert.equal(fToC(-40), -40));
test("round trip", () => assert.equal(Math.round(fToC(cToF(37)) * 1000) / 1000, 37));
