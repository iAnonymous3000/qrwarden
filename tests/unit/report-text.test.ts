import { describe, expect, it, vi } from "vitest";

import { analyzeDecodeResult, analyzeText } from "../../src/analyzer";
import { COPY } from "../../src/copy";
import { reportAsText } from "../../src/render/reportText";

describe("report text rendering", () => {
  it("renders kind, status, signals, and fields as labelled plain text", () => {
    const report = analyzeText("http://127.0.0.1/login");
    const text = reportAsText({
      report,
      kindLabel: "Web link",
      statusHeading: COPY.reviewHeading,
    });

    expect(text.startsWith(COPY.reportTitle)).toBe(true);
    expect(text).toContain("Kind: Web link");
    expect(text).toContain(`Status: ${COPY.reviewHeading}`);
    expect(text).toContain(`[${COPY.signalNeedsReview}] Unencrypted HTTP`);
    expect(text).toContain("- Destination host: 127.0.0.1");
    expect(text).toContain(`Analyzer: ${report.analyzerVersion}`);
  });

  it("never includes sensitive field values", () => {
    const report = analyzeText(
      "WIFI:T:WPA;S:Private Test;P:correct horse battery staple;;",
    );
    const sensitiveValues = report.displayFields
      .filter((field) => field.sensitive)
      .map((field) => field.actionValue);
    expect(sensitiveValues.length).toBeGreaterThan(0);

    const text = reportAsText({
      report,
      kindLabel: "Wi-Fi details",
      statusHeading: COPY.inspectOnlyHeading,
    });

    for (const value of sensitiveValues) {
      expect(text).not.toContain(value);
    }
    expect(text).toContain(COPY.reportHiddenValue);
    // The SSID identifies a household or venue, so the copied report keeps
    // only its label while the on-screen row still shows the value.
    expect(text).not.toContain("Private Test");
    expect(text).toContain(`- Network name (SSID): ${COPY.reportHiddenValue}`);
  });

  it("keeps URL structure but hides path, query, and fragment values", () => {
    const report = analyzeText("https://example.com/cb?access_token=secret123#state=abc");
    const text = reportAsText({
      report,
      kindLabel: "Web link",
      statusHeading: COPY.reviewHeading,
    });

    expect(text).not.toContain("secret123");
    expect(text).not.toContain("abc");
    expect(text).toContain("example.com");
    // Path segments routinely carry capability tokens, so the copied report
    // keeps only the segment count while the on-screen row shows the path.
    expect(text).not.toContain("/cb");
    expect(report.displayFields.find((item) => item.id === "path")?.value).toBe("/cb");
    expect(text).toContain("- Path: /(1 segment hidden)");
    expect(text).toContain("access_token");
    expect(text).toContain(
      "https://example.com/(1 segment hidden)?(query values hidden)#(fragment hidden)",
    );
  });

  it("hides valueless query and fragment tokens from the copied report", () => {
    const report = analyzeText(
      "https://example.com/?TOKENVALUE12345&user=alice#a=1&SECRETFRAG",
    );
    const text = reportAsText({
      report,
      kindLabel: "Web link",
      statusHeading: COPY.reviewHeading,
    });

    // A pair without "=" is all payload, so only the on-screen review shows it.
    expect(report.displayFields.find((item) => item.id === "query-names")?.value).toBe(
      "TOKENVALUE12345, user",
    );
    expect(text).not.toContain("TOKENVALUE12345");
    expect(text).not.toContain("SECRETFRAG");
    expect(text).toContain("- Query names: user (1 valueless entry hidden)");
    expect(text).toContain("- Fragment names: a (1 valueless entry hidden)");
  });

  it("notes names omitted from display in the copied report", () => {
    const query = Array.from({ length: 70 }, (_, index) => `name${index}=x`).join("&");
    const report = analyzeText(`https://example.com/?${query}`);
    const text = reportAsText({
      report,
      kindLabel: "Web link",
      statusHeading: COPY.noReviewHeading,
    });

    expect(text).toContain(`  ${COPY.omittedFromDisplay(6, 70)}`);
  });

  it("escapes Unicode line separators so report lines cannot be forged", () => {
    const report = analyzeText(
      "https://example.com/?foo\u2029Status:%20safe=1",
    );
    const text = reportAsText({
      report,
      kindLabel: "Web link",
      statusHeading: COPY.reviewHeading,
    });

    expect(text).not.toContain("\u2029");
    expect(text).toContain("[U+2029]");
  });

  it("hides contact and calendar personal values while keeping labels", () => {
    const contact = reportAsText({
      report: analyzeText(
        ["BEGIN:VCARD", "FN:Alice Example", "TEL:+15551234567", "END:VCARD"].join("\r\n"),
      ),
      kindLabel: "Contact",
      statusHeading: COPY.inspectOnlyHeading,
    });
    expect(contact).not.toContain("Alice Example");
    expect(contact).not.toContain("+15551234567");
    expect(contact).toContain(`- Name: ${COPY.reportHiddenValue}`);
    expect(contact).toContain(`- Telephone: ${COPY.reportHiddenValue}`);

    const calendar = reportAsText({
      report: analyzeText(
        [
          "BEGIN:VCALENDAR",
          "BEGIN:VEVENT",
          "SUMMARY:Board offsite",
          "LOCATION:Room 1",
          "END:VEVENT",
          "END:VCALENDAR",
        ].join("\n"),
      ),
      kindLabel: "Calendar",
      statusHeading: COPY.inspectOnlyHeading,
    });
    expect(calendar).not.toContain("Board offsite");
    expect(calendar).not.toContain("Room 1");
    expect(calendar).toContain(`- Event: ${COPY.reportHiddenValue}`);
  });

  it("shows an sms body on screen but never in the copied report", () => {
    const report = analyzeText("sms:+15551234?body=Meet%20at%20noon");
    const bodyField = report.displayFields.find((item) => item.id === "body");
    expect(bodyField?.value).toBe("Meet at noon");

    const text = reportAsText({
      report,
      kindLabel: "Message",
      statusHeading: COPY.inspectOnlyHeading,
    });
    expect(text).not.toContain("Meet at noon");
    expect(text).not.toContain("+15551234");
    expect(text).toContain(`- Message body: ${COPY.reportHiddenValue}`);
  });

  it("hides the plain-text payload from the copied report", () => {
    const text = reportAsText({
      report: analyzeText("meet me at the usual place"),
      kindLabel: "Text",
      statusHeading: COPY.inspectOnlyHeading,
    });
    expect(text).not.toContain("meet me at the usual place");
    expect(text).toContain(`- Text: ${COPY.reportHiddenValue}`);
  });

  it("hides GS1, ISO 15434, and binary payload values from the copied report", () => {
    for (const contentType of ["GS1", "ISO15434"]) {
      const text = reportAsText({
        report: analyzeText("0195012345678903211ABCDEF-SECRET", contentType),
        kindLabel: "Structured data",
        statusHeading: COPY.inspectOnlyHeading,
      });
      expect(text).not.toContain("ABCDEF-SECRET");
      expect(text).toContain(`- Decoded content: ${COPY.reportHiddenValue}`);
    }

    const binary = reportAsText({
      report: analyzeDecodeResult({
        rawBytes: { byteLength: 8, hex: "deadbeefcafef00d" },
        contentType: "Binary",
        decoding: { kind: "binary", reason: "invalid-utf8", eci: null },
      }),
      kindLabel: "Binary data",
      statusHeading: COPY.rawBytesHeading,
    });
    expect(binary).not.toContain("deadbeefcafef00d");
    expect(binary).toContain("- Byte count: 8");
    expect(binary).toContain(`- Hexadecimal preview: ${COPY.reportHiddenValue}`);
  });

  it("marks truncated values with the localized truncation note", () => {
    const report = analyzeText(`https://example.com/${"a".repeat(3000)}`);
    expect(report.displayFields.some((field) => field.truncated)).toBe(true);
    const text = reportAsText({
      report,
      kindLabel: "Web link",
      statusHeading: COPY.noReviewHeading,
    });
    expect(text).toContain(`  ${COPY.reportTruncatedNote}`);
  });

  it("localizes scaffolding, labels, titles, and limitations in Spanish", async () => {
    vi.resetModules();
    vi.stubGlobal("navigator", { languages: ["es-ES"], language: "es-ES" });
    const { analyzeText: analyzeEs } = await import("../../src/analyzer");
    const { ES_COPY } = await import("../../src/copy/locales/es");
    const { reportAsText: reportAsTextEs } = await import(
      "../../src/render/reportText"
    );

    const report = analyzeEs("http://127.0.0.1/login");
    const text = reportAsTextEs({
      report,
      kindLabel: ES_COPY.kindLabels["web-url"],
      statusHeading: ES_COPY.reviewHeading,
    });

    expect(text.startsWith(ES_COPY.reportTitle)).toBe(true);
    expect(text).toContain("Tipo: Enlace web");
    expect(text).toContain(`Estado: ${ES_COPY.reviewHeading}`);
    expect(text).toContain("Señales:");
    // Titles translate; parametric detail sentences stay English for now.
    expect(text).toContain(
      `[${ES_COPY.signalNeedsReview}] HTTP sin cifrar: The address uses HTTP rather than HTTPS.`,
    );
    expect(text).toContain("Contenido decodificado:");
    expect(text).toContain("- Host de destino: 127.0.0.1");
    expect(text).toContain(ES_COPY.limitationContentOnly);
    expect(text).toContain(ES_COPY.limitationNoVisit);
    expect(text).not.toContain("Analysis uses only the content");
    expect(text).toContain(`Analizador: ${report.analyzerVersion}`);
  });

  it("localizes synthesized field values in the Spanish copied report", async () => {
    vi.resetModules();
    vi.stubGlobal("navigator", { languages: ["es-ES"], language: "es-ES" });
    const { analyzeText: analyzeEs } = await import("../../src/analyzer");
    const { ES_COPY } = await import("../../src/copy/locales/es");
    const { reportAsText: reportAsTextEs } = await import(
      "../../src/render/reportText"
    );

    const report = analyzeEs("http://127.0.0.1:8080/panel?token=abc#frag");
    const text = reportAsTextEs({
      report,
      kindLabel: ES_COPY.kindLabels["web-url"],
      statusHeading: ES_COPY.reviewHeading,
    });

    // Synthesized values localize exactly as on screen.
    expect(text).toContain("- Puerto: 8080 (explícito)");
    expect(text).toContain("- Fragmento: Presente");
    // IANA registry names stay English per the language-of-parts policy.
    expect(text).toContain("- Categoría del destino: Loopback");
    // Verbatim evidence passes through unchanged.
    expect(text).toContain("- Host de destino: 127.0.0.1");
  });
});
