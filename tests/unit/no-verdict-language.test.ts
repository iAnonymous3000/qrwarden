import { describe, expect, it } from "vitest";

import { analyzeDecodeResult, analyzeText } from "../../src/analyzer";
import { EN_COPY } from "../../src/copy/locales/en";
import { ES_COPY } from "../../src/copy/locales/es";

const EN_VERDICT_LABEL = /\b(?:safe|malicious|trusted)\b/iu;
const ES_VERDICT_LABEL = /\b(?:segur[oa]s?|malicios[oa]s?|confiables?)\b/iu;

function authoredStrings(
  value: unknown,
  path = "",
): readonly (readonly [path: string, value: string])[] {
  if (typeof value === "string") return [[path, value]];
  if (typeof value === "function") return [[path, String(value)]];
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value).flatMap(([key, child]) =>
    authoredStrings(child, path === "" ? key : `${path}.${key}`),
  );
}

function emittedSignals() {
  const reports = [
    analyzeText("https://b\u00fccher.example/"),
    analyzeText("https://example.com./"),
    analyzeText("http://127.0.0.1:8080/"),
    analyzeText("https://bit.ly/example"),
    analyzeText("https://a\u0431.example/"),
    analyzeText("https://\u0440\u0430\u0443\u0440.com/"),
    analyzeText("https://example.com/tail\u200b"),
    analyzeText("https://brand.example@example.com/"),
    analyzeText("http://exa\u0001mple.com/a"),
    analyzeText("https://example.com/a\\b"),
    analyzeDecodeResult({
      rawBytes: { byteLength: 4, hex: "636166e9" },
      contentType: "Text",
      decoding: {
        kind: "text",
        text: "caf\u00e9",
        encoding: "iso-8859-1",
        eci: null,
      },
    }),
  ];
  return reports.flatMap((report) => report.signals);
}

describe("signals-only product language", () => {
  it("keeps authored copy free of destination verdict labels", () => {
    expect(EN_COPY.aboutLead).toBe(
      "QRWarden explains observable properties of a QR code. It never calls a destination safe, trusted, malicious, or verified.",
    );
    expect(ES_COPY.aboutLead).toBe(
      "QRWarden explica propiedades observables de un c\u00f3digo QR. Nunca califica un destino como seguro, confiable, malicioso o verificado.",
    );

    for (const [path, value] of authoredStrings(EN_COPY)) {
      if (path === "aboutLead") continue;
      expect(value, `English copy at ${path}`).not.toMatch(EN_VERDICT_LABEL);
    }
    for (const [path, value] of authoredStrings(ES_COPY)) {
      if (path === "aboutLead") continue;
      expect(value, `Spanish copy at ${path}`).not.toMatch(ES_VERDICT_LABEL);
    }
  });

  it("keeps every emitted analyzer signal observational rather than verdicting", () => {
    const signals = emittedSignals();
    expect(new Set(signals.map((signal) => signal.code))).toEqual(
      new Set(Object.keys(EN_COPY.signalGlossary)),
    );
    for (const signal of signals) {
      expect(signal.title, `${signal.code} title`).not.toMatch(EN_VERDICT_LABEL);
      expect(signal.detail, `${signal.code} detail`).not.toMatch(EN_VERDICT_LABEL);
    }
  });
});
