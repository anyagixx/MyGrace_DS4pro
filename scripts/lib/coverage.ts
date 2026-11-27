/** Side-effect-free coverage-summary parser (imported by the gate and its test). */
export interface CoverageSummary {
  functions: number;
  lines: number;
}

/** Parse the `All files | funcs% | lines%` row from Bun's coverage table. */
export function parseCoverageSummary(report: string): CoverageSummary | null {
  const match = /^All files\s*\|\s*([0-9.]+)\s*\|\s*([0-9.]+)\s*\|/m.exec(report);
  if (match === null) return null;
  return { functions: Number(match[1]), lines: Number(match[2]) };
}
