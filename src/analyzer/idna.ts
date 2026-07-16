import {
  bidiClass,
  canonicalCombiningClass,
  idnaEntry,
  isMark,
  joiningType,
} from "./unicodeData";
import { decodePunycodeLabel, encodePunycodeLabel } from "./punycode";
import {
  isNormalizedNfc,
  normalizeNfc,
  unicodeCodePoints,
  unicodeString,
} from "./unicodeNormalize";

export type IdnaError =
  | "invalid-code-point"
  | "disallowed"
  | "empty-label"
  | "hyphen"
  | "leading-mark"
  | "std3"
  | "contextj"
  | "bidi"
  | "punycode"
  | "invalid-a-label"
  | "not-nfc"
  | "dns-length";

export interface IdnaResult {
  readonly value: string;
  readonly valid: boolean;
  readonly errors: readonly IdnaError[];
}

export interface IdnaOptions {
  readonly checkHyphens?: boolean;
  readonly checkBidi?: boolean;
  readonly checkJoiners?: boolean;
  readonly useStd3AsciiRules?: boolean;
  readonly verifyDnsLength?: boolean;
}

interface ResolvedOptions {
  readonly checkHyphens: boolean;
  readonly checkBidi: boolean;
  readonly checkJoiners: boolean;
  readonly useStd3AsciiRules: boolean;
  readonly verifyDnsLength: boolean;
}

interface ProcessedDomain {
  readonly labels: readonly string[];
  readonly trailingRootDot: boolean;
  readonly errors: Set<IdnaError>;
}

const DEFAULT_OPTIONS: ResolvedOptions = Object.freeze({
  checkHyphens: true,
  checkBidi: true,
  checkJoiners: true,
  useStd3AsciiRules: true,
  verifyDnsLength: true,
});

function resolveOptions(options: IdnaOptions | undefined): ResolvedOptions {
  return {
    checkHyphens: options?.checkHyphens ?? DEFAULT_OPTIONS.checkHyphens,
    checkBidi: options?.checkBidi ?? DEFAULT_OPTIONS.checkBidi,
    checkJoiners: options?.checkJoiners ?? DEFAULT_OPTIONS.checkJoiners,
    useStd3AsciiRules:
      options?.useStd3AsciiRules ?? DEFAULT_OPTIONS.useStd3AsciiRules,
    verifyDnsLength: options?.verifyDnsLength ?? DEFAULT_OPTIONS.verifyDnsLength,
  };
}

function result(value: string, errors: Set<IdnaError>): IdnaResult {
  const values = Object.freeze([...errors]);
  return Object.freeze({ value, valid: values.length === 0, errors: values });
}

function mappedDomain(input: string, errors: Set<IdnaError>): string {
  const mapped: number[] = [];
  for (const character of input) {
    const point = character.codePointAt(0);
    if (
      point === undefined ||
      point > 0x10ffff ||
      (point >= 0xd800 && point <= 0xdfff)
    ) {
      errors.add("invalid-code-point");
      mapped.push(0xfffd);
      continue;
    }

    const entry = idnaEntry(point);
    switch (entry.status) {
      case "ignored":
        break;
      case "mapped":
        mapped.push(...entry.mapping);
        break;
      case "valid":
      case "deviation":
      case "disallowed":
        mapped.push(point);
        break;
    }
  }
  return normalizeNfc(unicodeString(mapped));
}

function hasOnlyAscii(value: string): boolean {
  for (const point of unicodeCodePoints(value)) {
    if (point > 0x7f) return false;
  }
  return true;
}

function startsWithAcePrefix(label: string): boolean {
  return (
    label.length >= 4 &&
    label.charCodeAt(0) === 0x78 &&
    label.charCodeAt(1) === 0x6e &&
    label.charCodeAt(2) === 0x2d &&
    label.charCodeAt(3) === 0x2d
  );
}

function decodeAceLabel(label: string, errors: Set<IdnaError>): string {
  if (!startsWithAcePrefix(label)) return label;
  if (!hasOnlyAscii(label)) {
    errors.add("invalid-a-label");
    return label;
  }

  const decoded = decodePunycodeLabel(label.slice(4));
  if (decoded === null) {
    errors.add("punycode");
    return label;
  }
  if (decoded.length === 0 || hasOnlyAscii(decoded)) errors.add("invalid-a-label");

  const encoded = encodePunycodeLabel(decoded);
  if (encoded === null || `xn--${encoded}` !== label) errors.add("invalid-a-label");
  return decoded;
}

function contextJValid(points: readonly number[], index: number): boolean {
  const point = points[index];
  if (point !== 0x200c && point !== 0x200d) return true;

  const before = points[index - 1];
  if (before !== undefined && canonicalCombiningClass(before) === 9) return true;
  if (point === 0x200d) return false;

  let left = index - 1;
  while (left >= 0 && joiningType(points[left]!) === "T") left -= 1;
  if (left < 0) return false;
  const leftType = joiningType(points[left]!);
  if (leftType !== "L" && leftType !== "D") return false;

  let right = index + 1;
  while (right < points.length && joiningType(points[right]!) === "T") right += 1;
  if (right >= points.length) return false;
  const rightType = joiningType(points[right]!);
  return rightType === "R" || rightType === "D";
}

function isBidiDomain(labels: readonly string[]): boolean {
  for (const label of labels) {
    for (const point of unicodeCodePoints(label)) {
      const value = bidiClass(point);
      if (value === "R" || value === "AL" || value === "AN") return true;
    }
  }
  return false;
}

function lastNonNsmClass(points: readonly number[]): string | null {
  for (let index = points.length - 1; index >= 0; index -= 1) {
    const value = bidiClass(points[index]!);
    if (value !== "NSM") return value;
  }
  return null;
}

function bidiLabelValid(points: readonly number[]): boolean {
  const first = points[0];
  if (first === undefined) return false;
  const firstClass = bidiClass(first);
  const lastClass = lastNonNsmClass(points);

  if (firstClass === "R" || firstClass === "AL") {
    const allowed = new Set(["R", "AL", "AN", "EN", "ES", "CS", "ET", "ON", "BN", "NSM"]);
    let hasEuropeanNumber = false;
    let hasArabicNumber = false;
    for (const point of points) {
      const value = bidiClass(point);
      if (!allowed.has(value)) return false;
      if (value === "EN") hasEuropeanNumber = true;
      if (value === "AN") hasArabicNumber = true;
    }
    return (
      !hasEuropeanNumber ||
      !hasArabicNumber
    ) && (lastClass === "R" || lastClass === "AL" || lastClass === "EN" || lastClass === "AN");
  }

  if (firstClass !== "L") return false;
  const allowed = new Set(["L", "EN", "ES", "CS", "ET", "ON", "BN", "NSM"]);
  for (const point of points) {
    if (!allowed.has(bidiClass(point))) return false;
  }
  return lastClass === "L" || lastClass === "EN";
}

function isStd3Ascii(point: number): boolean {
  return (
    point === 0x2d ||
    (point >= 0x30 && point <= 0x39) ||
    (point >= 0x61 && point <= 0x7a)
  );
}

function validateLabel(
  label: string,
  options: ResolvedOptions,
  bidiDomain: boolean,
  errors: Set<IdnaError>,
): void {
  const points = unicodeCodePoints(label);
  if (points.length === 0) {
    errors.add("empty-label");
    return;
  }
  if (!isNormalizedNfc(label)) errors.add("not-nfc");

  if (
    options.checkHyphens &&
    ((points[2] === 0x2d && points[3] === 0x2d) ||
      points[0] === 0x2d ||
      points[points.length - 1] === 0x2d)
  ) {
    errors.add("hyphen");
  }
  if (points.includes(0x2e)) errors.add("disallowed");
  if (isMark(points[0]!)) errors.add("leading-mark");

  for (let index = 0; index < points.length; index += 1) {
    const point = points[index]!;
    const status = idnaEntry(point).status;
    if (status !== "valid" && status !== "deviation") errors.add("disallowed");
    if (options.useStd3AsciiRules && point <= 0x7f && !isStd3Ascii(point)) {
      errors.add("std3");
    }
    if (options.checkJoiners && !contextJValid(points, index)) errors.add("contextj");
  }

  if (options.checkBidi && bidiDomain && !bidiLabelValid(points)) errors.add("bidi");
}

function processDomain(input: string, options: ResolvedOptions): ProcessedDomain {
  const errors = new Set<IdnaError>();
  let mapped: string;
  try {
    mapped = mappedDomain(input, errors);
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    errors.add("invalid-code-point");
    mapped = "\ufffd";
  }

  const trailingRootDot = mapped.endsWith(".");
  const nonRoot = trailingRootDot ? mapped.slice(0, -1) : mapped;
  const sourceLabels = nonRoot.split(".");
  const labels = sourceLabels.map((label) => decodeAceLabel(label, errors));
  const bidiDomain = isBidiDomain(labels);
  for (const label of labels) validateLabel(label, options, bidiDomain, errors);
  return { labels, trailingRootDot, errors };
}

function joinDomain(labels: readonly string[], trailingRootDot: boolean): string {
  const domain = labels.join(".");
  return trailingRootDot ? `${domain}.` : domain;
}

function asciiLabels(processed: ProcessedDomain): string[] {
  return processed.labels.map((label) => {
    if (hasOnlyAscii(label)) return label;
    const encoded = encodePunycodeLabel(label);
    if (encoded === null) {
      processed.errors.add("punycode");
      return label;
    }
    return `xn--${encoded}`;
  });
}

function validateDnsLength(labels: readonly string[], errors: Set<IdnaError>): void {
  const domain = labels.join(".");
  if (domain.length < 1 || domain.length > 253) errors.add("dns-length");
  for (const label of labels) {
    if (label.length < 1 || label.length > 63) errors.add("dns-length");
  }
}

/** UTS 46 revision 35 ToUnicode, nontransitional processing. */
export function uts46ToUnicode(input: string, options?: IdnaOptions): IdnaResult {
  const resolved = resolveOptions(options);
  const processed = processDomain(input, resolved);
  return result(joinDomain(processed.labels, processed.trailingRootDot), processed.errors);
}

/** UTS 46 revision 35 ToASCII, nontransitional processing. */
export function uts46ToAscii(input: string, options?: IdnaOptions): IdnaResult {
  const resolved = resolveOptions(options);
  const processed = processDomain(input, resolved);
  const labels = asciiLabels(processed);
  if (resolved.verifyDnsLength) validateDnsLength(labels, processed.errors);
  return result(joinDomain(labels, processed.trailingRootDot), processed.errors);
}

/** Strict product helper: return a DNS-ready ASCII domain or fail closed. */
export function toAsciiDomain(input: string): string | null {
  const converted = uts46ToAscii(input);
  return converted.valid ? converted.value : null;
}

/** Strict product helper: return Unicode only if its ASCII round-trip is valid. */
export function toUnicodeDomain(input: string): string | null {
  const converted = uts46ToUnicode(input);
  if (!converted.valid) return null;
  const roundTrip = uts46ToAscii(converted.value);
  return roundTrip.valid ? converted.value : null;
}
