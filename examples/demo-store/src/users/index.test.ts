import { describe, test, expect } from "bun:test";
import { getUser } from "./index";

describe("M-USERS Users", () => {
  test("getUser runs and returns true", () => {
    expect(getUser()).toBe(true);
  });
});
