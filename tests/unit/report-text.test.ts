import { describe, expect, it, vi } from "vitest";

import { analyzeDecodeResult, analyzeText } from "../../src/analyzer";
import { ANALYZER_LIMITS, ReportFields } from "../../src/analyzer/limits";
import { createReport } from "../../src/analyzer/report";
import { COPY } from "../../src/copy";
import {
  reportAsText,
  reviewedUrlSummary,
} from "../../src/render/reportText";

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

  it("fails closed for unclassified and attacker-provided Wi-Fi values", () => {
    const fields = new ReportFields();
    fields.add("unclassified", "Unclassified", "UNCLASSIFIED_VALUE");
    const unclassified = reportAsText({
      report: createReport({ kind: "text", fields: fields.value }),
      kindLabel: "Text",
      statusHeading: COPY.inspectOnlyHeading,
    });
    expect(unclassified).not.toContain("UNCLASSIFIED_VALUE");
    expect(unclassified).toContain(`- Unclassified: ${COPY.reportHiddenValue}`);

    const report = analyzeText(
      "WIFI:T:ATTACKER_SECURITY;S:Private Test;P:secret;H:true;;",
    );
    expect(report.displayFields.find((field) => field.id === "security")?.value).toBe(
      "ATTACKER_SECURITY",
    );
    expect(report.displayFields.find((field) => field.id === "hidden")?.value).toBe("Yes");
    const text = reportAsText({
      report,
      kindLabel: "Wi-Fi details",
      statusHeading: COPY.inspectOnlyHeading,
    });
    expect(text).not.toContain("ATTACKER_SECURITY");
    expect(text).toContain(
      `- Declared security type (not validated): ${COPY.reportHiddenValue}`,
    );
    expect(text).toContain("- Declared hidden network (not validated): Yes");
  });

  it("does not export enterprise Wi-Fi identities or declared methods", () => {
    const values = ["PRIVATE_SSID", "PRIVATE_EAP", "PRIVATE_PHASE2", "PRIVATE_ANON", "PRIVATE_ID", "PRIVATE_PASSWORD"];
    const report = analyzeText(
      "WIFI:S:PRIVATE_SSID;T:WPA2-EAP;E:PRIVATE_EAP;PH2:PRIVATE_PHASE2;A:PRIVATE_ANON;I:PRIVATE_ID;P:PRIVATE_PASSWORD;;",
    );
    const text = reportAsText({
      report,
      kindLabel: "Wi-Fi details",
      statusHeading: COPY.inspectOnlyHeading,
    });
    for (const value of values) expect(text).not.toContain(value);
    expect(text).toContain(
      `- Declared EAP method (not validated): ${COPY.reportHiddenValue}`,
    );
    expect(text).toContain(
      `- Declared phase 2 method (not validated): ${COPY.reportHiddenValue}`,
    );
    expect(text).toContain(`- Identity: ${COPY.reportHiddenValue}`);
  });

  it("keeps URL structure but hides path, query, and fragment names and values", () => {
    const report = analyzeText(
      "https://example.com/cb?QUERY_PRIVATE_NAME=secret123#FRAGMENT_PRIVATE_NAME=abc",
    );
    const text = reportAsText({
      report,
      kindLabel: "Web link",
      statusHeading: COPY.reviewHeading,
    });

    expect(text).not.toContain("secret123");
    expect(text).not.toContain("abc");
    expect(text).not.toContain("QUERY_PRIVATE_NAME");
    expect(text).not.toContain("FRAGMENT_PRIVATE_NAME");
    expect(text).toContain("example.com");
    // Path segments routinely carry capability tokens, so the copied report
    // keeps only the segment count while the on-screen row shows the path.
    expect(text).not.toContain("/cb");
    expect(report.displayFields.find((item) => item.id === "path")?.value).toBe("/cb");
    expect(text).toContain(`- Path: /${COPY.reportPathSegmentsHidden(1)}`);
    expect(text).toContain(`- Query names: ${COPY.reportUrlEntriesHidden(1)}`);
    expect(text).toContain(`- Fragment names: ${COPY.reportUrlEntriesHidden(1)}`);
    expect(text).toContain(
      `https://example.com/${COPY.reportPathSegmentsHidden(1)}?${COPY.reportQueryHidden}#${COPY.reportFragmentHidden}`,
    );
    const summary = reviewedUrlSummary(report);
    expect(summary).toBe(
      `https://example.com/${COPY.reportPathSegmentsHidden(1)}?${COPY.reportQueryHidden}#${COPY.reportFragmentHidden}`,
    );
    expect(summary).not.toContain("cb");
    expect(summary).not.toContain("secret123");
  });

  it.each([
    ["https://openai.com/?", "Present (empty)", "Not present"],
    ["https://openai.com/#", "None", "Present (empty)"],
    ["https://openai.com/?#", "Present (empty)", "Present (empty)"],
  ] as const)(
    "reports empty URL delimiters accurately for %s",
    (url, query, fragment) => {
      const text = reportAsText({
        report: analyzeText(url),
        kindLabel: "Web link",
        statusHeading: COPY.noReviewHeading,
      });
      expect(text).toContain(`- Query names: ${query}`);
      expect(text).toContain(`- Fragment: ${fragment}`);
      expect(text).toContain(`- Original QR content: ${url}`);
    },
  );

  it("fails closed when the canonical URL and analyzer-owned origin drift", () => {
    const report = analyzeText(
      "https://example.com/private-path?PRIVATE_QUERY_NAME=secret",
    );
    const drifted = {
      ...report,
      canonicalHref: "https://different.example/attacker-controlled?leak=1",
    } as typeof report;
    const text = reportAsText({
      report: drifted,
      kindLabel: "Web link",
      statusHeading: COPY.noReviewHeading,
    });

    expect(text).not.toContain("private-path");
    expect(text).not.toContain("PRIVATE_QUERY_NAME");
    expect(text).not.toContain("attacker-controlled");
    expect(text).toContain(`- Original QR content: ${COPY.reportHiddenValue}`);
    expect(reviewedUrlSummary(drifted)).toBeNull();
  });

  it("fails closed when a URL-name report replacement drifts to raw names", () => {
    const report = analyzeText("https://example.com/?PRIVATE_QUERY_NAME=secret");
    const drifted = {
      ...report,
      displayFields: report.displayFields.map((field) =>
        field.id === "query-names"
          ? { ...field, reportValue: field.value }
          : field,
      ),
    } as typeof report;
    const text = reportAsText({
      report: drifted,
      kindLabel: "Web link",
      statusHeading: COPY.noReviewHeading,
    });

    expect(text).not.toContain("PRIVATE_QUERY_NAME");
    expect(text).not.toContain("secret");
    expect(text).toContain(`- Query names: ${COPY.reportHiddenValue}`);
    expect(text).toContain(`- Original QR content: ${COPY.reportHiddenValue}`);
  });

  it("hides every query and fragment name while retaining total entry counts", () => {
    const report = analyzeText(
      "https://example.com/?TOKENVALUE12345&VISIBLE_QUERY_NAME=alice#VISIBLE_FRAGMENT_NAME=1&SECRETFRAG",
    );
    const text = reportAsText({
      report,
      kindLabel: "Web link",
      statusHeading: COPY.reviewHeading,
    });

    // A pair without "=" is all payload, so only the on-screen review shows it.
    expect(report.displayFields.find((item) => item.id === "query-names")?.value).toBe(
      "TOKENVALUE12345, VISIBLE_QUERY_NAME",
    );
    expect(
      report.displayFields.find((item) => item.id === "query-names")?.actionValue,
    ).toBe("TOKENVALUE12345, VISIBLE_QUERY_NAME");
    expect(text).not.toContain("TOKENVALUE12345");
    expect(text).not.toContain("SECRETFRAG");
    expect(text).not.toContain("VISIBLE_QUERY_NAME");
    expect(text).not.toContain("VISIBLE_FRAGMENT_NAME");
    expect(text).toContain(`- Query names: ${COPY.reportUrlEntriesHidden(2)}`);
    expect(text).toContain(`- Fragment names: ${COPY.reportUrlEntriesHidden(2)}`);
  });

  it("reports the total hidden-name count without a redundant display-omission note", () => {
    const query = Array.from({ length: 70 }, (_, index) => `name${index}=x`).join("&");
    const report = analyzeText(`https://example.com/?${query}`);
    const text = reportAsText({
      report,
      kindLabel: "Web link",
      statusHeading: COPY.noReviewHeading,
    });

    expect(text).toContain(`- Query names: ${COPY.reportUrlEntriesHidden(70)}`);
    expect(text).not.toContain(COPY.omittedFromDisplay(6, 70));
    expect(text).not.toContain("name0");
    expect(text).not.toContain("name63");
  });

  it("escapes Unicode line separators so report lines cannot be forged", () => {
    const report = analyzeText(
      "https://example.com/?foo\u2029FORGED-LINE=1",
    );
    const text = reportAsText({
      report,
      kindLabel: "Web link",
      statusHeading: COPY.reviewHeading,
    });

    expect(text).not.toContain("\u2029");
    expect(text).not.toContain("[U+2029]");
    expect(text).not.toContain("FORGED-LINE");
  });

  it("hides contact and calendar personal values while keeping labels", () => {
    const contact = reportAsText({
      report: analyzeText(
        [
          "BEGIN:VCARD",
          "VERSION:4.0",
          "FN:Alice Example",
          "TEL:+15551234567",
          "END:VCARD",
        ].join("\r\n"),
      ),
      kindLabel: "Contact",
      statusHeading: COPY.inspectOnlyHeading,
    });
    expect(contact).not.toContain("Alice Example");
    expect(contact).not.toContain("+15551234567");
    expect(contact).toContain("- Contact: vCard contact");
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
    expect(calendar).toContain("- Calendar: Calendar entry");
    expect(calendar).toContain(`- Event: ${COPY.reportHiddenValue}`);
  });

  it("discloses selective calendar coverage without leaking isolated components", () => {
    const report = analyzeText(
      [
        "BEGIN:VCALENDAR",
        "BEGIN:VTODO",
        "SUMMARY:PRIVATE_TASK",
        "END:VTODO",
        "BEGIN:VEVENT",
        "SUMMARY:PRIVATE_EVENT",
        "BEGIN:VALARM",
        "DESCRIPTION:PRIVATE_ALARM",
        "END:VALARM",
        "END:VEVENT",
        "END:VCALENDAR",
      ].join("\n"),
    );
    const text = reportAsText({
      report,
      kindLabel: "Calendar",
      statusHeading: COPY.inspectOnlyHeading,
    });
    expect(text).not.toContain("PRIVATE_TASK");
    expect(text).not.toContain("PRIVATE_EVENT");
    expect(text).not.toContain("PRIVATE_ALARM");
    expect(text).toContain(COPY.omittedFromDisplay(2, 3));
  });

  it.each([
    ["otpauth:", "OTP account"],
    ["DPP:", "DPP bootstrap"],
  ])("does not export an affirmative label for invalid %s", (source, label) => {
    const text = reportAsText({
      report: analyzeText(source),
      kindLabel: "Text",
      statusHeading: COPY.inspectOnlyHeading,
    });
    expect(text).not.toContain(label);
    expect(text).toContain(`- Text: ${COPY.reportHiddenValue}`);
  });

  it.each([
    ["bitcoin:garbage", "Payment", "Payment-related URI (payload not validated)"],
    ["foo:", "Action", "URI scheme only (no payload)"],
  ])("exports only neutral URI semantics for %s", (source, label, summary) => {
    const text = reportAsText({
      report: analyzeText(source),
      kindLabel: "URI",
      statusHeading: COPY.inspectOnlyHeading,
    });
    expect(text).toContain(`- ${label}: ${summary}`);
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

  it("does not disclose truncation metadata for a hidden field", () => {
    const text = reportAsText({
      report: analyzeText("private".repeat(ANALYZER_LIMITS.fieldScalars)),
      kindLabel: "Text",
      statusHeading: COPY.inspectOnlyHeading,
    });
    expect(text).toContain(`- Text: ${COPY.reportHiddenValue}`);
    expect(text).not.toContain(COPY.reportTruncatedNote);
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
    expect(text).toContain(`- Ruta: /${ES_COPY.reportPathSegmentsHidden(1)}`);
    expect(text).toContain(
      `- Nombres de la consulta: ${ES_COPY.reportUrlEntriesHidden(1)}`,
    );
    expect(text).toContain("- Fragmento: Presente");
    expect(text).toContain(
      `- Contenido original del código QR: http://127.0.0.1:8080/${ES_COPY.reportPathSegmentsHidden(1)}?${ES_COPY.reportQueryHidden}#${ES_COPY.reportFragmentHidden}`,
    );
    expect(text).not.toContain("segment hidden");
    expect(text).not.toContain("query hidden");
    expect(text).not.toContain("fragment hidden");
    expect(text).not.toContain("token");
    // IANA registry names stay English per the language-of-parts policy.
    expect(text).toContain("- Categoría del destino: Loopback");
    // Verbatim evidence passes through unchanged.
    expect(text).toContain("- Host de destino: 127.0.0.1");

    const emptyQueryReport = analyzeEs("https://example.com/");
    const emptyQueryText = reportAsTextEs({
      report: emptyQueryReport,
      kindLabel: ES_COPY.kindLabels["web-url"],
      statusHeading: ES_COPY.noReviewHeading,
    });
    expect(emptyQueryText).toContain(
      `- Nombres de la consulta: ${ES_COPY.fieldValues.None}`,
    );
  });
});
