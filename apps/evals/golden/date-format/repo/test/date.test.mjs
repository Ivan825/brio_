import assert from "node:assert/strict";
import { test } from "node:test";
import { formatDate } from "../src/date.mjs";

test("pads", () => assert.equal(formatDate(new Date(Date.UTC(2024, 0, 5))), "05/01/2024"));
