import { describe, test, expect } from "bun:test";
import { runCommand } from "./index";

describe("M-CLI CLI", () => {
  test("runCommand runs and returns true", () => {
    expect(runCommand()).toBe(true);
  });
});
