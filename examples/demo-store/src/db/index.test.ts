import { describe, test, expect } from "bun:test";
import { query } from "./index";

describe("M-DB Database", () => {
  test("query runs and returns true", () => {
    expect(query()).toBe(true);
  });
});
