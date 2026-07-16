const BASE = 36;
const T_MIN = 1;
const T_MAX = 26;
const SKEW = 38;
const DAMP = 700;
const INITIAL_BIAS = 72;
const INITIAL_N = 128;
const DELIMITER = "-";
const MAX_CODE_POINT = 0x10ffff;
const MAX_INTEGER = Number.MAX_SAFE_INTEGER;

function digitValue(character: string): number {
  const point = character.codePointAt(0) ?? -1;
  if (point >= 0x30 && point <= 0x39) return point - 0x30 + 26;
  if (point >= 0x41 && point <= 0x5a) return point - 0x41;
  if (point >= 0x61 && point <= 0x7a) return point - 0x61;
  return BASE;
}

function digitCharacter(digit: number): string {
  return String.fromCharCode(digit < 26 ? 0x61 + digit : 0x30 + digit - 26);
}

function threshold(k: number, bias: number): number {
  if (k <= bias + T_MIN) return T_MIN;
  if (k >= bias + T_MAX) return T_MAX;
  return k - bias;
}

function adapt(deltaInput: number, points: number, first: boolean): number {
  let delta = first ? Math.floor(deltaInput / DAMP) : Math.floor(deltaInput / 2);
  delta += Math.floor(delta / points);
  let k = 0;
  while (delta > Math.floor(((BASE - T_MIN) * T_MAX) / 2)) {
    delta = Math.floor(delta / (BASE - T_MIN));
    k += BASE;
  }
  return k + Math.floor(((BASE - T_MIN + 1) * delta) / (delta + SKEW));
}

function isUnicodeScalar(point: number): boolean {
  return point >= 0 && point <= MAX_CODE_POINT && !(point >= 0xd800 && point <= 0xdfff);
}

/** RFC 3492 Punycode decoding for one label, without the `xn--` prefix. */
export function decodePunycodeLabel(input: string): string | null {
  const output: number[] = [];
  const delimiter = input.lastIndexOf(DELIMITER);
  // An encoder can only emit the delimiter after at least one basic code
  // point. Treat a leading delimiter as malformed instead of accepting a
  // non-canonical empty basic segment (for example, `xn---`).
  if (delimiter === 0) return null;
  let cursor = 0;
  if (delimiter >= 0) {
    for (const character of input.slice(0, delimiter)) {
      const point = character.codePointAt(0);
      if (point === undefined || point >= 0x80) return null;
      output.push(point);
    }
    cursor = delimiter + 1;
  }

  let n = INITIAL_N;
  let index = 0;
  let bias = INITIAL_BIAS;
  while (cursor < input.length) {
    const oldIndex = index;
    let weight = 1;
    for (let k = BASE; ; k += BASE) {
      if (cursor >= input.length) return null;
      const digit = digitValue(input[cursor] ?? "");
      cursor += 1;
      if (digit >= BASE || digit > Math.floor((MAX_INTEGER - index) / weight)) {
        return null;
      }
      index += digit * weight;
      const limit = threshold(k, bias);
      if (digit < limit) break;
      const factor = BASE - limit;
      if (weight > Math.floor(MAX_INTEGER / factor)) return null;
      weight *= factor;
    }

    const size = output.length + 1;
    bias = adapt(index - oldIndex, size, oldIndex === 0);
    const increment = Math.floor(index / size);
    if (increment > MAX_CODE_POINT - n) return null;
    n += increment;
    index %= size;
    if (!isUnicodeScalar(n)) return null;
    output.splice(index, 0, n);
    index += 1;
  }

  try {
    return String.fromCodePoint(...output);
  } catch {
    return null;
  }
}

/** RFC 3492 Punycode encoding for one Unicode label, without the `xn--` prefix. */
export function encodePunycodeLabel(input: string): string | null {
  const points: number[] = [];
  for (const character of input) {
    const point = character.codePointAt(0);
    if (point === undefined || !isUnicodeScalar(point)) return null;
    points.push(point);
  }

  let output = "";
  for (const point of points) {
    if (point < 0x80) output += String.fromCodePoint(point);
  }

  const basicCount = output.length;
  let handled = basicCount;
  if (basicCount > 0) output += DELIMITER;

  let n = INITIAL_N;
  let delta = 0;
  let bias = INITIAL_BIAS;
  while (handled < points.length) {
    let next = MAX_CODE_POINT;
    for (const point of points) {
      if (point >= n && point < next) next = point;
    }
    if (next < n) return null;

    const distance = next - n;
    if (distance > Math.floor((MAX_INTEGER - delta) / (handled + 1))) return null;
    delta += distance * (handled + 1);
    n = next;

    for (const point of points) {
      if (point < n) {
        if (delta >= MAX_INTEGER) return null;
        delta += 1;
      }
      if (point !== n) continue;

      let value = delta;
      for (let k = BASE; ; k += BASE) {
        const limit = threshold(k, bias);
        if (value < limit) break;
        const baseMinusLimit = BASE - limit;
        output += digitCharacter(limit + ((value - limit) % baseMinusLimit));
        value = Math.floor((value - limit) / baseMinusLimit);
      }
      output += digitCharacter(value);
      bias = adapt(delta, handled + 1, handled === basicCount);
      delta = 0;
      handled += 1;
    }

    if (handled < points.length) {
      if (delta >= MAX_INTEGER || n >= MAX_CODE_POINT) return null;
      delta += 1;
      n += 1;
    }
  }

  return output;
}
