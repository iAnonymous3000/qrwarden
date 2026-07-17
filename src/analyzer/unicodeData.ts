import {
  UNICODE_SNAPSHOT,
  type PackedUnicodeRows,
  type PackedUnicodeSequences,
} from "../data/unicodeSnapshot";

const MAX_CODE_POINT = 0x10ffff;
const EMPTY_SEQUENCE: readonly number[] = Object.freeze([]);

export type IdnaStatus = (typeof UNICODE_SNAPSHOT.idnaStatuses)[number];
export type BidiClass = (typeof UNICODE_SNAPSHOT.bidiClasses)[number];
export type JoiningType = (typeof UNICODE_SNAPSHOT.joiningTypes)[number];
export type ScriptCode = string;

export interface IdnaEntry {
  readonly status: IdnaStatus;
  readonly mapping: readonly number[];
}

export interface PairedBracket {
  readonly codePoint: number;
  readonly type: "open" | "close";
}

export const UNICODE_DATA_METADATA = Object.freeze({
  unicodeVersion: UNICODE_SNAPSHOT.unicodeVersion,
  uts39Revision: UNICODE_SNAPSHOT.uts39Revision,
  uts46Revision: UNICODE_SNAPSHOT.uts46Revision,
  captured: UNICODE_SNAPSHOT.captured,
  sourceSetSha256: UNICODE_SNAPSHOT.sourceSetSha256,
  completeness: UNICODE_SNAPSHOT.completeness,
});

interface DecodedRanges {
  readonly starts: Uint32Array;
  readonly ends: Uint32Array;
  readonly values: readonly Uint32Array[];
}

class PackedReader {
  readonly #bytes: Uint8Array;
  #offset = 0;

  constructor(base64: string, label: string) {
    if (
      base64.length % 4 !== 0 ||
      !/^(?:[A-Za-z\d+/]{4})*(?:[A-Za-z\d+/]{2}==|[A-Za-z\d+/]{3}=)?$/.test(
        base64,
      )
    ) {
      throw new Error(`${label} has invalid base64`);
    }
    const binary = atob(base64);
    this.#bytes = Uint8Array.from(binary, (character) =>
      character.charCodeAt(0),
    );
  }

  unsigned(label: string): number {
    let value = 0;
    let multiplier = 1;
    let byteCount = 0;

    while (true) {
      const byte = this.#bytes[this.#offset];
      if (byte === undefined) throw new Error(`${label} is truncated`);
      this.#offset += 1;
      byteCount += 1;
      value += (byte & 0x7f) * multiplier;
      if (!Number.isSafeInteger(value))
        throw new Error(`${label} exceeds safe integer range`);
      if ((byte & 0x80) === 0) {
        if (byteCount > 1 && byte === 0)
          throw new Error(`${label} is not canonical ULEB128`);
        return value;
      }
      if (byteCount >= 8)
        throw new Error(`${label} has an overlong ULEB128 value`);
      multiplier *= 128;
    }
  }

  finish(label: string): void {
    if (this.#offset !== this.#bytes.length)
      throw new Error(`${label} has trailing bytes`);
  }
}

function decodeRanges(
  packed: PackedUnicodeRows,
  expectedColumns: number,
  label: string,
): DecodedRanges {
  if (packed.encoding !== "delta-uleb128-v1") {
    throw new Error(`${label} has unsupported encoding ${JSON.stringify(packed.encoding)}`);
  }
  if (packed.valueColumns !== expectedColumns) {
    throw new Error(
      `${label} has ${packed.valueColumns} value columns, expected ${expectedColumns}`,
    );
  }
  const reader = new PackedReader(packed.base64, label);
  const starts = new Uint32Array(packed.rowCount);
  const ends = new Uint32Array(packed.rowCount);
  const values = Array.from(
    { length: expectedColumns },
    () => new Uint32Array(packed.rowCount),
  );
  let previousEnd = -1;

  for (let row = 0; row < packed.rowCount; row += 1) {
    const start =
      previousEnd + 1 + reader.unsigned(`${label} row ${row + 1} start`);
    const end = start + reader.unsigned(`${label} row ${row + 1} length`);
    if (start <= previousEnd || end < start || end > MAX_CODE_POINT) {
      throw new Error(`${label} row ${row + 1} has an invalid range`);
    }
    starts[row] = start;
    ends[row] = end;
    for (let column = 0; column < expectedColumns; column += 1) {
      const value = reader.unsigned(
        `${label} row ${row + 1} value ${column + 1}`,
      );
      if (value > MAX_CODE_POINT) {
        throw new Error(
          `${label} row ${row + 1} value ${column + 1} is too large`,
        );
      }
      values[column]![row] = value;
    }
    previousEnd = end;
  }
  reader.finish(label);
  return Object.freeze({ starts, ends, values: Object.freeze(values) });
}

function decodeSequences(
  packed: PackedUnicodeSequences,
  label: string,
): readonly (readonly number[])[] {
  if (packed.encoding !== "length-uleb128-v1") {
    throw new Error(`${label} has unsupported encoding ${JSON.stringify(packed.encoding)}`);
  }
  const reader = new PackedReader(packed.base64, label);
  const sequences: (readonly number[])[] = [EMPTY_SEQUENCE];
  for (let index = 0; index < packed.sequenceCount; index += 1) {
    const length = reader.unsigned(`${label} sequence ${index + 1} length`);
    if (length === 0)
      throw new Error(`${label} sequence ${index + 1} is empty`);
    if (length > MAX_CODE_POINT)
      throw new Error(`${label} sequence ${index + 1} is too long`);
    const sequence: number[] = [];
    for (let offset = 0; offset < length; offset += 1) {
      const value = reader.unsigned(
        `${label} sequence ${index + 1} value ${offset + 1}`,
      );
      if (value > MAX_CODE_POINT) {
        throw new Error(
          `${label} sequence ${index + 1} value ${offset + 1} is too large`,
        );
      }
      sequence.push(value);
    }
    sequences.push(Object.freeze(sequence));
  }
  reader.finish(label);
  return Object.freeze(sequences);
}

function decodeTuples(
  packed: PackedUnicodeRows,
  expectedColumns: number,
  label: string,
): Uint32Array {
  if (packed.encoding !== "uleb128-tuples-v1") {
    throw new Error(`${label} has unsupported encoding ${JSON.stringify(packed.encoding)}`);
  }
  if (packed.valueColumns !== expectedColumns) {
    throw new Error(
      `${label} has ${packed.valueColumns} value columns, expected ${expectedColumns}`,
    );
  }
  const reader = new PackedReader(packed.base64, label);
  const values = new Uint32Array(packed.rowCount * expectedColumns);
  for (let index = 0; index < values.length; index += 1) {
    const value = reader.unsigned(`${label} value ${index + 1}`);
    if (value > MAX_CODE_POINT)
      throw new Error(`${label} value ${index + 1} is too large`);
    values[index] = value;
  }
  reader.finish(label);
  return values;
}

function findRange(ranges: DecodedRanges, codePoint: number): number {
  let lower = 0;
  let upper = ranges.starts.length - 1;
  while (lower <= upper) {
    const middle = lower + Math.floor((upper - lower) / 2);
    const start = ranges.starts[middle]!;
    if (codePoint < start) {
      upper = middle - 1;
    } else if (codePoint > ranges.ends[middle]!) {
      lower = middle + 1;
    } else {
      return middle;
    }
  }
  return -1;
}

function assertScalar(codePoint: number): void {
  if (
    !Number.isInteger(codePoint) ||
    codePoint < 0 ||
    codePoint > MAX_CODE_POINT ||
    (codePoint >= 0xd800 && codePoint <= 0xdfff)
  ) {
    throw new RangeError("Unicode data lookup requires a Unicode scalar value");
  }
}

function sequenceAt(
  sequences: readonly (readonly number[])[],
  identifier: number,
  label: string,
): readonly number[] {
  const sequence = sequences[identifier];
  if (sequence === undefined)
    throw new Error(`${label} references missing sequence ${identifier}`);
  return sequence;
}

let idnaRangesCache: DecodedRanges | undefined;
let idnaMappingsCache: readonly (readonly number[])[] | undefined;
const idnaEntryCache = new Map<number, IdnaEntry>();

function idnaRanges(): DecodedRanges {
  return (idnaRangesCache ??= decodeRanges(
    UNICODE_SNAPSHOT.tables.idnaRanges,
    2,
    "IDNA ranges",
  ));
}

function idnaMappings(): readonly (readonly number[])[] {
  return (idnaMappingsCache ??= decodeSequences(
    UNICODE_SNAPSHOT.tables.idnaMappings,
    "IDNA mappings",
  ));
}

export function idnaEntry(codePoint: number): IdnaEntry {
  assertScalar(codePoint);
  const ranges = idnaRanges();
  const row = findRange(ranges, codePoint);
  if (row < 0)
    throw new Error(`IDNA data does not cover U+${codePoint.toString(16)}`);
  const statusIndex = ranges.values[0]![row]!;
  const mappingIdentifier = ranges.values[1]![row]!;
  const status = UNICODE_SNAPSHOT.idnaStatuses[statusIndex];
  if (status === undefined)
    throw new Error(`IDNA data references missing status ${statusIndex}`);
  const mapping = sequenceAt(idnaMappings(), mappingIdentifier, "IDNA data");
  const key =
    statusIndex * (UNICODE_SNAPSHOT.tables.idnaMappings.sequenceCount + 1) +
    mappingIdentifier;
  let entry = idnaEntryCache.get(key);
  if (entry === undefined) {
    entry = Object.freeze({
      status,
      mapping,
    });
    idnaEntryCache.set(key, entry);
  }
  return entry;
}

let combiningClassRangesCache: DecodedRanges | undefined;

export function canonicalCombiningClass(codePoint: number): number {
  assertScalar(codePoint);
  const ranges = (combiningClassRangesCache ??= decodeRanges(
    UNICODE_SNAPSHOT.tables.combiningClassRanges,
    1,
    "canonical combining classes",
  ));
  const row = findRange(ranges, codePoint);
  return row < 0 ? 0 : ranges.values[0]![row]!;
}

let decompositionRangesCache: DecodedRanges | undefined;
let decompositionPoolCache: readonly (readonly number[])[] | undefined;

export function canonicalDecomposition(
  codePoint: number,
): readonly number[] | null {
  assertScalar(codePoint);
  const ranges = (decompositionRangesCache ??= decodeRanges(
    UNICODE_SNAPSHOT.tables.canonicalDecompositions,
    1,
    "canonical decompositions",
  ));
  const row = findRange(ranges, codePoint);
  if (row < 0) return null;
  decompositionPoolCache ??= decodeSequences(
    UNICODE_SNAPSHOT.tables.canonicalDecompositionPool,
    "canonical decomposition pool",
  );
  return sequenceAt(
    decompositionPoolCache,
    ranges.values[0]![row]!,
    "canonical decomposition data",
  );
}

let compositionsCache: Uint32Array | undefined;

export function canonicalComposition(
  starter: number,
  combining: number,
): number | null {
  assertScalar(starter);
  assertScalar(combining);
  const tuples = (compositionsCache ??= decodeTuples(
    UNICODE_SNAPSHOT.tables.canonicalCompositions,
    3,
    "canonical compositions",
  ));
  let lower = 0;
  let upper = UNICODE_SNAPSHOT.tables.canonicalCompositions.rowCount - 1;
  while (lower <= upper) {
    const middle = lower + Math.floor((upper - lower) / 2);
    const offset = middle * 3;
    const candidateStarter = tuples[offset]!;
    const candidateCombining = tuples[offset + 1]!;
    if (
      starter < candidateStarter ||
      (starter === candidateStarter && combining < candidateCombining)
    ) {
      upper = middle - 1;
    } else if (
      starter > candidateStarter ||
      (starter === candidateStarter && combining > candidateCombining)
    ) {
      lower = middle + 1;
    } else {
      return tuples[offset + 2]!;
    }
  }
  return null;
}

function booleanRangeAccessor(
  packed: PackedUnicodeRows,
  label: string,
): (codePoint: number) => boolean {
  let cache: DecodedRanges | undefined;
  return (codePoint) => {
    assertScalar(codePoint);
    cache ??= decodeRanges(packed, 0, label);
    return findRange(cache, codePoint) >= 0;
  };
}

export const isMark = booleanRangeAccessor(
  UNICODE_SNAPSHOT.tables.markRanges,
  "Mark ranges",
);
export const isDefaultIgnorable = booleanRangeAccessor(
  UNICODE_SNAPSHOT.tables.defaultIgnorableRanges,
  "Default_Ignorable_Code_Point ranges",
);
export const isIdentifierAllowed = booleanRangeAccessor(
  UNICODE_SNAPSHOT.tables.identifierAllowedRanges,
  "IdentifierStatus Allowed ranges",
);

const scriptSingletons: readonly (readonly ScriptCode[])[] = Object.freeze(
  UNICODE_SNAPSHOT.scriptNames.map((script) => Object.freeze([script])),
);
const unknownScriptIndex = UNICODE_SNAPSHOT.scriptNames.indexOf("Zzzz");
if (unknownScriptIndex < 0)
  throw new Error("Unicode script data lacks Unknown (Zzzz)");
let scriptRangesCache: DecodedRanges | undefined;
let scriptExtensionRangesCache: DecodedRanges | undefined;
let scriptSetsCache: readonly (readonly ScriptCode[])[] | undefined;

function scriptSets(): readonly (readonly ScriptCode[])[] {
  if (scriptSetsCache !== undefined) return scriptSetsCache;
  const numericSets = decodeSequences(
    UNICODE_SNAPSHOT.tables.scriptSets,
    "script sets",
  );
  scriptSetsCache = Object.freeze(
    numericSets.map((set, setIndex) => {
      if (setIndex === 0) return Object.freeze([]);
      return Object.freeze(
        set.map((scriptIndex) => {
          const script = UNICODE_SNAPSHOT.scriptNames[scriptIndex];
          if (script === undefined) {
            throw new Error(
              `script set ${setIndex} references missing script ${scriptIndex}`,
            );
          }
          return script;
        }),
      );
    }),
  );
  return scriptSetsCache;
}

export function scriptExtensions(codePoint: number): readonly ScriptCode[] {
  assertScalar(codePoint);
  const extensionRanges = (scriptExtensionRangesCache ??= decodeRanges(
    UNICODE_SNAPSHOT.tables.scriptExtensionRanges,
    1,
    "Script_Extensions ranges",
  ));
  const extensionRow = findRange(extensionRanges, codePoint);
  if (extensionRow >= 0) {
    const set = scriptSets()[extensionRanges.values[0]![extensionRow]!];
    if (set === undefined)
      throw new Error("Script_Extensions references a missing script set");
    return set;
  }

  const ranges = (scriptRangesCache ??= decodeRanges(
    UNICODE_SNAPSHOT.tables.scriptRanges,
    1,
    "Script ranges",
  ));
  const row = findRange(ranges, codePoint);
  const scriptIndex = row < 0 ? unknownScriptIndex : ranges.values[0]![row]!;
  const singleton = scriptSingletons[scriptIndex];
  if (singleton === undefined)
    throw new Error(`Script data references missing script ${scriptIndex}`);
  return singleton;
}

let bidiClassRangesCache: DecodedRanges | undefined;

export function bidiClass(codePoint: number): BidiClass {
  assertScalar(codePoint);
  const ranges = (bidiClassRangesCache ??= decodeRanges(
    UNICODE_SNAPSHOT.tables.bidiClassRanges,
    1,
    "Bidi_Class ranges",
  ));
  const row = findRange(ranges, codePoint);
  if (row < 0)
    throw new Error(
      `Bidi_Class data does not cover U+${codePoint.toString(16)}`,
    );
  const value = UNICODE_SNAPSHOT.bidiClasses[ranges.values[0]![row]!];
  if (value === undefined)
    throw new Error("Bidi_Class data references a missing class");
  return value;
}

let joiningTypeRangesCache: DecodedRanges | undefined;

export function joiningType(codePoint: number): JoiningType {
  assertScalar(codePoint);
  const ranges = (joiningTypeRangesCache ??= decodeRanges(
    UNICODE_SNAPSHOT.tables.joiningTypeRanges,
    1,
    "Joining_Type ranges",
  ));
  const row = findRange(ranges, codePoint);
  if (row < 0) return "U";
  const value = UNICODE_SNAPSHOT.joiningTypes[ranges.values[0]![row]!];
  if (value === undefined)
    throw new Error("Joining_Type data references a missing type");
  return value;
}

let bidiMirrorsCache: DecodedRanges | undefined;

export function bidiMirror(codePoint: number): number | null {
  assertScalar(codePoint);
  const ranges = (bidiMirrorsCache ??= decodeRanges(
    UNICODE_SNAPSHOT.tables.bidiMirrors,
    1,
    "Bidi_Mirroring pairs",
  ));
  const row = findRange(ranges, codePoint);
  return row < 0 ? null : ranges.values[0]![row]!;
}

let pairedBracketsCache: DecodedRanges | undefined;

export function pairedBracket(codePoint: number): PairedBracket | null {
  assertScalar(codePoint);
  const ranges = (pairedBracketsCache ??= decodeRanges(
    UNICODE_SNAPSHOT.tables.pairedBrackets,
    2,
    "Bidi paired brackets",
  ));
  const row = findRange(ranges, codePoint);
  if (row < 0) return null;
  const typeValue = ranges.values[1]![row]!;
  if (typeValue !== 1 && typeValue !== 2) {
    throw new Error(`Bidi paired bracket has invalid type ${typeValue}`);
  }
  return Object.freeze({
    codePoint: ranges.values[0]![row]!,
    type: typeValue === 1 ? "open" : "close",
  });
}

let confusableRangesCache: DecodedRanges | undefined;
let confusablePoolCache: readonly (readonly number[])[] | undefined;

export function confusablePrototype(
  codePoint: number,
): readonly number[] | null {
  assertScalar(codePoint);
  const ranges = (confusableRangesCache ??= decodeRanges(
    UNICODE_SNAPSHOT.tables.confusables,
    1,
    "confusable mappings",
  ));
  const row = findRange(ranges, codePoint);
  if (row < 0) return null;
  confusablePoolCache ??= decodeSequences(
    UNICODE_SNAPSHOT.tables.confusablePrototypes,
    "confusable prototypes",
  );
  return sequenceAt(
    confusablePoolCache,
    ranges.values[0]![row]!,
    "confusable mappings",
  );
}
