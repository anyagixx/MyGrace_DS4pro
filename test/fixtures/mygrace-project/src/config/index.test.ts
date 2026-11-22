import { expect, test } from "bun:test";

import { loadConfig } from "./index";

test("loadConfig returns a validated configuration", () => {
  const config = loadConfig();
  expect(typeof config.env).toBe("string");
  expect(config.env.length).toBeGreaterThan(0);
  expect(Number.isInteger(config.port)).toBe(true);
  expect(config.port).toBeGreaterThan(0);
});
