import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import * as copyModule from "../../src/copy";
import { COPY } from "../../src/copy";
import { resolveAppLocale } from "../../src/copy/locale";
import { EN_COPY } from "../../src/copy/locales/en";
import { ES_COPY } from "../../src/copy/locales/es";

const SOURCE_SHA256: Readonly<Record<string, string>> = {
  "index.ts": "234450ba710c6ac8be379a7a6069da5dc6636c8967927e7b93b4a0da9aa9095c",
  "locale.ts": "25d5b29e629a58c0fe772b5ff97830fd68f0064b2fbeb79b0326ff170539055e",
  "evidence.ts": "1307803b3c27a93131567b6a0b2efca539d034c1438920979935927895ca9ce0",
  "locales/en.ts": "16f262904f330e8ea6a52d086f5f8c9a730b80ec450eab53c1312ef113cbcbd7",
  "locales/es.ts": "e23f44a13a46c48c48afff5635c4099fb54d7c9320f5e234add7cd10f69afa9c",
};
const RUNTIME_CONTRACT_SHA256 =
  "cf9eccc5dfdc5d40589cf8448f4302bc56bef254124322b21a8e9ad1e8a6de4e";
const COPY_KEY_COUNT = 232;

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function materialize(key: string, value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "object" && value !== null) {
    return JSON.stringify(value);
  }
  if (typeof value !== "function") {
    throw new TypeError(`Unexpected copy export type for ${key}`);
  }
  switch (key) {
    case "reviewBody":
      return (value as (count: number) => string)(7);
    case "confirmBody":
    case "credentialsExplanation":
      return (value as (host: string) => string)("scan.example");
    case "selectionOptionLabel":
      return (value as (index: number, position: string, kind: string) => string)(
        2,
        "top left",
        "Web link",
      );
    case "copyField":
    case "showField":
    case "hideField":
      return (value as (label: string) => string)("path");
    case "portValueEffective":
    case "portValueExplicit":
      return (value as (port: string) => string)("8080");
    case "reportPathSegmentsHidden":
    case "reportUrlEntriesHidden":
      return [
        (value as (count: number) => string)(1),
        (value as (count: number) => string)(3),
      ].join(" | ");
    case "omittedFromDisplay":
      return [
        (value as (omitted: number, total?: number) => string)(3),
        (value as (omitted: number, total?: number) => string)(3, 12),
      ].join(" | ");
    case "appearanceFollowing":
    case "appearanceUsing":
      return [
        (value as (theme: string) => string)("dark"),
        (value as (theme: string) => string)("light"),
      ].join(" | ");
    default:
      throw new TypeError(`Copy function ${key} needs an explicit snapshot input`);
  }
}

function renderedSnapshot(
  dictionary: Readonly<Record<string, unknown>>,
): readonly (readonly [string, string])[] {
  return Object.entries(dictionary).map(([key, value]) => [
    key,
    materialize(key, value),
  ]);
}

describe("reviewed copy contract", () => {
  it("pluralizes review details for plain-language results", () => {
    expect(EN_COPY.reviewBody(1)).toContain("1 detail to review");
    expect(EN_COPY.reviewBody(2)).toContain("2 details to review");
    expect(ES_COPY.reviewBody(1)).toContain("1 detalle");
    expect(ES_COPY.reviewBody(2)).toContain("2 detalles");
    expect(ES_COPY.omittedFromDisplay(1)).toContain("1 omitido de la vista");
    expect(ES_COPY.omittedFromDisplay(2)).toContain("2 omitidos de la vista");
    expect(ES_COPY.omittedFromDisplay(1, 12)).toContain("1 omitido de la vista");
  });

  it("resolves supported locales and defaults to English", () => {
    expect(resolveAppLocale(["es-MX", "en-US"])).toBe("es");
    expect(resolveAppLocale(["fr-FR", "es"])).toBe("es");
    expect(resolveAppLocale(["fr-FR", "de"])).toBe("en");
    expect(resolveAppLocale([])).toBe("en");
    expect(resolveAppLocale([undefined])).toBe("en");
  });

  it("keeps every locale key-identical to English", () => {
    expect(Object.keys(ES_COPY)).toEqual(Object.keys(EN_COPY));
    expect(Object.keys(ES_COPY.signalGlossary)).toEqual(
      Object.keys(EN_COPY.signalGlossary),
    );
    expect(Object.keys(ES_COPY.kindLabels)).toEqual(Object.keys(EN_COPY.kindLabels));
    expect(Object.keys(ES_COPY.fieldLabels)).toEqual(
      Object.keys(EN_COPY.fieldLabels),
    );
    expect(Object.keys(ES_COPY.signalTitles)).toEqual(
      Object.keys(EN_COPY.signalTitles),
    );
    expect(Object.keys(ES_COPY.fieldValues)).toEqual(
      Object.keys(EN_COPY.fieldValues),
    );
    expect(Object.keys(ES_COPY.positionLabels)).toEqual(
      Object.keys(EN_COPY.positionLabels),
    );
  });

  it("snapshots every source byte, runtime export, key, and rendered string", async () => {
    for (const [file, expected] of Object.entries(SOURCE_SHA256)) {
      const source = await readFile(
        new URL(`../../src/copy/${file}`, import.meta.url),
      );
      expect(sha256(source), file).toBe(expected);
    }

    expect(Object.keys(copyModule)).toEqual(["COPY"]);
    expect(Object.isFrozen(COPY)).toBe(true);
    expect(COPY).toBe(EN_COPY);

    const snapshot = [
      ...renderedSnapshot(EN_COPY),
      ...renderedSnapshot(ES_COPY),
    ];
    expect(snapshot).toHaveLength(COPY_KEY_COUNT * 2);
    expect(
      snapshot.every(([key, value]) => key.length > 0 && value.length > 0),
    ).toBe(true);
    expect(sha256(JSON.stringify(snapshot))).toBe(RUNTIME_CONTRACT_SHA256);
  });
});
