import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import * as copyModule from "../../src/copy";
import { COPY } from "../../src/copy";

const SOURCE_SHA256 =
  "c699a7aa7611f2689e3e8bfc0878b672b8dbba8e4380b1d3fe233fa87c0c9e18";
const RUNTIME_CONTRACT_SHA256 =
  "2051123f89a3a78129d848f51f92333e7f535e4d686fa4a3029b680ef1936b29";

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
    expect(snapshot).toHaveLength(92);
    expect(snapshot.every(([key, value]) => key.length > 0 && value.length > 0)).toBe(
      true,
    );
    expect(sha256(source)).toBe(SOURCE_SHA256);
    expect(sha256(JSON.stringify(snapshot))).toBe(RUNTIME_CONTRACT_SHA256);
  });
});
