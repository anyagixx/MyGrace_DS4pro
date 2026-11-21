import { describe, test, expect } from "bun:test";
import { handleRequest } from "./index";

describe("M-API HTTP API", () => {
  test("handleRequest runs and returns true", () => {
    expect(handleRequest()).toBe(true);
  });
});
