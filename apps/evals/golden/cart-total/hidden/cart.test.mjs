import assert from "node:assert/strict";
import { test } from "node:test";
import { total } from "../src/cart.mjs";

test("no discount", () => assert.equal(total([{ price: 1.25, qty: 3 }]), 3.75));
test("cents", () => assert.equal(total([{ price: 9.99, qty: 3 }], 15), 25.47));
