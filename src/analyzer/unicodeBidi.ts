import { bidiClass, bidiMirror, pairedBracket } from "./unicodeData";
import { unicodeCodePoints, unicodeString } from "./unicodeNormalize";

type BidiType = ReturnType<typeof bidiClass>;

interface BidiUnit {
  readonly point: number;
  readonly originalType: BidiType;
  type: BidiType;
  level: number;
}

interface BracketPair {
  readonly opening: number;
  readonly closing: number;
}

interface BracketStackEntry {
  readonly closingPoint: number;
  readonly position: number;
}

const UNSUPPORTED_PROFILE_TYPES = new Set<BidiType>([
  "B",
  "S",
  "WS",
  "LRE",
  "RLE",
  "LRO",
  "RLO",
  "PDF",
  "LRI",
  "RLI",
  "FSI",
  "PDI",
]);

const NEUTRAL_TYPES = new Set<BidiType>([
  "B",
  "S",
  "WS",
  "ON",
  "LRI",
  "RLI",
  "FSI",
  "PDI",
]);

function resolveWeakTypes(units: BidiUnit[]): void {
  // W1
  let previousType: BidiType = "L";
  for (const unit of units) {
    if (unit.type === "NSM") unit.type = previousType;
    previousType = unit.type;
  }

  // W2
  let previousStrong: BidiType = "L";
  for (const unit of units) {
    if (unit.type === "EN" && previousStrong === "AL") unit.type = "AN";
    if (unit.type === "R" || unit.type === "L" || unit.type === "AL") {
      previousStrong = unit.type;
    }
  }

  // W3
  for (const unit of units) {
    if (unit.type === "AL") unit.type = "R";
  }

  // W4
  for (let index = 1; index + 1 < units.length; index += 1) {
    const previous = units[index - 1]!;
    const current = units[index]!;
    const next = units[index + 1]!;
    if (current.type === "ES" && previous.type === "EN" && next.type === "EN") {
      current.type = "EN";
    } else if (
      current.type === "CS" &&
      previous.type === next.type &&
      (previous.type === "EN" || previous.type === "AN")
    ) {
      current.type = previous.type;
    }
  }

  // W5
  let index = 0;
  while (index < units.length) {
    if (units[index]!.type !== "ET") {
      index += 1;
      continue;
    }
    const start = index;
    while (index < units.length && units[index]!.type === "ET") index += 1;
    const before = start === 0 ? "L" : units[start - 1]!.type;
    const after = index === units.length ? "L" : units[index]!.type;
    if (before === "EN" || after === "EN") {
      for (let cursor = start; cursor < index; cursor += 1) {
        units[cursor]!.type = "EN";
      }
    }
  }

  // W6
  for (const unit of units) {
    if (unit.type === "ES" || unit.type === "ET" || unit.type === "CS") {
      unit.type = "ON";
    }
  }

  // W7
  previousStrong = "L";
  for (const unit of units) {
    if (unit.type === "EN" && previousStrong === "L") unit.type = "L";
    if (unit.type === "L" || unit.type === "R") previousStrong = unit.type;
  }
}

function canonicalClosingBracket(point: number): number {
  return point === 0x232a ? 0x3009 : point;
}

function bracketPairs(units: readonly BidiUnit[]): readonly BracketPair[] {
  const stack: BracketStackEntry[] = [];
  const pairs: BracketPair[] = [];

  for (let position = 0; position < units.length; position += 1) {
    const unit = units[position]!;
    if (unit.type !== "ON") continue;
    const bracket = pairedBracket(unit.point);
    if (bracket === null) continue;

    if (bracket.type === "open") {
      // BD16 requires an empty result after a 64th nested opening bracket.
      if (stack.length === 63) return [];
      stack.push({ closingPoint: bracket.codePoint, position });
      continue;
    }

    const closingPoint = canonicalClosingBracket(unit.point);
    let match = stack.length - 1;
    while (
      match >= 0 &&
      canonicalClosingBracket(stack[match]!.closingPoint) !== closingPoint
    ) {
      match -= 1;
    }
    if (match < 0) continue;
    pairs.push({ opening: stack[match]!.position, closing: position });
    stack.length = match;
  }

  return pairs.sort((left, right) => left.opening - right.opening);
}

function strongDirection(type: BidiType): "L" | "R" | null {
  if (type === "L") return "L";
  if (type === "R" || type === "EN" || type === "AN") return "R";
  return null;
}

function matchFollowingMarks(
  units: BidiUnit[],
  bracketPosition: number,
  direction: "L" | "R",
): void {
  let position = bracketPosition + 1;
  while (position < units.length && units[position]!.originalType === "NSM") {
    units[position]!.type = direction;
    position += 1;
  }
}

function resolveBracketPairs(units: BidiUnit[]): void {
  // N0, with embedding direction L because HL1 fixes the paragraph level to 0.
  for (const pair of bracketPairs(units)) {
    let hasLeft = false;
    let hasRight = false;
    for (let position = pair.opening + 1; position < pair.closing; position += 1) {
      const direction = strongDirection(units[position]!.type);
      hasLeft ||= direction === "L";
      hasRight ||= direction === "R";
    }

    let resolved: "L" | "R" | null = null;
    if (hasLeft) {
      resolved = "L";
    } else if (hasRight) {
      let preceding: "L" | "R" = "L";
      for (let position = pair.opening - 1; position >= 0; position -= 1) {
        const direction = strongDirection(units[position]!.type);
        if (direction !== null) {
          preceding = direction;
          break;
        }
      }
      resolved = preceding === "R" ? "R" : "L";
    }

    if (resolved === null) continue;
    units[pair.opening]!.type = resolved;
    units[pair.closing]!.type = resolved;
    matchFollowingMarks(units, pair.opening, resolved);
    matchFollowingMarks(units, pair.closing, resolved);
  }
}

function resolveNeutralTypes(units: BidiUnit[]): void {
  // N1 and N2. All explicit embedding levels are zero in this profile.
  let index = 0;
  while (index < units.length) {
    if (!NEUTRAL_TYPES.has(units[index]!.type)) {
      index += 1;
      continue;
    }
    const start = index;
    while (index < units.length && NEUTRAL_TYPES.has(units[index]!.type)) index += 1;

    const before = start === 0 ? "L" : strongDirection(units[start - 1]!.type);
    const after = index === units.length ? "L" : strongDirection(units[index]!.type);
    const resolved = before !== null && before === after ? before : "L";
    for (let position = start; position < index; position += 1) {
      units[position]!.type = resolved;
    }
  }
}

function resolveImplicitLevels(units: BidiUnit[]): void {
  // I1. I2 is unreachable because the profile has no explicit odd level.
  for (const unit of units) {
    if (unit.type === "R") unit.level = 1;
    else if (unit.type === "EN" || unit.type === "AN") unit.level = 2;
  }
}

function reverseRange(units: BidiUnit[], start: number, end: number): void {
  let left = start;
  let right = end;
  while (left < right) {
    const temporary = units[left]!;
    units[left] = units[right]!;
    units[right] = temporary;
    left += 1;
    right -= 1;
  }
}

function reorderByLevel(units: readonly BidiUnit[]): BidiUnit[] {
  const visual = [...units];
  const highestLevel = visual.reduce(
    (highest, unit) => Math.max(highest, unit.level),
    0,
  );

  // L2. The lowest odd level is one because HL1 fixes the paragraph level to 0.
  for (let level = highestLevel; level >= 1; level -= 1) {
    let index = 0;
    while (index < visual.length) {
      if (visual[index]!.level < level) {
        index += 1;
        continue;
      }
      const start = index;
      while (index < visual.length && visual[index]!.level >= level) index += 1;
      reverseRange(visual, start, index - 1);
    }
  }
  return visual;
}

function moveCombiningMarksAfterBases(units: BidiUnit[]): void {
  // UTS 39 requires L3's logical mark order for skeleton construction.
  let index = 0;
  while (index < units.length) {
    if (units[index]!.originalType !== "NSM") {
      index += 1;
      continue;
    }
    const start = index;
    while (index < units.length && units[index]!.originalType === "NSM") index += 1;
    if (index < units.length && units[index]!.level % 2 === 1) {
      reverseRange(units, start, index);
      index += 1;
    }
  }
}

/**
 * Reorders one UTS 46-processed label for UTS 39 bidiSkeleton(LTR, X).
 *
 * This is deliberately not a general-purpose UBA implementation. Successful
 * UTS 46 label processing cannot emit paragraph/segment/whitespace separators,
 * explicit embeddings or overrides, or isolate controls. With HL1 fixing the
 * paragraph level to zero, that subset has one level run and one isolating run;
 * X1-X8 and X10 are therefore identity operations. BN is removed by X9 below.
 * Inputs outside that proven subset are rejected. The remaining W1-W7,
 * BD16/N0-N2, I1, L2, L3, and L4 operations are applied without approximation.
 */
export function reorderUts46LabelForLtrSkeleton(label: string): string {
  const units: BidiUnit[] = [];
  for (const point of unicodeCodePoints(label)) {
    const originalType = bidiClass(point);
    if (UNSUPPORTED_PROFILE_TYPES.has(originalType)) {
      throw new RangeError(
        "UTS 39 LTR skeleton input is outside the processed-label bidi profile",
      );
    }
    if (originalType === "BN") continue;
    units.push({ point, originalType, type: originalType, level: 0 });
  }

  resolveWeakTypes(units);
  resolveBracketPairs(units);
  resolveNeutralTypes(units);
  resolveImplicitLevels(units);
  const visual = reorderByLevel(units);
  moveCombiningMarksAfterBases(visual);

  return unicodeString(
    visual.map((unit) => {
      if (unit.level % 2 === 0) return unit.point;
      return bidiMirror(unit.point) ?? unit.point;
    }),
  );
}
