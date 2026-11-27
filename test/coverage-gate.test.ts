/** Coverage gate parser: keeps the hard threshold reliable in CI. */
import { describe, expect, test } from "bun:test";
import { parseCoverageSummary } from "../scripts/lib/coverage";

describe("parseCoverageSummary", () => {
  test("parses Bun's All files row", () => {
    expect(parseCoverageSummary("All files | 92.76 | 87.39 |\n")).toEqual({ functions: 92.76, lines: 87.39 });
    expect(parseCoverageSummary("no table here")).toBeNull();
  });
});
