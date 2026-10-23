import assert from "node:assert/strict";
import { test } from "node:test";
import { total } from "../src/cart.mjs";

test("discount once", () => assert.equal(total([{ price: 10, qty: 2 }], 10), 18));
