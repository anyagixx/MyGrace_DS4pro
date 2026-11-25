/**
 * Doc/code truth helpers shared by `scripts/validate-marketplace.ts` and
 * `scripts/validate-docs.ts`.
 *
 * The single source of truth for the documented CLI surface is the citty
 * command tree exported from `src/grace.ts`; MCP tool names come from the
 * catalog-derived `TOOL_NAMES` in `src/grace-mcp-commands.ts`. Documentation is
 * scanned as text and every `mygrace ...` invocation / flag reference is
 * resolved against that live surface, so docs cannot drift silently.
 */

import type { ArgsDef, CommandDef } from "citty";
import { main } from "../../src/grace";

export interface CommandInfo {
  /** Command path, e.g. ["module", "show"]; [] for the root command. */
  path: string[];
  /** Resolved citty command definition. */
  command: CommandDef<ArgsDef>;
  /** Flags accepted by this command, normalised to kebab-case (plus camelCase aliases). */
  flags: Set<string>;
  /** Positional argument names. */
  positionals: Set<string>;
  /** Flags accepted by this command and all of its descendants. */
  allFlags: Set<string>;
  /** True when the command only groups subcommands (has no run handler). */
  group: boolean;
}

export interface CommandTree {
  /** Every command path keyed by space-joined path ("module show"). */
  commands: Map<string, CommandInfo>;
  /** First path segment → command info. */
  roots: Map<string, CommandInfo>;
}

export interface CommandRef {
  file: string;
  line: number;
  /** Resolved command path tokens as written (e.g. ["module", "show"]). */
  commandPath: string[];
  /** Flags written in the same command segment (e.g. ["path", "with-verification"]). */
  flags: string[];
  /** Original line, trimmed, for human-readable reports. */
  source: string;
}

const BUN_GLOBAL_FLAGS = ["help", "version"];

/** camelCase → kebab-case (`withVerification` → `with-verification`). */
export function kebabCase(name: string): string {
  return name.replace(/[A-Z]/g, (character) => `-${character.toLowerCase()}`);
}

/** kebab-case → camelCase (`with-verification` → `withVerification`). */
export function camelCase(name: string): string {
  return name.replace(/-([a-z0-9])/g, (_match, character: string) => character.toUpperCase());
}

/**
 * Resolve a command's `args` definition.
 *
 * citty types `args` as `Resolvable<ArgsDef>` (it may be lazy). MyGRACE command
 * definitions are always plain objects; a lazy definition would hide flags from
 * doc validation, so it is treated as empty here and callers fail loudly via
 * `describeCommand` (documented behaviour, no silent guessing).
 */
function commandArgs(command: CommandDef<ArgsDef>): ArgsDef {
  const args = command.args as unknown;
  if (args === undefined || typeof args === "function" || args instanceof Promise) return {};
  return args as ArgsDef;
}

function describeCommand(command: CommandDef<ArgsDef>, path: string[]): CommandInfo {
  const flags = new Set<string>(BUN_GLOBAL_FLAGS);
  const positionals = new Set<string>();
  for (const [key, definition] of Object.entries(commandArgs(command))) {
    const type = (definition as { type?: string }).type;
    if (type === "positional") {
      positionals.add(key);
      continue;
    }
    flags.add(key);
    flags.add(kebabCase(key));
  }
  const subCommands = command.subCommands;
  return {
    path,
    command,
    flags,
    positionals,
    allFlags: new Set(flags),
    group: subCommands !== undefined && (command.run === undefined || typeof command.run !== "function"),
  };
}

/**
 * Import the CLI command tree. Importing `src/grace.ts` is side-effect free
 * (it only calls `runMain` when executed directly), so scripts and tests can
 * introspect the real command surface instead of maintaining a stale allowlist.
 */
export function loadCommandTree(): CommandTree {
  const commands = new Map<string, CommandInfo>();
  const roots = new Map<string, CommandInfo>();

  const visit = (command: CommandDef<ArgsDef>, path: string[]): CommandInfo => {
    const info = describeCommand(command, path);
    if (path.length === 0) {
      // The root command itself is not a documented invocation target.
    } else {
      commands.set(path.join(" "), info);
    }
    const subCommands = command.subCommands;
    if (subCommands !== undefined && typeof subCommands === "object" && !(subCommands instanceof Promise)) {
      for (const [name, subCommand] of Object.entries(subCommands)) {
        if (typeof subCommand === "function" || subCommand instanceof Promise) {
          throw new Error(
            `Command "${[...path, name].join(" ")}" is a lazy subcommand; doc validation needs plain command definitions.`
          );
        }
        const child = visit(subCommand as CommandDef<ArgsDef>, [...path, name]);
        for (const flag of child.allFlags) info.allFlags.add(flag);
      }
    }
    if (path.length === 1) roots.set(path[0]!, info);
    return info;
  };

  visit(main as CommandDef<ArgsDef>, []);
  return { commands, roots };
}

/** Resolve the documented command path against the tree; undefined when unknown. */
export function resolveCommand(tree: CommandTree, commandPath: readonly string[]): CommandInfo | undefined {
  if (commandPath.length === 0) return undefined;
  const full = commandPath.join(" ");
  const exact = tree.commands.get(full);
  if (exact !== undefined) return exact;

  const root = tree.roots.get(commandPath[0]!);
  if (root === undefined) return undefined;
  if (commandPath.length === 1) return root;

  const twoTokens = tree.commands.get(commandPath.slice(0, 2).join(" "));
  if (twoTokens !== undefined) return twoTokens;

  // `mygrace context packet M-XXX` / `mygrace find auth`: the extra token is a positional
  // of a leaf command, not a subcommand.
  if (!root.group) return root;
  return undefined;
}

/** True when the flag is declared by the command (kebab or camel form). */
export function commandAcceptsFlag(command: CommandInfo, flag: string): boolean {
  return command.flags.has(flag) || command.flags.has(kebabCase(flag)) || command.flags.has(camelCase(flag));
}

// START_BLOCK_EXTRACT
const INTERRUPT = /[`|;"'()\[\]<>]/;

/**
 * Extract every `mygrace <command> ... <flags>` reference from markdown-ish text.
 *
 * Handles inline code, fenced blocks, prose and table cells. Stops a command
 * segment at markdown/code delimiters so a line documenting several commands
 * yields one ref per mention. Tokens after the command are only treated as a
 * subcommand when they look like one (`[a-z][a-z0-9-]*`), which keeps
 * positionals such as `M-AUTH` or `<id>` out of the path.
 */
export function extractCommandRefs(content: string, file = "<memory>"): CommandRef[] {
  const refs: CommandRef[] = [];
  const lines = content.split("\n");

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const mentions = /\bmygrace\b/g;
    let mention: RegExpExecArray | null;
    while ((mention = mentions.exec(line)) !== null) {
      const start = mention.index;
      const previous = start === 0 ? " " : line[start - 1]!;
      // Skip package names and file names: mygrace-cli, mygrace.config.json, mygrace-http...
      if (/[@A-Za-z0-9_\-./]/.test(previous)) continue;
      const after = line.slice(start + "mygrace".length);
      if (/^[-_.]/.test(after)) continue;

      const end = after.search(INTERRUPT);
      const segment = (end === -1 ? after : after.slice(0, end)).trim();
      if (segment === "") continue;

      const tokens = segment.split(/\s+/).filter(Boolean);
      const commandPath: string[] = [];
      for (const token of tokens) {
        if (commandPath.length === 0) {
          if (/^[a-z][a-z0-9-]*$/.test(token)) commandPath.push(token);
          else break;
          continue;
        }
        if (/^[a-z][a-z0-9-]*$/.test(token) && !token.startsWith("-")) {
          commandPath.push(token);
          break; // at most command + one subcommand is documented in this dialect
        }
        break;
      }
      if (commandPath.length === 0) continue;

      const flags: string[] = [];
      for (const match of segment.matchAll(/--([a-z][a-z0-9-]*)/g)) flags.push(match[1]!);

      refs.push({ file, line: index + 1, commandPath, flags, source: line.trim() });
    }
  }

  return refs;
}
// END_BLOCK_EXTRACT

/** Derive documented skill names from `skills/mygrace/*` directory names. */
export function skillNameFromDir(dirName: string): string {
  return dirName.startsWith("grace-") ? `mygrace-${dirName.slice("grace-".length)}` : dirName;
}
