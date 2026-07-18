import {
  canonicalDecomposition,
  confusablePrototype,
  isDefaultIgnorable,
  isIdentifierAllowed,
  scriptExtensions,
} from "./unicodeData";
import { reorderUts46LabelForLtrSkeleton } from "./unicodeBidi";
import {
  normalizeNfc,
  normalizeNfd,
  unicodeCodePoints,
  unicodeString,
} from "./unicodeNormalize";

const HOST_PROFILE_EXCEPTIONS = new Set([0x002d, 0x002e]);
const HIGHLY_RESTRICTIVE_CJK_SCRIPTS = ["Jpan", "Hanb", "Kore"] as const;

export function isForbiddenCharacter(value: string): boolean {
  const point = value.codePointAt(0);
  if (point === undefined) return false;
  return (
    point <= 0x1f ||
    (point >= 0x7f && point <= 0x9f) ||
    (point >= 0xd800 && point <= 0xdfff) ||
    (point >= 0x2028 && point <= 0x2029) ||
    // Unicode intentionally excludes these annotation controls from
    // Default_Ignorable_Code_Point, but they remain unsafe to render inline.
    (point >= 0xfff9 && point <= 0xfffb) ||
    isDefaultIgnorable(point)
  );
}

export function forbiddenCharacters(value: string): readonly string[] {
  const found: string[] = [];
  for (const character of value) {
    if (isForbiddenCharacter(character) && !found.includes(character)) {
      found.push(character);
    }
  }
  return found;
}

export function escapeCodePoint(character: string): string {
  const point = character.codePointAt(0) ?? 0;
  return `U+${point.toString(16).toUpperCase().padStart(4, "0")}`;
}

export function escapeForbiddenForDisplay(value: string): string {
  let escaped = "";
  for (const character of value) {
    escaped += isForbiddenCharacter(character)
      ? `[${escapeCodePoint(character)}]`
      : character;
  }
  return escaped;
}

function isAscii(value: string): boolean {
  return unicodeCodePoints(value).every((point) => point <= 0x7f);
}

function augmentedScriptSet(point: number): ReadonlySet<string> | null {
  const scripts = new Set<string>(scriptExtensions(point));
  if (scripts.has("Zyyy") || scripts.has("Zinh")) return null;

  if (scripts.has("Hani")) {
    scripts.add("Hanb");
    scripts.add("Jpan");
    scripts.add("Kore");
  }
  if (scripts.has("Hira") || scripts.has("Kana")) scripts.add("Jpan");
  if (scripts.has("Hang")) scripts.add("Kore");
  if (scripts.has("Bopo")) scripts.add("Hanb");
  return scripts;
}

function isCoveredBy(soss: readonly ReadonlySet<string>[], script: string): boolean {
  return soss.every((entry) => entry.has("Latn") || entry.has(script));
}

const canonicalProfileMemo = new Map<number, boolean>();

function isCanonicallyProfileAllowed(point: number): boolean {
  if (HOST_PROFILE_EXCEPTIONS.has(point) || isIdentifierAllowed(point)) return true;
  const memoized = canonicalProfileMemo.get(point);
  if (memoized !== undefined) return memoized;

  const decomposition = canonicalDecomposition(point);
  const allowed =
    decomposition !== null && decomposition.every(isCanonicallyProfileAllowed);
  canonicalProfileMemo.set(point, allowed);
  return allowed;
}

/**
 * Returns true when the whole host fails the UTS 39 Highly Restrictive level.
 * Dot and hyphen are the documented syntax exceptions to the General Security
 * Profile for this IDNA-hostname application.
 */
export function hasMixedScripts(hostname: string): boolean {
  const normalized = normalizeNfc(hostname.replace(/\.$/, ""));
  if (isAscii(normalized)) return false;

  const points = unicodeCodePoints(normalized);
  if (points.some((point) => !isCanonicallyProfileAllowed(point))) {
    return true;
  }

  // Common/Inherited characters have augmented set ALL and do not constrain
  // the set of script sets (SOSS). Duplicate entries do not affect either the
  // resolved-set intersection or cover testing, so retaining them is exact.
  const soss = points
    .map(augmentedScriptSet)
    .filter((entry): entry is ReadonlySet<string> => entry !== null);
  if (soss.length === 0) return false;

  const resolved = [...soss[0]!].filter((script) =>
    soss.every((entry) => entry.has(script)),
  );
  if (resolved.length > 0) return false;

  return !HIGHLY_RESTRICTIVE_CJK_SCRIPTS.some((script) =>
    isCoveredBy(soss, script),
  );
}

export function confusableSkeleton(label: string): string {
  const reordered = reorderUts46LabelForLtrSkeleton(label);
  const skeleton: number[] = [];
  for (const point of unicodeCodePoints(normalizeNfd(reordered))) {
    if (isDefaultIgnorable(point)) continue;
    const prototype = confusablePrototype(point);
    if (prototype === null) skeleton.push(point);
    else skeleton.push(...prototype);
  }
  return normalizeNfd(unicodeString(skeleton));
}

export function hasAsciiConfusableLabel(hostname: string): boolean {
  return hostname
    .replace(/\.$/, "")
    .split(".")
    .some((label) => {
      if (isAscii(label)) return false;
      const skeleton = confusableSkeleton(label);
      return isAscii(skeleton) && skeleton !== normalizeNfd(label);
    });
}
