import { describe, test, expect } from "bun:test";
import { log } from "./index";

describe("M-LOGGER Logger", () => {
  test("log runs and returns true", () => {
    expect(log()).toBe(true);
  });
});
