import { describe, expect, it } from "vitest";

import { analyzeText } from "../../src/analyzer";
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
  });
});
