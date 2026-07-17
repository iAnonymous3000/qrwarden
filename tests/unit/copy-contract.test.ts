import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import * as copyModule from "../../src/copy";
import { COPY } from "../../src/copy";
import { resolveAppLocale } from "../../src/copy/locale";
import { EN_COPY } from "../../src/copy/locales/en";
import { ES_COPY } from "../../src/copy/locales/es";

const SOURCE_SHA256: Readonly<Record<string, string>> = {
  "index.ts": "e5a010ff1f36bef2fd5706ce201994e9496199cfbac96f410f598a0798a58a8c",
  "locale.ts": "25d5b29e629a58c0fe772b5ff97830fd68f0064b2fbeb79b0326ff170539055e",
  "evidence.ts": "575740fface891a31e19d4c1ee98f8b5453155d196dfc189739ef89ef1ebc1cf",
  "locales/en.ts": "c50c2870a788a4812e5c802aeb5feea4a651725db8624c5b531fc445ac66cc5e",
  "locales/es.ts": "a8f79c57d800cea39dc9294744074aefa8f0332fa0e4dc9719818288db6278c8",
};
const RUNTIME_CONTRACT_SHA256 =
  "9a5e59cc9114061d8a0ed5b3e9f02177af0949413f0ba7fb445f736ac3dd8b6d";
const COPY_KEY_COUNT = 224;

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
