import { describe, expect, test } from "bun:test";

import { authenticate } from "./index";

describe("authenticate", () => {
  test("returns a session for valid credentials", () => {
    const session = authenticate({ login: "alice", password: "secret" });
    expect(session.login).toBe("alice");
    expect(typeof session.id).toBe("string");
    expect(session.id.length).toBeGreaterThan(0);
    expect(session.createdAt instanceof Date).toBe(true);
  });

  test("throws AUTH_FAILED when credentials are incomplete", () => {
    expect(() => authenticate({ login: "", password: "secret" })).toThrow("AUTH_FAILED");
    expect(() => authenticate({ login: "alice", password: "" })).toThrow("AUTH_FAILED");
  });
});
