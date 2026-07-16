import { describe, expect, it } from "vitest";
import corpus from "./analyzer.url-corpus.json";
import {
  ANALYZER_LIMITS,
  analyzeDecodeResult,
  analyzeText,
  type AnalysisReport,
  type AnalyzerInput,
} from "../../src/analyzer";

interface CorpusFixture {
  readonly id: string;
  readonly original: string;
  readonly parseOutcome: boolean;
  readonly canonicalHref?: string;
  readonly kind: string;
  readonly displayFields: Readonly<Record<string, string>>;
  readonly signals: readonly string[];
  readonly actionPolicy: string;
}

function fieldMap(report: AnalysisReport): Readonly<Record<string, string>> {
  return Object.fromEntries(report.displayFields.map((field) => [field.id, field.value]));
}

function field(report: AnalysisReport, id: string) {
  const found = report.displayFields.find((candidate) => candidate.id === id);
  expect(found, `missing field ${id}`).toBeDefined();
  return found!;
}

describe("normative URL corpus", () => {
  for (const fixture of corpus as readonly CorpusFixture[]) {
    it(fixture.id, () => {
      const report = analyzeText(fixture.original);
      expect(report.kind).toBe(fixture.kind);
      expect(report.canonicalHref !== undefined).toBe(fixture.parseOutcome);
      expect(report.canonicalHref).toBe(fixture.canonicalHref);
      expect(report.signals.map((item) => item.code)).toEqual(fixture.signals);
      expect(report.actionPolicy).toBe(fixture.actionPolicy);

      const actualFields = fieldMap(report);
      for (const [id, value] of Object.entries(fixture.displayFields)) {
        expect(actualFields[id], `${fixture.id}: ${id}`).toBe(value);
      }
    });
  }

  it("uses the exact credentials explanation and actual host", () => {
    const report = analyzeText("https://accounts.google.com@evil.example/login");
    expect(report.signals.find((item) => item.code === "userinfo")?.detail).toBe(
      "Text before @ is not the destination. The actual host is evil.example.",
    );
  });

  it("counts all query entries but renders only the first 64 names", () => {
    const query = Array.from({ length: 70 }, (_, index) => `name${index}=hidden`).join("&");
    const report = analyzeText(`https://example.com/?${query}`);
    const names = field(report, "query-names");
    expect(names.count).toBe(70);
    expect(names.omittedCount).toBe(6);
    expect(names.value).toContain("name0");
    expect(names.value).toContain("name63");
    expect(names.value).not.toContain("name64");
    expect(names.value).not.toContain("hidden");
  });

  it("keeps query and fragment summaries to names while collapsing the original", () => {
    const report = analyzeText(
      "https://example.com/?access_token=do-not-display#secret=also-hidden",
    );
    expect(field(report, "query-names").value).toBe("access_token");
    expect(field(report, "fragment-names").value).toBe("secret");
    expect(field(report, "query-names").value).not.toContain("do-not-display");
    expect(field(report, "fragment-names").value).not.toContain("also-hidden");
    expect(field(report, "original").collapsed).toBe(true);
  });
});

describe("ordered payload classification", () => {
  it("keeps Wi-Fi credentials inert and masked", () => {
    const source = "WIFI:T:WPA;S:Cafe\\;Guest;P:swordfish;H:true;;";
    const report = analyzeText(source);
    expect(report.kind).toBe("wifi");
    expect(report.actionPolicy).toBe("inspect-only");
    expect(field(report, "ssid").value).toBe("Cafe;Guest");
    expect(field(report, "password")).toMatchObject({
      value: "swordfish",
      sensitive: true,
      masked: true,
    });
    expect(field(report, "original")).toMatchObject({
      actionValue: source,
      sensitive: true,
      masked: true,
      collapsed: true,
    });
    expect(report.displayFields.at(-1)?.id).toBe("original");
  });

  it.each([
    ["otpauth://totp/Example:alice?secret=ABC", "otp", "otp-payload"],
    ["otpauth-migration://offline?data=ABC", "otp", "otp-payload"],
    ["DPP:K:secret-bootstrap;M:001122334455;;", "dpp", "dpp-payload"],
  ])("classifies %s as sensitive inspect-only content", (text, kind, fieldId) => {
    const report = analyzeText(text);
    expect(report.kind).toBe(kind);
    expect(report.actionPolicy).toBe("inspect-only");
    expect(field(report, fieldId)).toMatchObject({ sensitive: true, masked: true });
    expect(report.displayFields.filter((item) => item.actionValue === text)).toHaveLength(1);
    expect(report.displayFields.some((item) => item.id === "original")).toBe(false);
  });

  it("renders bounded vCard highlights and retains omitted resource properties inertly", () => {
    const source = [
      "BEGIN:VCARD",
      "VERSION:4.0",
      "FN:Alice\\, Example",
      "EMAIL:alice@example.test",
      "URL:https://example.test/profile",
      "PHOTO:https://example.test/photo.jpg",
      "END:VCARD",
    ].join("\r\n");
    const report = analyzeText(source);
    expect(report.kind).toBe("contact");
    expect(report.displayFields.slice(0, -1).map((item) => item.value)).toEqual([
      "Alice, Example",
      "alice@example.test",
    ]);
    expect(field(report, "original")).toMatchObject({
      actionValue: source,
      sensitive: true,
      masked: true,
      collapsed: true,
    });
  });

  it("recognizes MECARD and retains calendar attachments only in the masked source", () => {
    expect(analyzeText("MECARD:N:Alice;TEL:+15551234;;").kind).toBe("contact");
    const source = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "SUMMARY:Meeting",
      "LOCATION:Room 1",
      "ATTACH:https://example.test/file",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\n");
    const calendar = analyzeText(source);
    expect(calendar.kind).toBe("calendar");
    expect(calendar.displayFields.slice(0, -1).map((item) => item.value)).toEqual([
      "Meeting",
      "Room 1",
    ]);
    expect(field(calendar, "original").actionValue).toBe(source);
  });

  it.each([
    [
      "mailto:alice@example.test?subject=Hello%20there&body=hidden",
      "email",
      "alice@example.test",
    ],
    ["sms:+15551234?body=hidden", "sms", "+15551234"],
    ["tel:+15551234", "telephone"],
    ["geo:37.7,-122.4?q=Coffee%20Shop", "geo", "37.7,-122.4"],
    [
      "bitcoin:bc1qexample?amount=1.25&label=Alice&message=Lunch",
      "payment",
      "bitcoin",
    ],
    ["ftp://example.test/file?token=hidden", "custom-uri", "ftp"],
  ])("keeps %s exactly inspectable and inert as %s", (text, kind, highlight) => {
    const report = analyzeText(text);
    expect(report.kind).toBe(kind);
    expect(report.actionPolicy).toBe("inspect-only");
    expect(report.canonicalHref).toBeUndefined();
    if (highlight !== undefined) {
      expect(report.displayFields.some((item) => item.value === highlight)).toBe(true);
    }
    expect(field(report, "original")).toMatchObject({
      actionValue: text,
      sensitive: true,
      masked: true,
      collapsed: true,
    });
    expect(report.displayFields.at(-1)?.id).toBe("original");
  });

  it("escapes and bounds a custom URI display without changing its exact source", () => {
    const source = `example:before\u202Eafter${"😀".repeat(
      ANALYZER_LIMITS.fieldScalars + 5,
    )}`;
    const report = analyzeText(source);
    const original = field(report, "original");

    expect(report.kind).toBe("custom-uri");
    expect(original.actionValue).toBe(source);
    expect(original.value).toContain("[U+202E]");
    expect(Array.from(original.value)).toHaveLength(ANALYZER_LIMITS.fieldScalars);
    expect(original.truncated).toBe(true);
  });

  it("reserves exact structured source before report-scalar highlight budgeting", () => {
    const source = [
      "BEGIN:VCARD",
      `FN:${"a".repeat(ANALYZER_LIMITS.fieldScalars)}`,
      `ORG:${"b".repeat(ANALYZER_LIMITS.fieldScalars)}`,
      `TITLE:${"c".repeat(ANALYZER_LIMITS.fieldScalars)}`,
      `NOTE:${"d".repeat(ANALYZER_LIMITS.fieldScalars)}`,
      "END:VCARD",
    ].join("\n");
    const report = analyzeText(source);

    expect(report.kind).toBe("contact");
    expect(field(report, "original").actionValue).toBe(source);
    expect(report.displayFields.at(-1)?.id).toBe("original");
    expect(report.displayFields.map((item) => item.id)).toEqual([
      "fn-0",
      "org-1",
      "title-2",
      "original",
    ]);
  });

  it("classifies empty payload separately from whitespace text", () => {
    expect(analyzeText("").kind).toBe("empty");
    expect(analyzeText(" ").kind).toBe("text");
  });

  it("makes malformed or over-limit structured payloads decline completely", () => {
    const malformedWifi = analyzeText("WIFI:T:WPA;P:no-ssid;;");
    expect(malformedWifi.kind).toBe("text");
    expect(field(malformedWifi, "text")).toMatchObject({
      sensitive: true,
      masked: true,
      collapsed: true,
    });
    const tooMany = `WIFI:S:network;${Array.from(
      { length: ANALYZER_LIMITS.logicalFields + 1 },
      (_, index) => `X${index}:x;`,
    ).join("")};`;
    expect(field(analyzeText(tooMany), "text")).toMatchObject({
      sensitive: true,
      masked: true,
      collapsed: true,
    });
    const danglingEscape = "WIFI:S:network;P:supersecret\\";
    const declined = analyzeText(danglingEscape);
    expect(declined.actionPolicy).toBe("inspect-only");
    expect(field(declined, "text")).toMatchObject({
      actionValue: danglingEscape,
      sensitive: true,
      masked: true,
      collapsed: true,
    });
  });

  it.each(["WIFI:S:", "otpauth:", "otpauth-migration:", "DPP:"])(
    "keeps an over-limit %s payload masked when structured parsing declines it",
    (prefix) => {
      const report = analyzeText(`${prefix}${"x".repeat(ANALYZER_LIMITS.fieldScalars + 1)}`);

      expect(report.kind).toBe("text");
      expect(report.actionPolicy).toBe("inspect-only");
      expect(field(report, "text")).toMatchObject({
        sensitive: true,
        masked: true,
        collapsed: true,
      });
    },
  );
});

describe("decoder trust boundary and report bounds", () => {
  it("does not make GS1 or ISO 15434 text URL-eligible", () => {
    const gs1 = analyzeText("https://example.com", "GS1");
    const iso = analyzeText("https://example.com", "ISO15434");
    expect(gs1).toMatchObject({ kind: "gs1", actionPolicy: "inspect-only" });
    expect(iso).toMatchObject({ kind: "iso-15434", actionPolicy: "inspect-only" });
    expect(gs1.canonicalHref).toBeUndefined();
    expect(iso.canonicalHref).toBeUndefined();
  });

  it("renders only byte count and the first 256 bytes for binary input", () => {
    const bytes = "ab".repeat(300);
    const input: AnalyzerInput = {
      rawBytes: { byteLength: 300, hex: bytes },
      contentType: "Binary",
      decoding: { kind: "binary", reason: "invalid-utf8", eci: null },
    };
    const report = analyzeDecodeResult(input);
    expect(report.kind).toBe("binary");
    expect(field(report, "byte-count").value).toBe("300");
    expect(field(report, "hex-preview").value).toBe(
      `${"ab".repeat(256)}… (300 bytes total)`,
    );
  });

  it("fails closed on an invalid FrozenBytes invariant", () => {
    const report = analyzeDecodeResult({
      rawBytes: { byteLength: 2, hex: "abc" },
      contentType: "Binary",
      decoding: { kind: "binary", reason: "invalid-utf8", eci: null },
    });
    expect(field(report, "byte-count").value).toBe("Unavailable");
    expect(report.actionPolicy).toBe("inspect-only");
  });

  it("bounds fields by Unicode scalar values, not UTF-16 code units", () => {
    const report = analyzeText("😀".repeat(ANALYZER_LIMITS.fieldScalars + 5));
    const text = field(report, "text");
    expect(Array.from(text.value)).toHaveLength(ANALYZER_LIMITS.fieldScalars);
    expect(text.truncated).toBe(true);
  });

  it("keeps the exact action value separate from escaped and truncated display text", () => {
    const source = `before\u202Eafter${"😀".repeat(ANALYZER_LIMITS.fieldScalars + 5)}`;
    const text = field(analyzeText(source), "text");

    expect(text.actionValue).toBe(source);
    expect(text.value).not.toBe(source);
    expect(text.value).toContain("[U+202E]");
    expect(Array.from(text.value)).toHaveLength(ANALYZER_LIMITS.fieldScalars);
    expect(text.truncated).toBe(true);
  });

  it("deep-freezes the complete report graph", () => {
    const report = analyzeText("https://example.com");
    expect(Object.isFrozen(report)).toBe(true);
    expect(Object.isFrozen(report.displayFields)).toBe(true);
    expect(Object.isFrozen(report.displayFields[0])).toBe(true);
    expect(Object.isFrozen(report.signals)).toBe(true);
    expect(Object.isFrozen(report.limitations)).toBe(true);
  });

  it("contains capabilities and observations but no verdict fields", () => {
    const report = analyzeText("https://example.com");
    expect(Object.keys(report)).toEqual([
      "schemaVersion",
      "analyzerVersion",
      "kind",
      "canonicalHref",
      "displayFields",
      "signals",
      "limitations",
      "actionPolicy",
    ]);
    for (const prohibited of ["verdict", "score", "confidence"]) {
      expect(prohibited in report).toBe(false);
    }
  });
});
