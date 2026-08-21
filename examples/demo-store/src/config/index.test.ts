import { describe, test, expect } from "bun:test";
import { loadConfig } from "./index";

describe("M-CONFIG Config", () => {
  test("loadConfig runs and returns true", () => {
    expect(loadConfig()).toBe(true);
  });
});
