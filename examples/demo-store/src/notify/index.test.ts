import { describe, test, expect } from "bun:test";
import { send } from "./index";

describe("M-NOTIFY Notifications", () => {
  test("send runs and returns true", () => {
    expect(send()).toBe(true);
  });
});
