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
    const report = analyzeText("WIFI:T:WPA;S:Cafe\\;Guest;P:swordfish;H:true;;");
    expect(report.kind).toBe("wifi");
    expect(report.actionPolicy).toBe("inspect-only");
    expect(field(report, "ssid").value).toBe("Cafe;Guest");
    expect(field(report, "password")).toMatchObject({
      value: "swordfish",
      sensitive: true,
      masked: true,
    });
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
  });

  it("renders bounded vCard fields but omits active resource properties", () => {
    const report = analyzeText(
      [
        "BEGIN:VCARD",
        "VERSION:4.0",
        "FN:Alice\\, Example",
        "EMAIL:alice@example.test",
        "URL:https://example.test/profile",
        "PHOTO:https://example.test/photo.jpg",
        "END:VCARD",
      ].join("\r\n"),
    );
    expect(report.kind).toBe("contact");
    expect(report.displayFields.map((item) => item.value)).toEqual([
      "Alice, Example",
      "alice@example.test",
    ]);
  });

  it("recognizes MECARD and calendar without exposing attachments", () => {
    expect(analyzeText("MECARD:N:Alice;TEL:+15551234;;").kind).toBe("contact");
    const calendar = analyzeText(
      [
        "BEGIN:VCALENDAR",
        "BEGIN:VEVENT",
        "SUMMARY:Meeting",
        "LOCATION:Room 1",
        "ATTACH:https://example.test/file",
        "END:VEVENT",
        "END:VCALENDAR",
      ].join("\n"),
    );
    expect(calendar.kind).toBe("calendar");
    expect(calendar.displayFields.map((item) => item.value)).toEqual(["Meeting", "Room 1"]);
  });

  it.each([
    ["mailto:alice@example.test?body=hidden", "email"],
    ["sms:+15551234?body=hidden", "sms"],
    ["tel:+15551234", "telephone"],
    ["geo:37.7,-122.4?q=hidden", "geo"],
    ["bitcoin:bc1qexample?amount=1", "payment"],
    ["ftp://example.test/file", "custom-uri"],
  ])("keeps %s inert as %s", (text, kind) => {
    const report = analyzeText(text);
    expect(report.kind).toBe(kind);
    expect(report.actionPolicy).toBe("inspect-only");
    expect(report.canonicalHref).toBeUndefined();
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
