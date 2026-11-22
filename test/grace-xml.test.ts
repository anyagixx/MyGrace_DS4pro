import { describe, expect, test } from "bun:test";
import {
  INDEX_TAG_RE,
  attr,
  attrOr,
  childElement,
  childElements,
  elementAtPath,
  escapeXml,
  findElements,
  parseAttributes,
  parseIndexEntries,
  parseXml,
  serializeElement,
  textOf,
  tryParseXml,
  validateXml,
} from "../src/grace-xml";
import { XmlError } from "../src/grace-errors";

// ─── well-formedness ────────────────────────────────────────────────────

describe("validateXml()", () => {
  test("accepts well-formed XML", () => {
    expect(validateXml('<GraphIndex project="P"><M-A NAME="A" /></GraphIndex>')).toBeNull();
  });

  test("reports an unclosed tag with line and column", () => {
    const issue = validateXml("<GraphIndex>\n  <M-A NAME=\"A\">\n</GraphIndex>");
    expect(issue).not.toBeNull();
    expect(issue?.message).toContain("Expected closing tag");
    expect(issue?.line).toBeGreaterThan(0);
  });

  test("reports duplicate attributes instead of silently dropping one", () => {
    const issue = validateXml('<M-A NAME="A" NAME="B" />');
    expect(issue).not.toBeNull();
    expect(issue?.message).toContain("repeated");
  });

  test("rejects empty content and bare text", () => {
    expect(validateXml("")?.message).toBeTruthy();
    expect(validateXml("this is not xml")?.message).toBeTruthy();
  });

  test("accepts single-quoted and boolean attributes (documented dialect)", () => {
    expect(validateXml("<M-A NAME='A' done />")).toBeNull();
  });

  test("documents the current lenient multi-root behaviour (parser accepts it)", () => {
    // fast-xml-parser accepts sibling roots; parseXml then exposes the first one.
    expect(validateXml("<A /><B />")).toBeNull();
    expect(parseXml("<A /><B />").root.tag).toBe("A");
  });
});

// ─── structural parsing ─────────────────────────────────────────────────

describe("parseXml()", () => {
  const source = [
    '<?xml version="1.0"?>',
    "<!-- leading comment -->",
    '<GraphIndex project="Demo">',
    "  <M-A NAME='Authentication' STATUS=\"done\">",
    "    <purpose>Handle &quot;login&quot; &amp; sessions</purpose>",
    "  </M-A>",
    "  <M-B done />",
    "</GraphIndex>",
  ].join("\n");

  test("exposes root, attributes and every element in document order", () => {
    const document = parseXml(source, "docs/graph-index.xml");
    expect(document.path).toBe("docs/graph-index.xml");
    expect(document.root.tag).toBe("GraphIndex");
    expect(document.root.attrs).toEqual({ project: "Demo" });
    expect(document.elements.map((element) => element.tag)).toEqual([
      "GraphIndex",
      "M-A",
      "purpose",
      "M-B",
    ]);
  });

  test("skips comments and processing instructions", () => {
    const document = parseXml(source);
    expect(document.elements.some((element) => element.tag === "#comment")).toBe(false);
    expect(document.elements.some((element) => element.tag.startsWith("?"))).toBe(false);
  });

  test("decodes entities and parses single-quoted / boolean attributes", () => {
    const document = parseXml(source);
    const entry = findElements(document, (element) => element.tag === "M-A")[0];
    const purpose = findElements(document, (element) => element.tag === "purpose")[0];
    expect(entry).toBeDefined();
    expect(purpose).toBeDefined();
    expect(entry?.attrs.NAME).toBe("Authentication");
    expect(entry?.attrs.STATUS).toBe("done");
    expect(textOf(purpose!)).toBe('Handle "login" & sessions');
    const boolean = findElements(document, (element) => element.tag === "M-B")[0];
    expect(boolean?.attrs.done).toBe("true");
  });

  test("preserves mixed text children with whitespace", () => {
    const document = parseXml("<root>hello <b>world</b> tail</root>");
    expect(document.root.children).toEqual([
      "hello ",
      { tag: "b", attrs: {}, children: ["world"] },
      " tail",
    ]);
  });

  test("treats CDATA as text", () => {
    const document = parseXml("<root><![CDATA[raw <tag> & stuff]]></root>");
    expect(document.root.children).toEqual(["raw <tag> & stuff"]);
  });

  test("throws XmlError (a finding) with file/line for malformed XML", () => {
    expect(() => parseXml("<root><child></root>", "docs/modules/M-A.xml")).toThrow(XmlError);
    try {
      parseXml("<root><child></root>", "docs/modules/M-A.xml");
    } catch (error) {
      expect(error).toBeInstanceOf(XmlError);
      const xmlError = error as XmlError;
      expect(xmlError.code).toBe("XML_INVALID");
      expect(xmlError.exitCode).toBe(1);
      expect(xmlError.file).toBe("docs/modules/M-A.xml");
      expect(xmlError.line).toBeGreaterThan(0);
      expect(xmlError.toLine()).toContain("docs/modules/M-A.xml");
    }
  });

  test("throws XmlError for empty input", () => {
    expect(() => parseXml("", "empty.xml")).toThrow(XmlError);
  });
});

describe("tryParseXml()", () => {
  test("returns the document for valid XML", () => {
    const result = tryParseXml("<root><child /></root>");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.document.root.tag).toBe("root");
  });

  test("returns the issue instead of throwing for invalid XML", () => {
    const result = tryParseXml("<root>");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issue.message).toBeTruthy();
      expect(result.issue.line).toBe(1);
    }
  });
});

// ─── index entries ─────────────────────────────────────────────────────

describe("INDEX_TAG_RE", () => {
  test("accepts every documented id grammar", () => {
    for (const tag of ["M-AUTH", "M-A", "M-a1", "M-A_B-2", "V-M-AUTH", "Phase-1", "Phase-12", "Phase-1a"]) {
      expect(INDEX_TAG_RE.test(tag)).toBe(true);
    }
  });

  test("rejects non-entry tags and malformed ids", () => {
    for (const tag of ["GraphIndex", "M-", "m-auth", "Phase-", "Phase-1ab", "V-AUTH", "M-A/B"]) {
      expect(INDEX_TAG_RE.test(tag)).toBe(false);
    }
  });
});

describe("parseIndexEntries()", () => {
  const index = [
    '<GraphIndex project="P" version="1.0.0">',
    "  <!-- <M-XXX NAME=\"commented template\" /> -->",
    '  <M-AUTH NAME="Auth" TYPE="CORE_LOGIC" STATUS="done" />',
    "  <M-CART NAME=\"Cart\" TYPE=\"CORE_LOGIC\" STATUS=\"wip\">",
    "    <note>paired tag form</note>",
    "  </M-CART>",
    '  <V-M-AUTH MODULE="M-AUTH" PRIORITY="high" />',
    "  <Phase-1a name=\"Foundation\" status=\"pending\" steps=\"2\" />",
    "  <scenarios>",
    "    <M-NESTED NAME=\"nested entry\" />",
    "  </scenarios>",
    "</GraphIndex>",
  ].join("\n");

  test("parses self-closing and paired entries with attributes", () => {
    const entries = parseIndexEntries(index);
    const byTag = new Map(entries.map((entry) => [entry.tag, entry]));
    expect(byTag.get("M-AUTH")?.attrs).toEqual({
      NAME: "Auth",
      TYPE: "CORE_LOGIC",
      STATUS: "done",
    });
    expect(byTag.get("M-CART")?.attrs.STATUS).toBe("wip");
    expect(byTag.get("V-M-AUTH")?.attrs.MODULE).toBe("M-AUTH");
    expect(byTag.get("Phase-1a")?.attrs.steps).toBe("2");
  });

  test("skips commented-out template entries", () => {
    expect(parseIndexEntries(index).some((entry) => entry.tag === "M-XXX")).toBe(false);
  });

  test("parses Phase-1a as a full id, never truncating to Phase-1 (v1 regression)", () => {
    const tags = parseIndexEntries(index).map((entry) => entry.tag);
    expect(tags).toContain("Phase-1a");
    expect(tags).not.toContain("Phase-1");
  });

  test("collects nested entry-shaped tags too (documents current structural behaviour)", () => {
    const tags = parseIndexEntries(index).map((entry) => entry.tag);
    expect(tags).toContain("M-NESTED");
  });

  test("keeps attributes containing '>' and quotes intact", () => {
    const entries = parseIndexEntries('<GraphIndex><M-A NAME="A > B" DESC="say &quot;hi&quot;" /></GraphIndex>');
    expect(entries).toHaveLength(1);
    expect(entries[0]?.attrs.NAME).toBe("A > B");
    expect(entries[0]?.attrs.DESC).toBe('say "hi"');
  });

  test("reconstructs a stable raw tag for legacy call sites", () => {
    const entries = parseIndexEntries('<GraphIndex><M-A NAME="A" STATUS="done" /></GraphIndex>');
    expect(entries[0]?.raw).toBe('<M-A NAME="A" STATUS="done" />');
  });

  test("throws XmlError for malformed index XML instead of returning []", () => {
    expect(() => parseIndexEntries("<GraphIndex><M-A NAME=\"A\"</GraphIndex>", "docs/graph-index.xml")).toThrow(
      XmlError
    );
  });
});

describe("parseAttributes()", () => {
  test("parses a raw tag body", () => {
    expect(parseAttributes(' NAME="A" TYPE="CORE_LOGIC" /')).toEqual({
      NAME: "A",
      TYPE: "CORE_LOGIC",
    });
  });

  test("returns {} for an empty body", () => {
    expect(parseAttributes("   ")).toEqual({});
    expect(parseAttributes("")).toEqual({});
  });

  test("accepts single-quoted attributes", () => {
    expect(parseAttributes("NAME='A'")).toEqual({ NAME: "A" });
  });

  test("falls back to a conservative scan when the wrapper cannot be parsed", () => {
    expect(parseAttributes(' NAME="<note>" STATUS=\'ok\'')).toEqual({ NAME: "<note>", STATUS: "ok" });
  });
});

// ─── accessors ─────────────────────────────────────────────────────────

describe("XML accessors", () => {
  const document = parseXml(
    '<root><item id="1">first</item><item id="2" /><group><child>deep</child></group></root>'
  );

  test("findElements scans the flat element list", () => {
    expect(findElements(document, (element) => element.tag === "item")).toHaveLength(2);
  });

  test("childElements only returns direct children", () => {
    const item = childElement(document.root, "item");
    expect(item).toBeDefined();
    const group = childElement(document.root, "group");
    expect(childElements(group!, "item")).toEqual([]);
    expect(childElements(group!, "child").map(textOf)).toEqual(["deep"]);
  });

  test("textOf trims and joins direct text children", () => {
    const item = childElement(document.root, "item");
    expect(textOf(item!)).toBe("first");
    expect(textOf(childElements(document.root, "item")[1]!)).toBe("");
  });

  test("attr / attrOr read attributes", () => {
    const item = childElement(document.root, "item");
    expect(attr(item!, "id")).toBe("1");
    expect(attr(item!, "missing")).toBeUndefined();
    expect(attrOr(item!, "missing", "fallback")).toBe("fallback");
    expect(attrOr(item!, "id", "fallback")).toBe("1");
  });

  test("elementAtPath walks a tag path", () => {
    expect(elementAtPath(document.root, ["group", "child"])?.tag).toBe("child");
    expect(elementAtPath(document.root, ["group", "nope"])).toBeUndefined();
    expect(elementAtPath(document.root, [])?.tag).toBe("root");
  });

  test("serializeElement round-trips through the parser", () => {
    const original = parseXml('<root a="1"><item>text</item><empty /></root>');
    const serialized = serializeElement(original.root);
    expect(serialized).toBe('<root a="1"><item>text</item><empty></empty></root>');
    const reparsed = parseXml(serialized);
    expect(reparsed.elements.map((element) => element.tag)).toEqual(["root", "item", "empty"]);
    expect(reparsed.root.attrs).toEqual({ a: "1" });
  });

  test("escapeXml escapes the four XML metacharacters", () => {
    expect(escapeXml('a<b>&"c"')).toBe("a&lt;b&gt;&amp;&quot;c&quot;");
  });
});
