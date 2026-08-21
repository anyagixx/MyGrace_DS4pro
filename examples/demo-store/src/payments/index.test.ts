import { describe, test, expect } from "bun:test";
import { charge } from "./index";

describe("M-PAYMENTS Payments", () => {
  test("charge runs and returns true", () => {
    expect(charge()).toBe(true);
  });
});
