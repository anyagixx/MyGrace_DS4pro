import { describe, test, expect } from "bun:test";
import { listProducts } from "./index";

describe("M-PRODUCTS Products", () => {
  test("listProducts runs and returns true", () => {
    expect(listProducts()).toBe(true);
  });
});
