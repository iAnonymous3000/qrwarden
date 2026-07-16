import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import * as copyModule from "../../src/copy";
import { COPY } from "../../src/copy";

const SOURCE_SHA256 =
  "b513e1034918b20cbcb1f0204f70a27b27de8c3dacf3c05010a3c76b88c24825";
const RUNTIME_CONTRACT_SHA256 =
  "34bb7152e122908ff1bb34ba85701a8acd12c7294cde30e127fd1cc24869fb58";

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function materialize(key: string, value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value !== "function") {
    throw new TypeError(`Unexpected copy export type for ${key}`);
  }
  switch (key) {
    case "reviewBody":
      return (value as (count: number) => string)(7);
    case "confirmBody":
    case "credentialsExplanation":
      return (value as (host: string) => string)("scan.example");
    default:
      throw new TypeError(`Copy function ${key} needs an explicit snapshot input`);
  }
}

describe("reviewed copy contract", () => {
  it("pluralizes review details for plain-language results", () => {
    expect(COPY.reviewBody(1)).toContain("1 detail to review");
    expect(COPY.reviewBody(2)).toContain("2 details to review");
  });

  it("snapshots every source byte, runtime export, key, and rendered string", async () => {
    const source = await readFile(
      new URL("../../src/copy/index.ts", import.meta.url),
    );
    const snapshot = Object.entries(COPY).map(([key, value]) => [
      key,
      materialize(key, value),
    ]);

    expect(Object.keys(copyModule)).toEqual(["COPY"]);
    expect(Object.isFrozen(COPY)).toBe(true);
    expect(snapshot).toHaveLength(96);
    expect(snapshot.every(([key, value]) => key.length > 0 && value.length > 0)).toBe(
      true,
    );
    expect(sha256(source)).toBe(SOURCE_SHA256);
    expect(sha256(JSON.stringify(snapshot))).toBe(RUNTIME_CONTRACT_SHA256);
  });
});
