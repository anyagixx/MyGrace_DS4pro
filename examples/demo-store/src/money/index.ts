// START_MODULE_CONTRACT
//   PURPOSE: Parse and format monetary amounts as integer cents without floating-point drift.
//   SCOPE: parseAmount() and formatAmount(); validates instead of coercing; throws MoneyError.
//   DEPENDS: none
//   LINKS: docs/modules/M-MONEY.xml
// END_MODULE_CONTRACT

// START_MODULE_MAP
//   parseAmount  — decimal string -> integer cents
//   formatAmount — integer cents -> two-decimal string
//   MoneyError   — validation error for malformed amounts
// END_MODULE_MAP

// START_CHANGE_SUMMARY
//   v1.0.0 — initial deterministic implementation used by the cart module
// END_CHANGE_SUMMARY

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MoneyError";
  }
}

// START_CONTRACT: parseAmount
//   PURPOSE: Parse a decimal amount into integer cents with explicit validation.
//   INPUTS: value — string such as "12.34" or "12,34"
//   OUTPUTS: integer cents (0 is allowed)
//   ERRORS: MoneyError for empty, negative, non-numeric or over-precise input
// END_CONTRACT: parseAmount
export function parseAmount(value: string): number {
  // START_BLOCK_VALIDATE_AMOUNT
  const text = value.trim().replace(/\s+/g, "").replace(",", ".");
  if (text === "") throw new MoneyError("amount must not be empty");
  if (!/^-?\d+(?:\.\d{1,2})?$/.test(text)) throw new MoneyError(`invalid amount: ${value}`);
  if (text.startsWith("-")) throw new MoneyError("amount must not be negative");
  // END_BLOCK_VALIDATE_AMOUNT

  // START_BLOCK_CONVERT_TO_CENTS
  const [whole, fraction = ""] = text.split(".");
  return Number.parseInt(whole!, 10) * 100 + Number.parseInt(fraction.padEnd(2, "0"), 10);
  // END_BLOCK_CONVERT_TO_CENTS
}

// START_CONTRACT: formatAmount
//   PURPOSE: Render integer cents as a fixed two-decimal string.
//   INPUTS: cents — non-negative integer
//   OUTPUTS: string such as "12.34"
//   ERRORS: MoneyError for negative or non-integer cents
// END_CONTRACT: formatAmount
export function formatAmount(cents: number): string {
  // START_BLOCK_VALIDATE_CENTS
  if (!Number.isInteger(cents) || cents < 0) throw new MoneyError(`invalid cents: ${cents}`);
  // END_BLOCK_VALIDATE_CENTS
  const whole = Math.floor(cents / 100);
  const fraction = `${cents % 100}`.padStart(2, "0");
  return `${whole}.${fraction}`;
}
