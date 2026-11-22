/**
 * MyGRACE — Strict XML layer for project artifacts (ROADMAP ADR-2).
 *
 * Docs XML is a serialization format written by humans and agents, so it must
 * be parsed structurally: malformed input is reported with a line/column, not
 * silently skipped by a regex. Every consumer (lint, module, phase, MCP, ...)
 * goes through this module so behaviour cannot drift between commands.
 */

// START_MODULE_CONTRACT
//   PURPOSE: Parse and validate MyGRACE project XML with a real parser; expose small, typed accessors.
//   SCOPE: XML only (no filesystem); callers read files and pass content.
//   DEPENDS: fast-xml-parser
//   LINKS: ROADMAP.md (ADR-2)
// END_MODULE_CONTRACT

// START_MODULE_MAP
//   XmlElement/XmlChild   — typed element tree (tag, attributes, children, text)
//   XmlDocument           — parsed document + flat element list
//   validateXml()         — well-formedness check returning a line/column issue or null
//   parseXml()            — validate + parse, throws XmlError on malformed input
//   tryParseXml()         — non-throwing variant for lint-style callers
//   parseIndexEntries()   — index entries (M-*, V-M-*, Phase-N) with attributes
//   parseAttributes()     — legacy helper: attributes from a raw tag body
//   findElements()/childElements()/textOf()/attr() — accessors used by commands
// END_MODULE_MAP

import { XMLParser, XMLValidator } from "fast-xml-parser";
import { XmlError } from "./grace-errors";

export interface XmlAttrs {
  [name: string]: string;
}

export interface XmlElement {
  tag: string;
  attrs: XmlAttrs;
  children: XmlChild[];
}

/** Element or non-whitespace text node. */
export type XmlChild = XmlElement | string;

export interface XmlDocument {
  /** Source path (or "<memory>") used in error messages. */
  path: string;
  root: XmlElement;
  /** Every element in document order (root included) — cheap navigation for lint. */
  elements: XmlElement[];
}

export interface XmlIssue {
  message: string;
  line?: number;
  column?: number;
}

type RawNode = Record<string, unknown>;

const PARSER_OPTIONS = {
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  preserveOrder: true,
  commentPropName: "#comment",
  allowBooleanAttributes: true,
  parseAttributeValue: false,
  parseTagValue: false,
  trimValues: false,
  processEntities: true,
  ignoreDeclaration: true,
  ignorePiTags: true,
} as const;

const parser = new XMLParser(PARSER_OPTIONS);

/** True for tags that are index entries: M-XXX, V-M-XXX, Phase-N. */
export const INDEX_TAG_RE = /^(?:M-[A-Za-z0-9][A-Za-z0-9_-]*|V-M-[A-Za-z0-9][A-Za-z0-9_-]*|Phase-[0-9]+[A-Za-z]?)$/;

/** Check well-formedness. Returns `null` when valid, otherwise the first issue. */
export function validateXml(content: string): XmlIssue | null {
  const result = XMLValidator.validate(content, { allowBooleanAttributes: true });
  if (result === true) return null;
  return {
    message: result.err.msg,
    ...(typeof result.err.line === "number" ? { line: result.err.line } : {}),
    ...(typeof result.err.col === "number" ? { column: result.err.col } : {}),
  };
}

/** Validate + parse. Throws `XmlError` (a finding, exit 1) on malformed input. */
export function parseXml(content: string, filePath = "<memory>"): XmlDocument {
  const issue = validateXml(content);
  if (issue !== null) {
    throw new XmlError(filePath, issue.message, {
      ...(issue.line === undefined ? {} : { line: issue.line }),
      ...(issue.column === undefined ? {} : { column: issue.column }),
    });
  }

  const raw = parser.parse(content) as RawNode[];
  const children = convertNodes(raw);
  const root = children.find((child): child is XmlElement => typeof child !== "string");
  if (root === undefined) throw new XmlError(filePath, "document has no root element");

  const elements: XmlElement[] = [];
  collectElements(root, elements);
  return { path: filePath, root, elements };
}

/** Non-throwing variant for callers (lint) that report parse problems as findings. */
export function tryParseXml(
  content: string,
  filePath = "<memory>"
): { ok: true; document: XmlDocument } | { ok: false; issue: XmlIssue } {
  const issue = validateXml(content);
  if (issue !== null) return { ok: false, issue };
  return { ok: true, document: parseXml(content, filePath) };
}

function convertNodes(nodes: readonly RawNode[]): XmlChild[] {
  const output: XmlChild[] = [];
  for (const node of nodes) {
    const keys = Object.keys(node).filter((key) => key !== ":@");
    if (keys.length === 0) continue;
    const key = keys[0];
    if (key === undefined) continue;

    if (key === "#text") {
      const text = String(node[key] ?? "");
      if (text.trim() !== "") output.push(text);
      continue;
    }
    // Comments, processing instructions and CDATA wrappers are not elements.
    if (key.startsWith("#") || key.startsWith("?")) continue;

    const attrsRaw = (node[":@"] ?? {}) as Record<string, unknown>;
    const attrs: XmlAttrs = {};
    for (const [name, value] of Object.entries(attrsRaw)) {
      attrs[name.replace(/^@_/, "")] = String(value);
    }

    const rawChildren = node[key];
    const children = Array.isArray(rawChildren) ? convertNodes(rawChildren as RawNode[]) : [];
    output.push({ tag: key, attrs, children });
  }
  return output;
}

function collectElements(element: XmlElement, output: XmlElement[]): void {
  output.push(element);
  for (const child of element.children) {
    if (typeof child !== "string") collectElements(child, output);
  }
}

// START_BLOCK_INDEX_ENTRIES
export interface IndexEntry {
  tag: string;
  attrs: Record<string, string>;
  /** Reconstructed raw tag, kept for backwards compatibility with v1 call sites. */
  raw: string;
}

/**
 * Parse index entries from an index document.
 *
 * v1 used a regex that silently mangled edge cases (truncated `Phase-1a`,
 * attributes containing `>`); this implementation parses structurally and lets
 * malformed XML surface as an `XmlError`.
 */
export function parseIndexEntries(content: string, filePath = "<memory>"): IndexEntry[] {
  return indexEntriesFromDocument(parseXml(content, filePath));
}

/** Extract index entries from an already-parsed document (avoids double parsing). */
export function indexEntriesFromDocument(document: XmlDocument): IndexEntry[] {
  const entries: IndexEntry[] = [];
  for (const element of document.elements) {
    if (!INDEX_TAG_RE.test(element.tag)) continue;
    entries.push({
      tag: element.tag,
      attrs: { ...element.attrs },
      raw: renderTag(element),
    });
  }
  return entries;
}

function renderTag(element: XmlElement): string {
  const attrs = Object.entries(element.attrs)
    .map(([name, value]) => `${name}="${value}"`)
    .join(" ");
  return attrs === "" ? `<${element.tag} />` : `<${element.tag} ${attrs} />`;
}

/**
 * Legacy helper (v1 API): attributes from a raw tag body such as
 * ` NAME="A" TYPE="B"`. Kept for call sites that carry snippets, implemented by
 * wrapping the body in a synthetic element so quoting rules stay identical to
 * the main parser.
 */
export function parseAttributes(tagBody: string): XmlAttrs {
  const body = tagBody.trim().replace(/\/$/, "");
  if (body === "") return {};
  try {
    const document = parseXml(`<mygrace-probe ${body} />`, "<attributes>");
    return { ...document.root.attrs };
  } catch {
    // Attributes may contain characters that are legal in our XML dialect but
    // not in a synthetic wrapper; fall back to a conservative scan.
    const attrs: XmlAttrs = {};
    const regex = /([A-Za-z_][\w.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(body)) !== null) {
      attrs[match[1] as string] = (match[2] ?? match[3] ?? "") as string;
    }
    return attrs;
  }
}
// END_BLOCK_INDEX_ENTRIES

// START_BLOCK_ACCESSORS
/** Elements from the document matching a predicate. */
export function findElements(
  document: XmlDocument,
  predicate: (element: XmlElement) => boolean
): XmlElement[] {
  return document.elements.filter(predicate);
}

/** Direct child elements, optionally filtered by tag. */
export function childElements(element: XmlElement, tag?: string): XmlElement[] {
  return element.children.filter(
    (child): child is XmlElement => typeof child !== "string" && (tag === undefined || child.tag === tag)
  );
}

/** First direct child with the given tag. */
export function childElement(element: XmlElement, tag: string): XmlElement | undefined {
  return childElements(element, tag)[0];
}

/** Concatenated text content of an element (direct text children only). */
export function textOf(element: XmlElement): string {
  return element.children
    .filter((child): child is string => typeof child === "string")
    .join("")
    .trim();
}

/** Attribute value or undefined. */
export function attr(element: XmlElement, name: string): string | undefined {
  const value = element.attrs[name];
  return value === undefined ? undefined : value;
}

/** Attribute value with a default. */
export function attrOr(element: XmlElement, name: string, fallback: string): string {
  return element.attrs[name] ?? fallback;
}

/** Descendant by tag path, e.g. `["contract", "purpose"]`. */
export function elementAtPath(element: XmlElement, path: readonly string[]): XmlElement | undefined {
  let current: XmlElement | undefined = element;
  for (const tag of path) {
    if (current === undefined) return undefined;
    current = childElement(current, tag);
  }
  return current;
}

/** Serialize an element back to XML (attributes quoted, children recursive). */
export function serializeElement(element: XmlElement): string {
  const attrs = Object.entries(element.attrs)
    .map(([name, value]) => `${name}="${escapeXml(value)}"`)
    .join(" ");
  const open = attrs === "" ? `<${element.tag}>` : `<${element.tag} ${attrs}>`;
  if (element.children.length === 0) return `${open}</${element.tag}>`;
  const inner = element.children
    .map((child) => (typeof child === "string" ? escapeXml(child) : serializeElement(child)))
    .join("");
  return `${open}${inner}</${element.tag}>`;
}

export function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
// END_BLOCK_ACCESSORS
