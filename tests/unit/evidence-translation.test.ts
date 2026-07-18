import { describe, expect, it, vi } from "vitest";

import { analyzeDecodeResult, analyzeText } from "../../src/analyzer";
import {
  ENGLISH_EVIDENCE_LANG,
  translateFieldLabel,
  translateFieldValue,
  translateSignalTitle,
} from "../../src/copy/evidence";
import { EN_COPY } from "../../src/copy/locales/en";
import { ES_COPY } from "../../src/copy/locales/es";

const EN_FIELD_LABELS: Readonly<Record<string, string>> = EN_COPY.fieldLabels;
const ES_FIELD_LABELS: Readonly<Record<string, string>> = ES_COPY.fieldLabels;
const EN_SIGNAL_TITLES: Readonly<Record<string, string>> = EN_COPY.signalTitles;
const ES_SIGNAL_TITLES: Readonly<Record<string, string>> = ES_COPY.signalTitles;

/**
 * Representative payloads spanning every analyzer report family, so the
 * evidence tables must cover each field label and signal title the analyzer
 * emits today. Adding an analyzer label without a translation fails here.
 */
const TEXT_FIXTURES: readonly string[] = [
  "http://user@127.0.0.1:8443/path?token=1#state=2",
  "https://bücher.example/path#frag",
  "https://bit.ly/abc",
  "https://example.com./",
  "http://ex ample.com/a",
  // Latin and Cyrillic in one label: mixed writing systems.
  "https://aб.example/",
  // All-Cyrillic label whose confusable skeleton is ASCII "payp".
  "https://раур.com/",
  // Zero-width space after the authority: hidden or control character, and
  // the browser's percent-encoding of it is a material rewrite.
  "https://example.com/tail\u200b",
  "https://example.com/a\\b",
  // C0 control inside the host: forbidden character in the authority.
  "http://exa\u0001mple.com/a",
  [
    "BEGIN:VCARD",
    "VERSION:4.0",
    "FN:Alice Example",
    "N:Example;Alice",
    "ORG:Example Co",
    "TITLE:Engineer",
    "TEL:+15551234567",
    "EMAIL:alice@example.com",
    "ADR:;;1 Main St;;;;",
    "NOTE:hello",
    "END:VCARD",
  ].join("\r\n"),
  [
    "BEGIN:VCARD",
    "VERSION:2.1",
    "FN:Minimal",
    "N:Minimal;;;;",
    "END:VCARD",
  ].join("\r\n"),
  "WIFI:T:WPA;S:Cafe;P:secret;H:true;;",
  "WIFI:T:WPA2-EAP;S:Corp;E:TTLS;PH2:MSCHAPV2;A:anonymous;I:alice;P:secret;;",
  "WIFI:T:WPA2-EAP;S:Legacy;H:MSCHAPV2;;",
  [
    "BEGIN:VCALENDAR",
    "BEGIN:VEVENT",
    "SUMMARY:Offsite",
    "DTSTART:20260801T090000Z",
    "DTEND:20260801T100000Z",
    "LOCATION:Room 1",
    "DESCRIPTION:Agenda",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\n"),
  "sms:+15551234?body=Meet%20at%20noon",
  "SMSTO:+15551234:Meet at noon",
  "mailto:alice@example.com?subject=Hi&body=See%20you",
  "mailto:?to=alice@example.com&cc=bob@example.com&bcc=carol@example.com",
  "tel:+15551234567",
  "geo:37.7,-122.4",
  "otpauth://totp/Example:alice?secret=JBSWY3DPEHPK3PXP",
  "otpauth://hotp/Example:alice?secret=JBSWY3DPEHPK3PXP&counter=0",
  "DPP:C:81/1;K:0123456789abcdef;;",
  "bitcoin:bc1qexample",
  "myapp:open?x=1",
  "foo:",
  "plain text payload",
  "",
];

function fixtureReports() {
  return [
    ...TEXT_FIXTURES.map((text) => analyzeText(text)),
    analyzeText("structured payload", "GS1"),
    analyzeText("structured payload", "ISO15434"),
    analyzeDecodeResult({
      rawBytes: { byteLength: 3, hex: "00ff7f" },
      contentType: "Text",
      decoding: { kind: "binary", reason: "no text decoding", eci: null },
    }),
    analyzeDecodeResult({
      rawBytes: { byteLength: 4, hex: "636166e9" },
      contentType: "Text",
      decoding: {
        kind: "text",
        text: "café",
        encoding: "iso-8859-1",
        eci: null,
      },
    }),
  ];
}

describe("analyzer evidence translation", () => {
  it("covers every emitted field label and signal title in both tables", () => {
    for (const report of fixtureReports()) {
      for (const field of report.displayFields) {
        expect(EN_FIELD_LABELS[field.label], `en: ${field.label}`).toBeDefined();
        expect(ES_FIELD_LABELS[field.label], `es: ${field.label}`).toBeDefined();
      }
      for (const signal of report.signals) {
        expect(EN_SIGNAL_TITLES[signal.title], `en: ${signal.title}`).toBeDefined();
        expect(ES_SIGNAL_TITLES[signal.title], `es: ${signal.title}`).toBeDefined();
      }
    }
  });

  it("exercises every table entry, so retitling in the analyzer fails here", () => {
    // translateEvidence falls back to English silently, so exact-string drift
    // between the analyzer and these tables surfaces only through this guard.
    const labels = new Set<string>();
    const titles = new Set<string>();
    for (const report of fixtureReports()) {
      for (const field of report.displayFields) labels.add(field.label);
      for (const signal of report.signals) titles.add(signal.title);
    }
    expect([...labels].sort()).toEqual(Object.keys(EN_FIELD_LABELS).sort());
    expect([...titles].sort()).toEqual(Object.keys(EN_SIGNAL_TITLES).sort());
  });

  it("covers every synthesized field value the analyzer emits today", () => {
    // Fields whose values are entirely analyzer-synthesized English and must
    // therefore have entries in both fieldValues tables. destination-category
    // is excluded: its IANA registry names deliberately stay English and are
    // marked lang="en" by translateFieldValue's fail-closed fallback.
    const synthesizedIds = new Set([
      "fragment",
      "hidden",
      "otp-type",
      "dpp-type",
      "summary",
    ]);
    const enValues: Readonly<Record<string, string>> = EN_COPY.fieldValues;
    const esValues: Readonly<Record<string, string>> = ES_COPY.fieldValues;
    for (const report of fixtureReports()) {
      for (const field of report.displayFields) {
        if (field.id === "port" && field.kind === "port") {
          // The parametric port descriptor must keep the exact shape the
          // locale formatters rebuild at render time.
          expect(field.value).toMatch(/^\d+ \((?:effective|explicit)\)$/u);
          continue;
        }
        if (
          (field.id === "query-names" || field.id === "fragment-names") &&
          field.count === 0
        ) {
          expect(field.value).toBe("None");
          expect(enValues.None).toBeDefined();
          expect(esValues.None).toBeDefined();
          continue;
        }
        if (!synthesizedIds.has(field.id)) continue;
        expect(enValues[field.value], `en: ${field.value}`).toBeDefined();
        expect(esValues[field.value], `es: ${field.value}`).toBeDefined();
      }
    }
    expect(Object.keys(esValues)).toEqual(Object.keys(enValues));
  });

  it("keeps the signal-title tables aligned with the glossary titles", () => {
    const glossaryTitles = Object.values(EN_COPY.signalGlossary)
      .map((entry) => entry.title)
      .sort();
    expect([...Object.keys(EN_COPY.signalTitles)].sort()).toEqual(glossaryTitles);
    expect(Object.keys(ES_COPY.signalTitles)).toEqual(
      Object.keys(EN_COPY.signalTitles),
    );
    expect(Object.keys(ES_COPY.fieldLabels)).toEqual(
      Object.keys(EN_COPY.fieldLabels),
    );
  });

  it("returns identity text with no language mark on the English page", () => {
    expect(translateFieldLabel("Destination host")).toEqual({
      text: "Destination host",
      lang: undefined,
    });
    expect(translateSignalTitle("Unencrypted HTTP")).toEqual({
      text: "Unencrypted HTTP",
      lang: undefined,
    });
    expect(
      translateFieldValue({
        id: "fragment",
        label: "Fragment",
        kind: "presence",
        value: "Present",
      }),
    ).toEqual({ text: "Present", lang: undefined });
    expect(ENGLISH_EVIDENCE_LANG).toBeUndefined();
  });

  it("translates synthesized field values for Spanish and never rewrites verbatim content", async () => {
    vi.resetModules();
    vi.stubGlobal("navigator", { languages: ["es-ES"], language: "es-ES" });
    const evidence = await import("../../src/copy/evidence");
    // Fully synthesized values translate through the table.
    expect(
      evidence.translateFieldValue({
        id: "fragment",
        label: "Fragment",
        kind: "presence",
        value: "Present",
      }),
    ).toEqual({ text: "Presente", lang: undefined });
    expect(
      evidence.translateFieldValue({
        id: "summary",
        label: "Action",
        kind: "text",
        value: "Email details (inspect only)",
      }),
    ).toEqual({ text: "Datos de correo (solo inspección)", lang: undefined });
    // The parametric port descriptor rebuilds from the locale formatters.
    expect(
      evidence.translateFieldValue({
        id: "port",
        label: "Port",
        kind: "port",
        value: "8080 (explicit)",
      }),
    ).toEqual({ text: "8080 (explícito)", lang: undefined });
    expect(
      evidence.translateFieldValue({
        id: "port",
        label: "Port",
        kind: "port",
        value: "443 (effective)",
      }),
    ).toEqual({ text: "443 (efectivo)", lang: undefined });
    // Unknown synthesized values (IANA registry names) stay English marked.
    expect(
      evidence.translateFieldValue({
        id: "destination-category",
        label: "Destination category",
        kind: "text",
        value: "Loopback",
      }),
    ).toEqual({ text: "Loopback", lang: "en" });
    // Mixed fields translate only their exact synthesized fallback string.
    expect(
      evidence.translateFieldValue({
        id: "registrable-domain",
        label: "Registrable domain",
        kind: "domain",
        value: "Not available",
      }),
    ).toEqual({ text: "No disponible", lang: undefined });
    // A zero count proves "None" is the analyzer's empty-state descriptor.
    expect(
      evidence.translateFieldValue({
        id: "query-names",
        label: "Query names",
        kind: "names",
        value: "None",
        count: 0,
      }),
    ).toEqual({ text: ES_COPY.fieldValues.None, lang: undefined });
    // A real parameter named "None" remains verbatim attacker-controlled data.
    expect(
      evidence.translateFieldValue({
        id: "query-names",
        label: "Query names",
        kind: "names",
        value: "None",
        count: 1,
      }),
    ).toEqual({ text: "None", lang: undefined });
    expect(
      evidence.translateFieldValue({
        id: "registrable-domain",
        label: "Registrable domain",
        kind: "domain",
        value: "example.com",
      }),
    ).toEqual({ text: "example.com", lang: undefined });
    // Verbatim decoded content passes through untouched even when it happens
    // to equal a table key.
    expect(
      evidence.translateFieldValue({
        id: "ssid",
        label: "Network name (SSID)",
        kind: "text",
        value: "Present",
      }),
    ).toEqual({ text: "Present", lang: undefined });
    expect(
      evidence.translateFieldValue({
        id: "content",
        label: "Decoded content",
        kind: "text",
        value: "Empty",
      }),
    ).toEqual({ text: "Empty", lang: undefined });
    // The empty-payload report's synthesized value still translates.
    expect(
      evidence.translateFieldValue({
        id: "content",
        label: "QR content",
        kind: "text",
        value: "Empty",
      }),
    ).toEqual({ text: "Vacío", lang: undefined });
  });

  it("translates known evidence for Spanish and marks fallbacks lang=en", async () => {
    vi.resetModules();
    vi.stubGlobal("navigator", { languages: ["es-ES"], language: "es-ES" });
    const evidence = await import("../../src/copy/evidence");
    expect(evidence.translateFieldLabel("Destination host")).toEqual({
      text: "Host de destino",
      lang: undefined,
    });
    expect(evidence.translateSignalTitle("Unencrypted HTTP")).toEqual({
      text: "HTTP sin cifrar",
      lang: undefined,
    });
    expect(evidence.translateFieldLabel("Never emitted label")).toEqual({
      text: "Never emitted label",
      lang: "en",
    });
    expect(evidence.ENGLISH_EVIDENCE_LANG).toBe("en");
  });
});
