import { describe, test, expect } from "bun:test";
import { createOrder } from "./index";

describe("M-ORDERS Orders", () => {
  test("createOrder runs and returns true", () => {
    expect(createOrder()).toBe(true);
  });
});
