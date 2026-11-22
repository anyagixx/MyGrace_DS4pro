/**
 * MyGRACE — Error, exit-code and output-envelope contract.
 *
 * Motivation (ROADMAP ADR-3): before v2 every command invented its own error
 * channel and exit code, so CI and agents could not trust the result. This
 * module is the single source of truth: typed errors carry a stable `code` and
 * an exit code, findings carry a severity, and every machine-readable command
 * emits the same envelope.
 */

// START_MODULE_CONTRACT
//   PURPOSE: Single source of truth for exit codes, typed errors, findings and JSON output envelopes.
//   SCOPE: Pure formatting/printing helpers; no filesystem access.
//   DEPENDS: none (leaf module)
//   LINKS: ROADMAP.md (ADR-3, ADR-8)
// END_MODULE_CONTRACT

// START_MODULE_MAP
//   EXIT                    — exit-code constants (0 ok / 1 findings / 2 usage / 3 internal)
//   MyGraceError            — base typed error with stable code + exit code + optional hint
//   UsageError/ConfigError  — usage and configuration failures (exit 2)
//   ProjectNotFoundError    — no MyGRACE project root found (exit 2)
//   XmlError                — malformed project XML (exit 1, a finding)
//   TrustError              — a command was refused because the project is not trusted (exit 2)
//   Finding                 — one lint/test finding (severity, code, message, location, hint)
//   exitCodeForFindings()   — map findings (+ --strict) to an exit code
//   createEnvelope()        — build the stable JSON envelope
//   handleCliError()        — print one readable line (no stack) and return the exit code
//   printJson()             — deterministic JSON to stdout
// END_MODULE_MAP

export const EXIT = {
  /** Everything the command was asked to do succeeded. */
  OK: 0,
  /** The command ran but found problems (lint errors, failed tests, drift). */
  FINDINGS: 1,
  /** The command could not run: bad arguments, bad config, not a project. */
  USAGE: 2,
  /** An unexpected failure (a bug in MyGRACE or an unhandled environment error). */
  INTERNAL: 3,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];
export type Severity = "error" | "warning" | "info";

// START_BLOCK_FINDING_TYPES
export interface Finding {
  severity: Severity;
  /** Stable machine code, e.g. `ORPHANED_INDEX_ENTRY`, `STATUS_DRIFT`, `XML_INVALID`. */
  code: string;
  message: string;
  /** Project-relative file path, when the finding points at a file. */
  file?: string;
  line?: number;
  column?: number;
  /** Actionable next step shown to humans (and to agents) after the message. */
  hint?: string;
}

export interface ResultMeta {
  command?: string;
  root?: string;
  version?: string;
  durationMs?: number;
}

export interface ResultEnvelope<T = unknown> {
  ok: boolean;
  exitCode: ExitCode;
  data?: T;
  findings: Finding[];
  error?: { code: string; message: string; hint?: string };
  meta: ResultMeta;
}
// END_BLOCK_FINDING_TYPES

export interface MyGraceErrorOptions {
  exitCode?: ExitCode;
  hint?: string;
  cause?: unknown;
  line?: number;
  column?: number;
  file?: string;
}

/**
 * Base class for every error MyGRACE raises on purpose.
 *
 * `code` is a stable, documented identifier (never translated, safe to grep in
 * logs); `exitCode` is what the process must return; `hint` is the actionable
 * next step for a human or an agent.
 */
export class MyGraceError extends Error {
  readonly code: string;
  readonly exitCode: ExitCode;
  readonly hint?: string;
  readonly file?: string;
  readonly line?: number;
  readonly column?: number;

  constructor(code: string, message: string, options: MyGraceErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "MyGraceError";
    this.code = code;
    this.exitCode = options.exitCode ?? EXIT.FINDINGS;
    this.hint = options.hint;
    this.file = options.file;
    this.line = options.line;
    this.column = options.column;
  }

  /** Single-line, human-readable rendering (no stack). */
  toLine(): string {
    const location =
      this.file === undefined
        ? ""
        : ` (${this.file}${this.line === undefined ? "" : `:${this.line}`})`;
    const hint = this.hint === undefined ? "" : `\n  → ${this.hint}`;
    return `${this.code}: ${this.message}${location}${hint}`;
  }
}

/** Bad arguments or an impossible request (exit 2). */
export class UsageError extends MyGraceError {
  constructor(message: string, options: MyGraceErrorOptions = {}) {
    super("USAGE", message, { exitCode: EXIT.USAGE, ...options });
    this.name = "UsageError";
  }
}

/** Invalid or unusable project configuration (exit 2). */
export class ConfigError extends MyGraceError {
  constructor(message: string, options: MyGraceErrorOptions = {}) {
    super("CONFIG_INVALID", message, { exitCode: EXIT.USAGE, ...options });
    this.name = "ConfigError";
  }
}

/** No docs/graph-index.xml anywhere above the working directory (exit 2). */
export class ProjectNotFoundError extends MyGraceError {
  constructor(startDir: string) {
    super("PROJECT_NOT_FOUND", "MyGRACE project not found. Run in a project with docs/graph-index.xml", {
      exitCode: EXIT.USAGE,
      hint: `Searched "${startDir}" and every parent directory. Run \`mygrace init-dsh\` in the project root, or pass --path <project-root>.`,
    });
    this.name = "ProjectNotFoundError";
  }
}

/** Malformed project XML — a finding, not a crash (exit 1). */
export class XmlError extends MyGraceError {
  constructor(file: string, detail: string, options: MyGraceErrorOptions = {}) {
    super("XML_INVALID", `Invalid XML: ${detail}`, {
      exitCode: EXIT.FINDINGS,
      file,
      hint: "Fix the XML (every tag must be closed, attributes quoted and unique) and re-run.",
      ...options,
    });
    this.name = "XmlError";
  }
}

/**
 * A project command was refused because the project has no valid trust record.
 * Repo data is attacker-controlled in a clone, so commands are opt-in (ADR-1).
 */
export class TrustError extends MyGraceError {
  constructor(projectRoot: string, command: string, options: MyGraceErrorOptions = {}) {
    super(
      "UNTRUSTED_PROJECT",
      `Refusing to execute project command "${command}": this project has no valid trust record.`,
      {
        exitCode: EXIT.USAGE,
        hint:
          `Review the commands in docs/modules/*.xml, then run \`mygrace trust --path ${projectRoot}\` ` +
          `(or pass --allow-commands for a one-off run in CI).`,
        ...options,
      }
    );
    this.name = "TrustError";
  }
}

/** Build a finding with a stable code; keeps call sites short and consistent. */
export function finding(
  severity: Severity,
  code: string,
  message: string,
  extra: Omit<Finding, "severity" | "code" | "message"> = {}
): Finding {
  return { severity, code, message, ...extra };
}

/**
 * Map findings to an exit code.
 * `strict` promotes warnings to failures (the CI gate).
 */
export function exitCodeForFindings(findings: readonly Finding[], strict = false): ExitCode {
  if (findings.some((f) => f.severity === "error")) return EXIT.FINDINGS;
  if (strict && findings.some((f) => f.severity === "warning")) return EXIT.FINDINGS;
  return EXIT.OK;
}

// START_BLOCK_ENVELOPE
/** Build the stable JSON envelope every `--format json` command prints. */
export function createEnvelope<T>(input: {
  data?: T;
  findings?: Finding[];
  error?: MyGraceError | { code: string; message: string; hint?: string };
  meta?: ResultMeta;
  strict?: boolean;
}): ResultEnvelope<T> {
  const findings = input.findings ?? [];
  let error: ResultEnvelope["error"];
  let exitCode: ExitCode;

  if (input.error !== undefined) {
    error = {
      code: input.error.code,
      message: input.error.message,
      ...(input.error.hint === undefined ? {} : { hint: input.error.hint }),
    };
    exitCode = input.error instanceof MyGraceError ? input.error.exitCode : EXIT.INTERNAL;
  } else {
    exitCode = exitCodeForFindings(findings, input.strict === true);
  }

  const envelope: ResultEnvelope<T> = {
    ok: exitCode === EXIT.OK,
    exitCode,
    findings,
    meta: input.meta ?? {},
  };
  if (input.data !== undefined) envelope.data = input.data;
  if (error !== undefined) envelope.error = error;
  return envelope;
}

/** Print deterministic JSON (2-space indent, trailing newline) to stdout. */
export function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}
// END_BLOCK_ENVELOPE

/** Narrowing helper for call sites that must not re-wrap errors. */
export function isMyGraceError(error: unknown): error is MyGraceError {
  return error instanceof MyGraceError;
}

/**
 * Print a readable error to stderr and return the process exit code.
 *
 * Deliberately never prints a stack trace unless MYGRACE_DEBUG is set: agents
 * pay for every token, and a stack trace is not actionable for them.
 */
export function handleCliError(error: unknown): ExitCode {
  if (isMyGraceError(error)) {
    process.stderr.write(`mygrace: ${error.toLine()}\n`);
    return error.exitCode;
  }

  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`mygrace: INTERNAL: ${message}\n`);
  process.stderr.write("  → Re-run with MYGRACE_DEBUG=1 for a stack trace; please report this with the command you used.\n");
  if (process.env.MYGRACE_DEBUG === "1" && error instanceof Error && error.stack !== undefined) {
    process.stderr.write(`${error.stack}\n`);
  }
  return EXIT.INTERNAL;
}

/** Wrap a command handler so thrown typed errors become one readable line + exit code. */
export function withErrorBoundary<Args extends unknown[]>(
  handler: (...args: Args) => unknown | Promise<unknown>
): (...args: Args) => Promise<void> {
  return async (...args: Args): Promise<void> => {
    try {
      await handler(...args);
    } catch (error) {
      process.exit(handleCliError(error));
    }
  };
}
