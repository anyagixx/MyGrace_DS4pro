import { describe, test, expect } from "bun:test";
import { addItem } from "./index";

describe("M-CART Cart", () => {
  test("addItem runs and returns true", () => {
    expect(addItem()).toBe(true);
  });
});
