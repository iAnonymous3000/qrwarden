import { describe, expect, it } from "vitest";
import corpus from "./analyzer.url-corpus.json";
import {
  ANALYZER_LIMITS,
  analyzeDecodeResult,
  analyzeText,
  type AnalysisReport,
  type AnalyzerInput,
} from "../../src/analyzer";
import { ReportFields } from "../../src/analyzer/limits";

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

  it.each([
    ["https://router/", "Dotless hostname"],
    ["https://service.onion/", "IANA special-use onion"],
    ["https://resolver.arpa/", "IANA special-use resolver.arpa"],
  ] as const)("requires review for special hostname %s", (url, category) => {
    const report = analyzeText(url);
    expect(field(report, "destination-category").value).toBe(category);
    expect(report.signals.map((item) => item.code)).toContain(
      "local-or-special-destination",
    );
    expect(report.actionPolicy).toBe("confirm-web");
  });

  it("does not mistake a globally reachable IPv6 address for a dotless hostname", () => {
    const report = analyzeText("https://[2606:4700:4700::1111]/");
    expect(report.signals.map((item) => item.code)).toEqual(["ip-address"]);
    expect(
      report.displayFields.some((item) => item.id === "destination-category"),
    ).toBe(false);
  });

  it("surfaces a non-global IPv4 destination embedded in the NAT64 prefix", () => {
    const report = analyzeText("https://[64:ff9b::a9fe:a9fe]/");
    expect(field(report, "destination-category").value).toBe(
      "NAT64: Link Local",
    );
    expect(report.signals.map((item) => item.code)).toContain(
      "local-or-special-destination",
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
    expect(field(report, "query-names").reportValue).toBe("Count: 1");
    expect(field(report, "fragment-names").reportValue).toBe("Count: 1");
    expect(field(report, "query-names").value).not.toContain("do-not-display");
    expect(field(report, "fragment-names").value).not.toContain("also-hidden");
    expect(field(report, "original").collapsed).toBe(true);
  });

  it.each([
    ["https://openai.com/?", "Present (empty)", "Not present"],
    ["https://openai.com/#", "None", "Present (empty)"],
    ["https://openai.com/?#", "Present (empty)", "Present (empty)"],
  ] as const)(
    "preserves empty query and fragment delimiters in %s",
    (url, query, fragment) => {
      const report = analyzeText(url);
      expect(report.canonicalHref).toBe(url);
      expect(field(report, "query-names").value).toBe(query);
      expect(field(report, "query-names").reportValue).toBe(query);
      expect(field(report, "fragment").value).toBe(fragment);
    },
  );
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
    expect(field(report, "hidden")).toMatchObject({
      value: "Yes",
      reportPolicy: "safe",
    });
    expect(field(report, "original")).toMatchObject({
      actionValue: source,
      sensitive: true,
      masked: true,
      collapsed: true,
    });
    expect(report.displayFields.at(-1)?.id).toBe("original");
  });

  it("uses Wi-Fi escaping without inventing line breaks", () => {
    const unknownEscape = analyzeText(String.raw`WIFI:S:Cafe\north;T:WPA;P:pw;;`);
    expect(field(unknownEscape, "ssid").value).toBe(String.raw`Cafe\north`);

    const documentedEscapes = analyzeText(
      String.raw`WIFI:S:\"Cafe\;Guest\,A\:B\\C\";T:WPA;P:pw;;`,
    );
    expect(field(documentedEscapes, "ssid").value).toBe('"Cafe;Guest,A:B\\C"');

    const actualLineFeed = analyzeText("WIFI:S:Cafe\nNorth;T:WPA;P:pw;;");
    expect(field(actualLineFeed, "ssid").value).toBe("Cafe[U+000A]North");
  });

  it.each([
    "WIFI:S:;;",
    "WIFI:T:WPA;S:;P:pw;;",
  ])("rejects an empty SSID in %s", (text) => {
    const report = analyzeText(text);
    expect(report.kind).toBe("text");
    expect(field(report, "text")).toMatchObject({ sensitive: true, masked: true });
  });

  it("preserves a whitespace-only SSID as exact data", () => {
    const report = analyzeText("WIFI:S: ;T:nopass;;");
    expect(report.kind).toBe("wifi");
    expect(field(report, "ssid").value).toBe(" ");
  });

  it("distinguishes hidden state from legacy and explicit phase-2 methods", () => {
    const hidden = analyzeText("WIFI:S:Cafe;T:WPA;H:FALSE;;");
    expect(field(hidden, "hidden").value).toBe("No");

    const legacy = analyzeText("WIFI:S:Corp;T:WPA2-EAP;H:MSCHAPV2;;");
    expect(field(legacy, "phase2-method")).toMatchObject({
      label: "Declared phase 2 method (legacy H, not validated)",
      value: "MSCHAPV2",
    });
    expect(legacy.displayFields.some((item) => item.id === "hidden")).toBe(false);

    const explicit = analyzeText(
      "WIFI:S:Corp;T:WPA2-EAP;PH2:MSCHAPV2;H:true;;",
    );
    expect(field(explicit, "phase2-method")).toMatchObject({
      label: "Declared phase 2 method (not validated)",
      value: "MSCHAPV2",
    });
    expect(field(explicit, "hidden").value).toBe("Yes");
  });

  it("surfaces bounded enterprise fields while masking identities and passwords", () => {
    const report = analyzeText(
      "WIFI:S:Corp;T:WPA2-EAP;E:TTLS;PH2:MSCHAPV2;A:anonymous;I:alice;P:secret;;",
    );
    expect(report.kind).toBe("wifi");
    expect(field(report, "eap-method").value).toBe("TTLS");
    expect(field(report, "phase2-method").value).toBe("MSCHAPV2");
    expect(field(report, "anonymous-identity")).toMatchObject({
      value: "anonymous",
      sensitive: true,
      masked: true,
    });
    expect(field(report, "identity")).toMatchObject({
      value: "alice",
      sensitive: true,
      masked: true,
    });
    expect(field(report, "password")).toMatchObject({
      value: "secret",
      sensitive: true,
      masked: true,
    });
  });

  it.each([
    "WIFI:S:Corp;T:WPA;E:TTLS;;",
    "WIFI:S:Corp;T:WPA2-EAP;PH2:MSCHAPV2;H:legacy;;",
    "WIFI:S:Corp;T:WPA2-EAP;E:TTLS;E:TLS;;",
    "WIFI:S:Corp;T:WPA2-EAP;A:first;A:second;;",
    "WIFI:S:Corp;T:WPA2-EAP;I:first;I:second;;",
    "WIFI:S:Corp;T:WPA2-EAP;PH2:first;PH2:second;;",
  ])("rejects ambiguous or duplicated enterprise Wi-Fi data in %s", (text) => {
    const report = analyzeText(text);
    expect(report.kind).toBe("text");
    expect(field(report, "text")).toMatchObject({ sensitive: true, masked: true });
  });

  it.each([
    "WIFI:T:nopass;S:Cafe;P:not-applicable;;",
    "WIFI:S:Cafe;P:not-applicable;;",
    "WIFI:T:;S:Cafe;P:not-applicable;;",
  ])("declines password data whose security declaration ignores it in %s", (source) => {
    const report = analyzeText(source);
    expect(report.kind).toBe("text");
    expect(field(report, "text")).toMatchObject({
      actionValue: source,
      sensitive: true,
      masked: true,
    });
  });

  it.each([
    [
      "otpauth://totp/Example:alice?secret=JBSWY3DPEHPK3PXP",
      "otp",
      "otp-payload",
    ],
    [
      "otpauth://hotp/Example:alice?secret=JBSWY3DPEHPK3PXP&counter=0",
      "otp",
      "otp-payload",
    ],
    [
      "DPP:K:0123456789abcdef;M:001122334455;;",
      "dpp",
      "dpp-payload",
    ],
  ])("classifies %s as sensitive inspect-only content", (text, kind, fieldId) => {
    const report = analyzeText(text);
    expect(report.kind).toBe(kind);
    expect(report.actionPolicy).toBe("inspect-only");
    expect(field(report, fieldId)).toMatchObject({ sensitive: true, masked: true });
    expect(report.displayFields.filter((item) => item.actionValue === text)).toHaveLength(1);
    expect(report.displayFields.some((item) => item.id === "original")).toBe(false);
  });

  it.each([
    "otpauth:",
    "otpauth://steam/Alice?secret=JBSWY3DPEHPK3PXP",
    "otpauth://totp/?secret=JBSWY3DPEHPK3PXP",
    "otpauth://totp/Alice",
    "otpauth://totp/Alice?secret=NOT-BASE32",
    "otpauth://totp/Alice?secret=ABC",
    "otpauth://totp/Alice?secret=ABC&secret=DEF",
    "otpauth://hotp/Alice?secret=JBSWY3DPEHPK3PXP",
    "otpauth://hotp/Alice?secret=JBSWY3DPEHPK3PXP&counter=18446744073709551616",
    "otpauth://totp/Alice?secret=JBSWY3DPEHPK3PXP&counter=1",
    "otpauth://totp/Alice?secret=JBSWY3DPEHPK3PXP#fragment",
    "otpauth-migration://offline?data=ABC",
  ])("masks unvalidated OTP-shaped input %s", (text) => {
    const report = analyzeText(text);
    expect(report.kind).toBe("text");
    expect(field(report, "text")).toMatchObject({
      actionValue: text,
      sensitive: true,
      masked: true,
    });
  });

  it.each([
    "DPP:",
    "DPP:garbage;;",
    "DPP:K:short;;",
    "DPP:K:0123456789abcdef;K:fedcba9876543210;;",
    "DPP:K:0123456789abcdef",
    "DPP:K:0123456789abcdef;C:channel;;",
    "DPP:K:0123456789abcdef;M:not-a-mac;;",
  ])("masks DPP-shaped input without a minimally valid envelope: %s", (text) => {
    const report = analyzeText(text);
    expect(report.kind).toBe("text");
    expect(field(report, "text")).toMatchObject({
      actionValue: text,
      sensitive: true,
      masked: true,
    });
  });

  it("labels DPP validation limits explicitly", () => {
    const report = analyzeText("DPP:C:81/1;K:0123456789abcdef;;");
    expect(report.kind).toBe("dpp");
    expect(field(report, "dpp-type").value).toBe(
      "DPP bootstrap data (public key not validated)",
    );
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
    expect(report.displayFields.slice(0, -1).map((item) => item.value)).toEqual(
      ["vCard contact", "Alice, Example", "alice@example.test"],
    );
    expect(field(report, "summary")).toMatchObject({ count: 5, omittedCount: 3 });
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
    expect(calendar.displayFields.slice(0, -1).map((item) => item.value)).toEqual(
      ["Calendar entry", "Meeting", "Room 1"],
    );
    expect(field(calendar, "summary")).toMatchObject({ count: 3, omittedCount: 1 });
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
    ["geo:37.7,-122.4", "geo", "37.7,-122.4"],
    [
      "bitcoin:bc1qexample?amount=1.25&label=Alice&message=Lunch",
      "payment",
      "bitcoin",
    ],
    ["ftp://example.test/file?token=hidden", "custom-uri", "ftp"],
  ])("keeps %s exactly inspectable and inert as %s", (text, kind, highlight?: string) => {
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

  it.each([
    ["bitcoin:", "payment", "URI scheme only (no payload)"],
    [
      "bitcoin:garbage",
      "payment",
      "Payment-related URI (payload not validated)",
    ],
    ["foo:", "custom-uri", "URI scheme only (no payload)"],
    [
      "javascript:alert(1)",
      "custom-uri",
      "URI scheme recognized; payload not validated",
    ],
  ] as const)("uses a neutral classification for %s", (text, kind, summary) => {
    const report = analyzeText(text);
    expect(report.kind).toBe(kind);
    expect(report.actionPolicy).toBe("inspect-only");
    expect(field(report, "summary").value).toBe(summary);
    expect(report.canonicalHref).toBeUndefined();
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
      "VERSION:4.0",
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
      "summary",
      "fn-0",
      "org-1",
      "title-2",
      "original",
    ]);
    expect(field(report, "summary")).toMatchObject({ count: 5, omittedCount: 2 });
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

  it.each([
    "sms:%?body=topsecret",
    "tel:%",
    "mailto:%",
    "geo:%",
    "MECARD:N;",
    "BEGIN:VCARD\nTEL:+15551234567",
    "BEGIN:VEVENT\nSUMMARY:Meeting\nEND:VTODO",
  ])("masks %s when a sensitive-prefix parse declines it", (text) => {
    const report = analyzeText(text);
    expect(report.kind).toBe("text");
    expect(report.actionPolicy).toBe("inspect-only");
    expect(field(report, "text")).toMatchObject({
      actionValue: text,
      sensitive: true,
      masked: true,
      collapsed: true,
    });
  });

  it("keeps ordinary text near a sensitive prefix unmasked", () => {
    const report = analyzeText("smsomething entirely ordinary");
    expect(report.kind).toBe("text");
    expect(field(report, "text")).toMatchObject({ sensitive: false, masked: false });
  });

  it("splits vCard lines at the first colon outside double quotes", () => {
    const report = analyzeText(
      [
        "BEGIN:VCARD",
        "VERSION:4.0",
        'TEL;X-LBL="ext:12":+15551234567',
        "FN:Alice",
        "END:VCARD",
      ].join("\r\n"),
    );
    expect(report.kind).toBe("contact");
    expect(field(report, "tel-0").value).toBe("+15551234567");
  });

  it("strips an RFC 6350 group prefix before the property lookup", () => {
    const report = analyzeText(
      [
        "BEGIN:VCARD",
        "VERSION:4.0",
        "item1.EMAIL:alice@example.test",
        "FN:Alice",
        "END:VCARD",
      ].join("\r\n"),
    );
    expect(report.kind).toBe("contact");
    expect(field(report, "email-0").value).toBe("alice@example.test");
  });

  it("decodes quoted-printable vCard values and keeps invalid escapes literal", () => {
    const decoded = analyzeText(
      [
        "BEGIN:VCARD",
        "VERSION:4.0",
        "N;ENCODING=QUOTED-PRINTABLE:=4A=6f=68=6E",
        "FN:Alice",
        "END:VCARD",
      ].join("\r\n"),
    );
    expect(field(decoded, "n-0").value).toBe("John");
    const literal = analyzeText(
      [
        "BEGIN:VCARD",
        "VERSION:4.0",
        "N;ENCODING=QUOTED-PRINTABLE:=ZZok",
        "FN:Alice",
        "END:VCARD",
      ].join("\r\n"),
    );
    expect(field(literal, "n-0").value).toBe("=ZZok");
  });

  it("accepts the standard terminal CRLF and declines extra trailing newlines", () => {
    const compliant = analyzeText(
      `${["BEGIN:VCARD", "VERSION:4.0", "FN:Alice", "END:VCARD"].join("\r\n")}\r\n`,
    );
    expect(compliant.kind).toBe("contact");
    expect(field(compliant, "fn-0").value).toBe("Alice");

    const doubled = analyzeText(
      `${["BEGIN:VCARD", "VERSION:4.0", "FN:Alice", "END:VCARD"].join("\r\n")}\r\n\r\n`,
    );
    expect(doubled.kind).toBe("text");
    expect(field(doubled, "text")).toMatchObject({
      sensitive: true,
      masked: true,
      collapsed: true,
    });
  });

  it("declines quoted-printable values with legacy charsets or soft line breaks", () => {
    const utf8 = analyzeText(
      [
        "BEGIN:VCARD",
        "VERSION:4.0",
        "FN;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:Ren=C3=A9",
        "END:VCARD",
      ].join("\r\n"),
    );
    expect(field(utf8, "fn-0").value).toBe("René");

    const legacyCharset = analyzeText(
      [
        "BEGIN:VCARD",
        "VERSION:4.0",
        "FN;CHARSET=ISO-8859-1;ENCODING=QUOTED-PRINTABLE:Ren=E9",
        "END:VCARD",
      ].join("\r\n"),
    );
    expect(legacyCharset.kind).toBe("text");
    expect(field(legacyCharset, "text")).toMatchObject({
      sensitive: true,
      masked: true,
      collapsed: true,
    });

    // A trailing "=" continues on the next physical line, which unfolding
    // already split off; a spec-compliant importer would join them, so the
    // summary must decline rather than show different fields.
    const softBreak = analyzeText(
      [
        "BEGIN:VCARD",
        "VERSION:4.0",
        "NOTE;ENCODING=QUOTED-PRINTABLE:ignore this=",
        "TEL:+19005550100",
        "FN:Alice",
        "END:VCARD",
      ].join("\r\n"),
    );
    expect(softBreak.kind).toBe("text");
    expect(field(softBreak, "text")).toMatchObject({
      sensitive: true,
      masked: true,
      collapsed: true,
    });
  });

  it("decodes percent-encoded mailto header field names", () => {
    const encoded = analyzeText(
      "mailto:alice@example.test?%62%63%63=carol@example.test&%62%6f%64%79=hidden",
    );
    expect(encoded.kind).toBe("email");
    expect(field(encoded, "bcc").value).toBe("carol@example.test");
    expect(field(encoded, "body").value).toBe("hidden");

    const encodedTo = analyzeText("mailto:?%74%6f=evil@example.test");
    expect(field(encodedTo, "recipient").value).toBe("evil@example.test");

    // A mixed-encoding duplicate is still a duplicate, and an undecodable
    // field name declines rather than hide a header from the summary.
    expect(analyzeText("mailto:a@example.test?bcc=x&%62%63%63=y").kind).toBe("text");
    expect(analyzeText("mailto:a@example.test?b%ZZcc=x").kind).toBe("text");
  });

  it("shows the complete RFC 5724 destination including phone-context", () => {
    const context = analyzeText("sms:7042;phone-context=example.com?body=hi");
    expect(context.kind).toBe("sms");
    expect(field(context, "recipient").value).toBe("7042;phone-context=example.com");

    const multi = analyzeText("sms:7042;phone-context=+1,+15559876543");
    expect(field(multi, "recipient").value).toBe(
      "7042;phone-context=+1,+15559876543",
    );

    const none = analyzeText("sms:?body=hi");
    expect(none.kind).toBe("text");
    expect(field(none, "text")).toMatchObject({ sensitive: true, masked: true });
  });

  it("shows prefilled message and mail bodies as inspectable fields", () => {
    const sms = analyzeText("sms:+15551234?body=Meet%20at%20noon");
    expect(sms.kind).toBe("sms");
    expect(field(sms, "body")).toMatchObject({
      value: "Meet at noon",
      collapsed: true,
      reportPolicy: "hidden",
    });
    const mail = analyzeText(
      "mailto:alice@example.test?subject=Hello%20there&body=See%20attached",
    );
    expect(mail.kind).toBe("email");
    expect(field(mail, "subject").value).toBe("Hello there");
    expect(field(mail, "body")).toMatchObject({
      value: "See attached",
      collapsed: true,
      reportPolicy: "hidden",
    });
  });

  it("surfaces the SMSTO colon-form prefilled message", () => {
    const sms = analyzeText("SMSTO:+15551234:Meet at noon");
    expect(sms.kind).toBe("sms");
    expect(field(sms, "recipient").value).toBe("+15551234");
    expect(field(sms, "body")).toMatchObject({
      value: "Meet at noon",
      collapsed: true,
      reportPolicy: "hidden",
    });
  });

  it("shows mailto to, cc, and bcc addresses instead of an empty recipient", () => {
    const mail = analyzeText(
      "mailto:?to=alice@example.test&cc=bob@example.test&bcc=carol@example.test",
    );
    expect(mail.kind).toBe("email");
    expect(field(mail, "recipient").value).toBe("alice@example.test");
    expect(field(mail, "cc")).toMatchObject({
      value: "bob@example.test",
      reportPolicy: "hidden",
    });
    expect(field(mail, "bcc")).toMatchObject({
      value: "carol@example.test",
      reportPolicy: "hidden",
    });

    const combined = analyzeText("mailto:alice@example.test?to=bob@example.test");
    expect(field(combined, "recipient").value).toBe(
      "alice@example.test, bob@example.test",
    );

    const none = analyzeText("mailto:?subject=Hi");
    expect(none.kind).toBe("email");
    expect(none.displayFields.some((item) => item.id === "recipient")).toBe(false);
  });

  it("declines to summarize a duplicated parameter rather than show one value", () => {
    const report = analyzeText("sms:+15551234?body=innocuous&body=hostile");
    expect(report.kind).toBe("text");
    expect(report.actionPolicy).toBe("inspect-only");
    expect(field(report, "text")).toMatchObject({
      actionValue: "sms:+15551234?body=innocuous&body=hostile",
      sensitive: true,
      masked: true,
      collapsed: true,
    });
  });

  it.each([
    "sms:+15551234?body=innocuous&body",
    "otpauth://totp/Alice?secret=JBSWY3DPEHPK3PXP&secret",
  ])("declines a key-only duplicate parameter in %s", (source) => {
    const report = analyzeText(source);
    expect(report.kind).toBe("text");
    expect(field(report, "text")).toMatchObject({
      actionValue: source,
      sensitive: true,
      masked: true,
    });
  });

  it("does not apply the SMSTO colon-body convention to RFC sms URIs", () => {
    const source = "sms:+15551234:prefilled";
    const report = analyzeText(source);
    expect(report.kind).toBe("text");
    expect(field(report, "text").actionValue).toBe(source);
  });

  it.each([
    "tel:",
    "tel:not-a-number",
    "tel:1234",
    "tel:+A1",
    "tel:+15551234;ext=ABC",
    "tel:+15551234%3Bext=123",
    "sms:+15551234%2C+15559876",
    "geo:",
    "geo:91,0",
    "geo:0,181",
    "geo:+1,2",
    "geo:.5,2",
    "geo:1.,2",
    "geo:1%2C2",
    "geo:1,2;u=not-a-number",
    "geo:1,2;u=1;u=2",
    "geo:1,2;foo;u=1",
    "geo:37.7,-122.4?q=Coffee%20Shop",
    "geo:garbage",
  ])(
    "declines a minimally invalid telephone or geo payload: %s",
    (source) => {
      const report = analyzeText(source);
      expect(report.kind).toBe("text");
      expect(field(report, "text").actionValue).toBe(source);
    },
  );

  it.each([
    "tel:+15551234;ext=123;foo",
    "geo:1,2;foo",
    "geo:1,2;crs=wgs84;u=3.5;foo",
  ])("accepts a bounded valid URI parameter form: %s", (source) => {
    expect(analyzeText(source).kind).not.toBe("text");
  });

  it("preserves literal question marks in a legacy SMSTO colon-form body", () => {
    const report = analyzeText("SMSTO:+15551234:Are you free?");
    expect(report.kind).toBe("sms");
    expect(field(report, "recipient").value).toBe("+15551234");
    expect(field(report, "body").value).toBe("Are you free?");
  });

  it("declines duplicated Wi-Fi fields rather than show one value", () => {
    const report = analyzeText("WIFI:T:WPA;S:LegitCafe;P:realpass;S:EvilAP;;");
    expect(report.kind).toBe("text");
    expect(report.actionPolicy).toBe("inspect-only");
    expect(field(report, "text")).toMatchObject({
      actionValue: "WIFI:T:WPA;S:LegitCafe;P:realpass;S:EvilAP;;",
      sensitive: true,
      masked: true,
      collapsed: true,
    });
    expect(analyzeText("WIFI:T:WPA;S:Cafe;P:shown;P:hidden;;").kind).toBe("text");
    expect(analyzeText("WIFI:S:Cafe;T:WPA;T:nopass;P:pw;;").kind).toBe("text");
    expect(analyzeText("WIFI:T:WPA;S:Cafe;P:pw;H:false;H:true;;").kind).toBe("text");
  });

  it("escapes Unicode line separators in structured field values", () => {
    const report = analyzeText("WIFI:T:WPA;S:Cafe\u2028Status: safe;P:pw;;");
    expect(report.kind).toBe("wifi");
    expect(field(report, "ssid").value).toBe("Cafe[U+2028]Status: safe");
  });

  it("declines calendar content outside the closed root object", () => {
    const trailingProperty = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "SUMMARY:Team lunch",
      "END:VEVENT",
      "END:VCALENDAR",
      "SUMMARY:Spoofed trailing event",
    ].join("\n");
    expect(analyzeText(trailingProperty).kind).toBe("text");

    const secondObject = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "SUMMARY:Team lunch",
      "END:VEVENT",
      "END:VCALENDAR",
      "BEGIN:VEVENT",
      "SUMMARY:Spoofed second object",
      "END:VEVENT",
    ].join("\n");
    expect(analyzeText(secondObject).kind).toBe("text");

    const terminalNewline = analyzeText(
      `${["BEGIN:VEVENT", "SUMMARY:Meeting", "END:VEVENT"].join("\r\n")}\r\n`,
    );
    expect(terminalNewline.kind).toBe("calendar");
  });

  it.each([
    [
      "back-to-back cards",
      [
        "BEGIN:VCARD",
        "VERSION:4.0",
        "FN:Alice",
        "END:VCARD",
        "BEGIN:VCARD",
        "VERSION:4.0",
        "FN:Bob",
        "END:VCARD",
      ].join("\n"),
    ],
    [
      "nested cards",
      [
        "BEGIN:VCARD",
        "VERSION:4.0",
        "FN:Alice",
        "BEGIN:VCARD",
        "VERSION:4.0",
        "FN:Bob",
        "END:VCARD",
        "END:VCARD",
      ].join("\n"),
    ],
  ])("rejects %s instead of merging contacts", (_name, text) => {
    const report = analyzeText(text);
    expect(report.kind).toBe("text");
    expect(field(report, "text")).toMatchObject({
      actionValue: text,
      sensitive: true,
      masked: true,
    });
  });

  it("accepts parameterized vCard 4 VERSION and multiple formatted names", () => {
    const report = analyzeText(
      [
        "BEGIN:VCARD",
        "VERSION;VALUE=text:4.0",
        "FN;LANGUAGE=en:Alice",
        "FN;LANGUAGE=fr:Alicia",
        "END:VCARD",
      ].join("\r\n"),
    );
    expect(report.kind).toBe("contact");
    expect(field(report, "fn-0").value).toBe("Alice");
    expect(field(report, "fn-1").value).toBe("Alicia");
  });

  it("accepts a bounded vCard value folded across more than four physical lines", () => {
    const report = analyzeText(
      [
        "BEGIN:VCARD",
        "VERSION:4.0",
        "FN:A",
        " l",
        " i",
        " c",
        " e",
        " !",
        "END:VCARD",
      ].join("\r\n"),
    );
    expect(report.kind).toBe("contact");
    expect(field(report, "fn-0").value).toBe("Alice!");
  });

  it.each([
    ["missing VERSION", ["BEGIN:VCARD", "FN:Alice", "END:VCARD"]],
    ["missing FN", ["BEGIN:VCARD", "VERSION:4.0", "N:Example;Alice", "END:VCARD"]],
    [
      "duplicate VERSION",
      ["BEGIN:VCARD", "VERSION:4.0", "VERSION:4.0", "FN:Alice", "END:VCARD"],
    ],
    ["late vCard 4 VERSION", ["BEGIN:VCARD", "FN:Alice", "VERSION:4.0", "END:VCARD"]],
    [
      "conflicting VERSION value parameter",
      ["BEGIN:VCARD", "VERSION;VALUE=uri:4.0", "FN:Alice", "END:VCARD"],
    ],
    [
      "vCard 3 without N",
      ["BEGIN:VCARD", "VERSION:3.0", "FN:Alice", "END:VCARD"],
    ],
    [
      "duplicate N",
      [
        "BEGIN:VCARD",
        "VERSION:4.0",
        "FN:Alice",
        "N:Example;Alice;;;",
        "N:Example;Alicia;;;",
        "END:VCARD",
      ],
    ],
  ])("declines a vCard with %s", (_name, lines) => {
    const report = analyzeText(lines.join("\r\n"));
    expect(report.kind).toBe("text");
    expect(field(report, "text")).toMatchObject({ sensitive: true, masked: true });
  });

  it("rejects multiple VEVENT components instead of merging events", () => {
    const text = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "SUMMARY:First",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "SUMMARY:Second",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\n");
    const report = analyzeText(text);
    expect(report.kind).toBe("text");
    expect(field(report, "text")).toMatchObject({ sensitive: true, masked: true });
  });

  it("isolates VALARM and VTODO properties from the reviewed event", () => {
    const text = [
      "BEGIN:VCALENDAR",
      "BEGIN:VTODO",
      "SUMMARY:Task title",
      "END:VTODO",
      "BEGIN:VEVENT",
      "SUMMARY:Event title",
      "BEGIN:VALARM",
      "ACTION:DISPLAY",
      "DESCRIPTION:Alarm text",
      "END:VALARM",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\n");
    const report = analyzeText(text);
    expect(report.kind).toBe("calendar");
    expect(field(report, "summary")).toMatchObject({ count: 4, omittedCount: 3 });
    expect(field(report, "summary-0").value).toBe("Event title");
    expect(report.displayFields.some((item) => item.value === "Task title")).toBe(false);
    expect(report.displayFields.some((item) => item.value === "Alarm text")).toBe(false);
  });

  it("does not attribute VTIMEZONE dates to the event", () => {
    const text = [
      "BEGIN:VCALENDAR",
      "BEGIN:VTIMEZONE",
      "TZID:America/New_York",
      "BEGIN:STANDARD",
      "DTSTART:19701101T020000",
      "END:STANDARD",
      "END:VTIMEZONE",
      "BEGIN:VEVENT",
      "SUMMARY:Review",
      "DTSTART:20260801T090000Z",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\n");
    const report = analyzeText(text);
    expect(report.kind).toBe("calendar");
    expect(field(report, "dtstart-1").value).toBe("20260801T090000Z");
    expect(report.displayFields.some((item) => item.value === "19701101T020000")).toBe(
      false,
    );
    expect(field(report, "summary")).toMatchObject({ count: 4, omittedCount: 2 });
  });

  it("keeps event timezone parameters attached to date-time values", () => {
    const report = analyzeText(
      [
        "BEGIN:VEVENT",
        "SUMMARY:Review",
        "DTSTART;TZID=America/New_York:20260801T090000",
        "END:VEVENT",
      ].join("\n"),
    );
    expect(field(report, "dtstart-1").value).toBe(
      "20260801T090000 (TZID=America/New_York)",
    );
  });

  it.each([
    [
      "a calendar without an event",
      ["BEGIN:VCALENDAR", "BEGIN:VTODO", "SUMMARY:Task", "END:VTODO", "END:VCALENDAR"].join("\n"),
    ],
    [
      "VTODO nested inside VEVENT",
      [
        "BEGIN:VEVENT",
        "SUMMARY:Event",
        "BEGIN:VTODO",
        "SUMMARY:Task",
        "END:VTODO",
        "END:VEVENT",
      ].join("\n"),
    ],
    [
      "VALARM directly inside VCALENDAR",
      [
        "BEGIN:VCALENDAR",
        "BEGIN:VALARM",
        "DESCRIPTION:Alarm",
        "END:VALARM",
        "END:VCALENDAR",
      ].join("\n"),
    ],
  ])("fails closed for %s", (_name, text) => {
    const report = analyzeText(text);
    expect(report.kind).toBe("text");
    expect(field(report, "text")).toMatchObject({ sensitive: true, masked: true });
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

  it("surfaces only the no-ECI ISO-8859-1 fallback as context", () => {
    const decodedText = "caf\u00e9";
    const baseInput = {
      rawBytes: { byteLength: 4, hex: "636166e9" },
      contentType: "Text",
    } as const;
    const fallback = analyzeDecodeResult({
      ...baseInput,
      decoding: {
        kind: "text",
        text: decodedText,
        encoding: "iso-8859-1",
        eci: null,
      },
    });

    expect(fallback.actionPolicy).toBe(analyzeText(decodedText).actionPolicy);
    expect(fallback.signals).toContainEqual({
      code: "assumed-iso-8859-1",
      level: "context",
      title: "ISO-8859-1 assumed (no ECI marker)",
      detail:
        "The symbol did not declare an ECI encoding, and its bytes were not valid UTF-8, so QRWarden interpreted them as ISO-8859-1.",
    });

    const declared = analyzeDecodeResult({
      ...baseInput,
      decoding: {
        kind: "text",
        text: decodedText,
        encoding: "iso-8859-1",
        eci: { assignment: 3 },
      },
    });
    const utf8 = analyzeDecodeResult({
      ...baseInput,
      decoding: {
        kind: "text",
        text: decodedText,
        encoding: "utf-8",
        eci: null,
      },
    });

    expect(declared.signals.some((item) => item.code === "assumed-iso-8859-1"))
      .toBe(false);
    expect(utf8.signals.some((item) => item.code === "assumed-iso-8859-1"))
      .toBe(false);
  });

  it("bounds fields by Unicode scalar values, not UTF-16 code units", () => {
    const report = analyzeText("😀".repeat(ANALYZER_LIMITS.fieldScalars + 5));
    const text = field(report, "text");
    expect(Array.from(text.value)).toHaveLength(ANALYZER_LIMITS.fieldScalars);
    expect(text.truncated).toBe(true);
  });

  it("escapes and bounds a report replacement value like the display value", () => {
    const fields = new ReportFields();
    fields.add("x", "X", "short", {
      reportValue: `tail\u2028${"r".repeat(ANALYZER_LIMITS.fieldScalars + 5)}`,
    });
    const bounded = fields.value[0]!;
    expect(bounded.reportValue).toContain("[U+2028]");
    expect(Array.from(bounded.reportValue!)).toHaveLength(ANALYZER_LIMITS.fieldScalars);
    expect(bounded.truncated).toBe(true);
  });

  it("charges long replacement values against the global copied-report budget", () => {
    const fields = new ReportFields();
    for (let index = 0; index < 4; index += 1) {
      expect(
        fields.add(`replacement-${index}`, "Replacement", "x", {
          reportPolicy: "safe",
          reportValue: "r".repeat(ANALYZER_LIMITS.fieldScalars),
        }),
      ).toBe(true);
    }
    expect(
      fields.add("overflow", "Overflow", "would otherwise fit", {
        reportPolicy: "safe",
      }),
    ).toBe(false);
    expect(
      fields.value.reduce(
        (total, item) => total + Array.from(item.reportValue ?? item.value).length,
        0,
      ),
    ).toBeLessThanOrEqual(ANALYZER_LIMITS.reportScalars);
  });

  it("defaults every field to hidden from copied reports", () => {
    const fields = new ReportFields();
    fields.add("unclassified", "Unclassified", "attacker-controlled");
    fields.add("structural", "Structural", "safe summary", {
      reportPolicy: "safe",
    });

    expect(fields.value[0]?.reportPolicy).toBe("hidden");
    expect(fields.value[1]?.reportPolicy).toBe("safe");
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
