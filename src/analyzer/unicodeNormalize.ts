import {
  canonicalCombiningClass,
  canonicalComposition,
  canonicalDecomposition,
} from "./unicodeData";

const S_BASE = 0xac00;
const L_BASE = 0x1100;
const V_BASE = 0x1161;
const T_BASE = 0x11a7;
const L_COUNT = 19;
const V_COUNT = 21;
const T_COUNT = 28;
const N_COUNT = V_COUNT * T_COUNT;
const S_COUNT = L_COUNT * N_COUNT;

function isUnicodeScalar(point: number): boolean {
  return point >= 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff);
}

export function unicodeCodePoints(value: string): readonly number[] {
  const points: number[] = [];
  for (const character of value) {
    const point = character.codePointAt(0);
    if (point === undefined || !isUnicodeScalar(point)) {
      throw new RangeError("Unicode normalization input contains an unpaired surrogate");
    }
    points.push(point);
  }
  return points;
}

export function unicodeString(points: readonly number[]): string {
  const characters: string[] = [];
  for (const point of points) {
    if (!isUnicodeScalar(point)) {
      throw new RangeError("Unicode output contains a non-scalar value");
    }
    characters.push(String.fromCodePoint(point));
  }
  return characters.join("");
}

function decomposeHangul(point: number): readonly number[] | null {
  const syllableIndex = point - S_BASE;
  if (syllableIndex < 0 || syllableIndex >= S_COUNT) return null;
  const leading = L_BASE + Math.floor(syllableIndex / N_COUNT);
  const vowel = V_BASE + Math.floor((syllableIndex % N_COUNT) / T_COUNT);
  const trailingIndex = syllableIndex % T_COUNT;
  return trailingIndex === 0
    ? [leading, vowel]
    : [leading, vowel, T_BASE + trailingIndex];
}

function appendCanonicalDecomposition(point: number, output: number[]): void {
  const decomposition = decomposeHangul(point) ?? canonicalDecomposition(point);
  if (decomposition === null) {
    output.push(point);
    return;
  }
  for (const decomposed of decomposition) appendCanonicalDecomposition(decomposed, output);
}

function canonicalOrder(points: readonly number[]): number[] {
  const ordered: number[] = [];
  for (const point of points) {
    ordered.push(point);
    const currentClass = canonicalCombiningClass(point);
    if (currentClass === 0) continue;

    let cursor = ordered.length - 1;
    while (cursor > 0) {
      const previousClass = canonicalCombiningClass(ordered[cursor - 1]!);
      if (previousClass === 0 || previousClass <= currentClass) break;
      ordered[cursor] = ordered[cursor - 1]!;
      ordered[cursor - 1] = point;
      cursor -= 1;
    }
  }
  return ordered;
}

function nfdCodePoints(value: string): number[] {
  const decomposed: number[] = [];
  for (const point of unicodeCodePoints(value)) {
    appendCanonicalDecomposition(point, decomposed);
  }
  return canonicalOrder(decomposed);
}

function composeHangul(starter: number, combining: number): number | null {
  const leadingIndex = starter - L_BASE;
  if (leadingIndex >= 0 && leadingIndex < L_COUNT) {
    const vowelIndex = combining - V_BASE;
    if (vowelIndex >= 0 && vowelIndex < V_COUNT) {
      return S_BASE + (leadingIndex * V_COUNT + vowelIndex) * T_COUNT;
    }
  }

  const syllableIndex = starter - S_BASE;
  if (
    syllableIndex >= 0 &&
    syllableIndex < S_COUNT &&
    syllableIndex % T_COUNT === 0
  ) {
    const trailingIndex = combining - T_BASE;
    if (trailingIndex > 0 && trailingIndex < T_COUNT) return starter + trailingIndex;
  }
  return null;
}

function composePair(starter: number, combining: number): number | null {
  return composeHangul(starter, combining) ?? canonicalComposition(starter, combining);
}

/** Unicode 17 canonical decomposition, independent of the host runtime tables. */
export function normalizeNfd(value: string): string {
  return unicodeString(nfdCodePoints(value));
}

/** Unicode 17 canonical composition, including algorithmic Hangul composition. */
export function normalizeNfc(value: string): string {
  const decomposed = nfdCodePoints(value);
  if (decomposed.length === 0) return "";

  const composed: number[] = [decomposed[0]!];
  let starterPosition = 0;
  let starter = decomposed[0]!;
  let previousClass = canonicalCombiningClass(starter);

  for (let index = 1; index < decomposed.length; index += 1) {
    const point = decomposed[index]!;
    const pointClass = canonicalCombiningClass(point);
    const composite = composePair(starter, point);
    if (composite !== null && (previousClass === 0 || previousClass < pointClass)) {
      composed[starterPosition] = composite;
      starter = composite;
      continue;
    }

    if (pointClass === 0) {
      starterPosition = composed.length;
      starter = point;
    }
    composed.push(point);
    previousClass = pointClass;
  }
  return unicodeString(composed);
}

export function isNormalizedNfc(value: string): boolean {
  return normalizeNfc(value) === value;
}
