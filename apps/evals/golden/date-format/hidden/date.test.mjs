import assert from "node:assert/strict";
import { test } from "node:test";
import { formatDate } from "../src/date.mjs";

test("year end", () => assert.equal(formatDate(new Date(Date.UTC(2023, 11, 31))), "31/12/2023"));
test("utc", () => assert.equal(formatDate(new Date("2024-03-10T23:30:00Z")), "10/03/2024"));
