import { ANALYZER_LIMITS, ReportFields, scalarLength } from "./limits";
import { createReport } from "./report";
import type { AnalysisReport, PayloadKind } from "./types";

interface ParsedField {
  readonly key: string;
  readonly value: string;
}

type EscapeMode = "backslash-newline" | "wifi";

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function structuredValueFits(value: string): boolean {
  return (
    scalarLength(value) <= ANALYZER_LIMITS.fieldScalars &&
    utf8Length(value) <= ANALYZER_LIMITS.expandedBytes
  );
}

const WIFI_ESCAPED_CHARACTERS: ReadonlySet<string> = new Set([
  "\\",
  ";",
  ",",
  '"',
  ":",
]);

function splitEscaped(
  value: string,
  delimiter: string,
  mode: EscapeMode = "backslash-newline",
): string[] | null {
  const fields: string[] = [];
  let current = "";
  let escaped = false;
  let expandedBytes = 0;
  for (const character of value) {
    if (escaped) {
      const decoded =
        mode === "backslash-newline" && (character === "n" || character === "N")
          ? "\n"
          : mode === "wifi" && !WIFI_ESCAPED_CHARACTERS.has(character)
            ? `\\${character}`
            : character;
      current += decoded;
      expandedBytes += utf8Length(decoded);
      escaped = false;
    } else if (character === "\\") {
      escaped = true;
    } else if (character === delimiter) {
      fields.push(current);
      current = "";
      if (fields.length > ANALYZER_LIMITS.logicalFields) return null;
    } else {
      current += character;
      expandedBytes += utf8Length(character);
    }
    if (expandedBytes > ANALYZER_LIMITS.expandedBytes) return null;
  }
  if (escaped) return null;
  fields.push(current);
  return fields.length > ANALYZER_LIMITS.logicalFields ? null : fields;
}

/** First colon outside double quotes, so quoted parameter values stay intact. */
function unquotedColonIndex(value: string): number {
  let quoted = false;
  let index = 0;
  for (const character of value) {
    if (character === '"') quoted = !quoted;
    else if (character === ":" && !quoted) return index;
    index += character.length;
  }
  return -1;
}

function parseDelimitedFields(
  value: string,
  mode: EscapeMode = "backslash-newline",
): ParsedField[] | null {
  const pieces = splitEscaped(value, ";", mode);
  if (pieces === null) return null;
  const result: ParsedField[] = [];
  for (const piece of pieces) {
    if (piece === "") continue;
    const colon = unquotedColonIndex(piece);
    if (colon <= 0) return null;
    result.push({ key: piece.slice(0, colon).toUpperCase(), value: piece.slice(colon + 1) });
  }
  return result;
}

/**
 * Value of the single occurrence of `key`; undefined when absent and null
 * when the key repeats: scanners disagree on which duplicate a handler app
 * would use, so a faithful summary must decline rather than show one value.
 */
function findField(
  fields: readonly ParsedField[],
  key: string,
): string | undefined | null {
  let found: string | undefined;
  for (const field of fields) {
    if (field.key !== key) continue;
    if (found !== undefined) return null;
    found = field.value;
  }
  return found;
}

function inertReport(kind: PayloadKind, fields: ReportFields): AnalysisReport {
  return createReport({ kind, fields: fields.value, actionPolicy: "inspect-only" });
}

function maskedUnparsedSensitiveReport(text: string): AnalysisReport {
  const fields = new ReportFields();
  fields.add("text", "Text", text, {
    sensitive: true,
    masked: true,
    collapsed: true,
  });
  return inertReport("text", fields);
}

function isValidUnpaddedBase32(value: string): boolean {
  if (!/^[A-Z2-7]+$/iu.test(value)) return false;
  return ![1, 3, 6].includes(value.length % 8);
}

function parseWifi(text: string): AnalysisReport | null {
  if (!text.toUpperCase().startsWith("WIFI:")) return null;
  const parsed = parseDelimitedFields(text.slice(5), "wifi");
  if (parsed === null) return null;
  const ssid = findField(parsed, "S");
  const securityValue = findField(parsed, "T");
  const password = findField(parsed, "P");
  const hidden = findField(parsed, "H");
  const eapMethod = findField(parsed, "E");
  const anonymousIdentity = findField(parsed, "A");
  const identity = findField(parsed, "I");
  const explicitPhase2 = findField(parsed, "PH2");
  if (
    ssid === null ||
    securityValue === null ||
    password === null ||
    hidden === null ||
    eapMethod === null ||
    anonymousIdentity === null ||
    identity === null ||
    explicitPhase2 === null
  ) {
    return null;
  }
  const security = securityValue ?? "Not specified";
  if (
    ssid === undefined ||
    ssid === "" ||
    !structuredValueFits(ssid) ||
    !structuredValueFits(security)
  ) {
    return null;
  }
  for (const value of [
    password,
    hidden,
    eapMethod,
    anonymousIdentity,
    identity,
    explicitPhase2,
  ]) {
    if (value !== undefined && !structuredValueFits(value)) return null;
  }

  const normalizedHidden = hidden === undefined ? undefined : hidden.toLowerCase();
  const hiddenBoolean =
    normalizedHidden === "true"
      ? "Yes"
      : normalizedHidden === "false"
        ? "No"
        : undefined;
  const nonemptyPhase2 = explicitPhase2 === "" ? undefined : explicitPhase2;
  const legacyPhase2 =
    hidden !== undefined && hidden !== "" && hiddenBoolean === undefined
      ? hidden
      : undefined;
  if (legacyPhase2 !== undefined && nonemptyPhase2 !== undefined) return null;

  const nonemptyEnterpriseValues = [
    eapMethod,
    anonymousIdentity,
    identity,
    nonemptyPhase2,
    legacyPhase2,
  ].filter((value) => value !== undefined && value !== "");
  if (
    nonemptyEnterpriseValues.length > 0 &&
    security.toUpperCase() !== "WPA2-EAP"
  ) {
    return null;
  }
  const passwordIsIgnored =
    securityValue === undefined ||
    securityValue === "" ||
    security.toLowerCase() === "nopass";
  if (passwordIsIgnored && password !== undefined && password !== "") {
    return null;
  }

  const fields = new ReportFields();
  // The SSID is identifying personal context, so the copied report keeps only
  // its label while the on-screen row still shows the value.
  fields.add("ssid", "Network name (SSID)", ssid);
  // T and H are interoperable but not uniformly validated across scanner
  // ecosystems. Keep them visible for local inspection, while the whole-report
  // export fails closed instead of treating attacker-provided text as safe.
  fields.add("security", "Declared security type (not validated)", security);
  if (hiddenBoolean !== undefined) {
    fields.add("hidden", "Declared hidden network (not validated)", hiddenBoolean, {
      reportPolicy: "safe",
    });
  }
  if (eapMethod !== undefined && eapMethod !== "") {
    fields.add("eap-method", "Declared EAP method (not validated)", eapMethod);
  }
  const phase2 = nonemptyPhase2 ?? legacyPhase2;
  if (phase2 !== undefined) {
    fields.add(
      "phase2-method",
      legacyPhase2 === undefined
        ? "Declared phase 2 method (not validated)"
        : "Declared phase 2 method (legacy H, not validated)",
      phase2,
    );
  }
  if (anonymousIdentity !== undefined && anonymousIdentity !== "") {
    fields.add("anonymous-identity", "Anonymous identity", anonymousIdentity, {
      sensitive: true,
      masked: true,
    });
  }
  if (identity !== undefined && identity !== "") {
    fields.add("identity", "Identity", identity, {
      sensitive: true,
      masked: true,
    });
  }
  if (password !== undefined) {
    fields.add("password", "Password", password, { sensitive: true, masked: true });
  }
  return inertReport("wifi", fields);
}

function parseOtp(text: string): AnalysisReport | null {
  if (!structuredValueFits(text)) return null;
  const match = /^otpauth:\/\/(totp|hotp)\/([^/?#]+)\?([^#]*)$/iu.exec(text);
  if (match === null) return null;
  const otpType = match[1]?.toLowerCase();
  const encodedLabel = match[2] ?? "";
  const query = match[3] ?? "";
  const label = boundedPercentDecode(encodedLabel);
  if (label === null || label === "" || !structuredValueFits(label)) return null;

  const secret = queryParameter(query, "secret");
  const counter = queryParameter(query, "counter");
  const algorithm = queryParameter(query, "algorithm");
  const digits = queryParameter(query, "digits");
  const period = queryParameter(query, "period");
  if (
    secret === null ||
    counter === null ||
    algorithm === null ||
    digits === null ||
    period === null ||
    secret === undefined ||
    !isValidUnpaddedBase32(secret) ||
    (algorithm !== undefined && !/^(?:SHA1|SHA256|SHA512)$/iu.test(algorithm)) ||
    (digits !== undefined && !/^(?:6|8)$/u.test(digits))
  ) {
    return null;
  }
  if (otpType === "hotp") {
    if (
      counter === undefined ||
      !/^\d+$/u.test(counter) ||
      BigInt(counter) > 18_446_744_073_709_551_615n ||
      period !== undefined
    ) {
      return null;
    }
  } else if (
    counter !== undefined ||
    (period !== undefined && !/^[1-9]\d*$/u.test(period))
  ) {
    return null;
  }

  const fields = new ReportFields();
  fields.add(
    "otp-type",
    "OTP setup type",
    otpType === "hotp" ? "HOTP setup payload" : "TOTP setup payload",
    { reportPolicy: "safe" },
  );
  fields.add("otp-payload", "Complete setup payload", text, {
    sensitive: true,
    masked: true,
    collapsed: true,
  });
  return inertReport("otp", fields);
}

function parseDpp(text: string): AnalysisReport | null {
  if (!/^DPP:/i.test(text)) return null;
  if (!structuredValueFits(text) || !text.endsWith(";;")) return null;
  const parsed = parseDelimitedFields(text.slice(4), "wifi");
  if (parsed === null) return null;
  const publicKey = findField(parsed, "K");
  const channels = findField(parsed, "C");
  const macAddress = findField(parsed, "M");
  const information = findField(parsed, "I");
  const knownValues = [publicKey, channels, macAddress, information];
  if (
    publicKey === null ||
    channels === null ||
    macAddress === null ||
    information === null ||
    publicKey === undefined ||
    publicKey.length < 16 ||
    !/^[A-Za-z0-9_-]+={0,2}$/u.test(publicKey) ||
    publicKey.length % 4 === 1 ||
    (channels !== undefined &&
      (channels === "" || !/^\d+\/\d+(?:,\d+)*(?:,\d+\/\d+(?:,\d+)*)*$/u.test(channels))) ||
    (macAddress !== undefined && !/^[0-9A-F]{12}$/iu.test(macAddress)) ||
    (information !== undefined && information === "") ||
    knownValues.some((value) => value !== undefined && value !== null && !structuredValueFits(value))
  ) {
    return null;
  }
  const fields = new ReportFields();
  fields.add(
    "dpp-type",
    "Provisioning type",
    "DPP bootstrap data (public key not validated)",
    { reportPolicy: "safe" },
  );
  fields.add("dpp-payload", "Complete bootstrap payload", text, {
    sensitive: true,
    masked: true,
    collapsed: true,
  });
  return inertReport("dpp", fields);
}

function unfoldLines(text: string): string[] | null {
  const physical = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  // RFC 6350 and RFC 5545 end the final content line with CRLF; drop exactly
  // that one terminator so END:VCARD stays the last logical line. Anything
  // beyond a single trailing newline still fails closed.
  if (physical.length > 1 && physical.at(-1) === "") physical.pop();
  const logical: string[] = [];
  for (const line of physical) {
    if (/^[ \t]/.test(line)) {
      if (logical.length === 0) return null;
      logical[logical.length - 1] += line.slice(1);
    } else {
      logical.push(line);
      if (logical.length > ANALYZER_LIMITS.logicalFields) return null;
    }
  }
  if (logical.some((line) => utf8Length(line) > ANALYZER_LIMITS.expandedBytes)) return null;
  return logical;
}

function decodeBackslashValue(value: string): string | null {
  const pieces = splitEscaped(value, "\u0000");
  return pieces === null ? null : pieces.join("");
}

/**
 * Bounded quoted-printable decoding: "=XX" hex pairs (either case) become
 * bytes while invalid escapes stay literal. A trailing "=" is a soft line
 * break whose continuation line unfolding already split off, so the value is
 * unrecoverable here and the decode declines. The decoded bytes read as
 * UTF-8 with replacement characters.
 */
function decodeQuotedPrintable(value: string): string | null {
  if (utf8Length(value) > ANALYZER_LIMITS.expandedBytes) return null;
  const encoder = new TextEncoder();
  const bytes: number[] = [];
  let index = 0;
  while (index < value.length) {
    const character = String.fromCodePoint(value.codePointAt(index) ?? 0);
    if (character !== "=") {
      for (const byte of encoder.encode(character)) bytes.push(byte);
      index += character.length;
      continue;
    }
    const escape = value.slice(index + 1, index + 3);
    if (/^[0-9a-fA-F]{2}$/.test(escape)) {
      bytes.push(Number.parseInt(escape, 16));
      index += 3;
    } else {
      if (index === value.length - 1) return null;
      bytes.push(0x3d);
      index += 1;
    }
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(Uint8Array.from(bytes));
}

const CONTACT_LABELS: Readonly<Record<string, string>> = Object.freeze({
  FN: "Name",
  N: "Name components",
  ORG: "Organization",
  TITLE: "Title",
  TEL: "Telephone",
  EMAIL: "Email",
  ADR: "Address",
  NOTE: "Note",
});

interface SelectiveFieldCandidate {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly collapsed?: boolean;
}

function selectiveStructuredReport(
  kind: "contact" | "calendar",
  text: string,
  summaryLabel: string,
  summaryValue: string,
  totalProperties: number,
  candidates: readonly SelectiveFieldCandidate[],
): AnalysisReport {
  // Probe the exact final budget order used by ensureExactStructuredSource:
  // the masked original is reserved first, followed by the summary and then
  // supported highlights. This makes the omission count deterministic even
  // when the source or supported values consume the scalar budget.
  const probe = new ReportFields();
  probe.add("original", "Original QR content", text, {
    sensitive: true,
    masked: true,
    collapsed: true,
  });
  probe.add("summary", summaryLabel, summaryValue, { reportPolicy: "safe" });
  const retained = candidates.filter((candidate) =>
    probe.add(candidate.id, candidate.label, candidate.value, {
      collapsed: candidate.collapsed ?? false,
    }),
  );

  const fields = new ReportFields();
  fields.add("summary", summaryLabel, summaryValue, {
    kind: "count",
    count: totalProperties,
    omittedCount: Math.max(0, totalProperties - retained.length),
    reportPolicy: "safe",
  });
  for (const candidate of retained) {
    fields.add(candidate.id, candidate.label, candidate.value, {
      collapsed: candidate.collapsed ?? false,
    });
  }
  return inertReport(kind, fields);
}

function parseCardLines(text: string): AnalysisReport | null {
  const lines = unfoldLines(text);
  if (
    lines === null ||
    lines[0]?.toUpperCase() !== "BEGIN:VCARD" ||
    lines.at(-1)?.toUpperCase() !== "END:VCARD"
  ) {
    return null;
  }
  const candidates: SelectiveFieldCandidate[] = [];
  let totalProperties = 0;
  let formattedNameCount = 0;
  let structuredNameCount = 0;
  let version: string | undefined;
  let versionIndex = -1;
  let expandedTotal = 0;
  for (const [index, line] of lines.slice(1, -1).entries()) {
    if (/^(?:BEGIN|END):/iu.test(line)) return null;
    const colon = unquotedColonIndex(line);
    if (colon <= 0) return null;
    totalProperties += 1;
    // An RFC 6350 group prefix such as "item1." never changes the property.
    const property = line.slice(0, colon).replace(/^[A-Za-z0-9-]+\./, "");
    const key = property.split(";", 1)[0]?.toUpperCase() ?? "";
    if (key === "VERSION") {
      if (version !== undefined) return null;
      let valueParameterCount = 0;
      for (const parameter of property.split(";").slice(1)) {
        const equals = parameter.indexOf("=");
        if (equals <= 0 || equals === parameter.length - 1) return null;
        if (parameter.slice(0, equals).toUpperCase() !== "VALUE") continue;
        valueParameterCount += 1;
        const parameterValue = parameter.slice(equals + 1).replace(/^"|"$/g, "");
        if (valueParameterCount > 1 || parameterValue.toLowerCase() !== "text") {
          return null;
        }
      }
      const decodedVersion = decodeBackslashValue(line.slice(colon + 1));
      if (
        decodedVersion === null ||
        !/^(?:2\.1|3\.0|4\.0)$/u.test(decodedVersion) ||
        /(?:^|;)ENCODING=/iu.test(property)
      ) {
        return null;
      }
      version = decodedVersion;
      versionIndex = index;
      continue;
    }
    if (key === "N") structuredNameCount += 1;
    const label = CONTACT_LABELS[key];
    if (label === undefined || /(?:^|;)ENCODING=(?:B|BASE64)(?:;|$)/i.test(property)) continue;
    const quotedPrintable = /(?:^|;)ENCODING=QUOTED-PRINTABLE(?:;|$)/i.test(property);
    if (quotedPrintable) {
      // A declared legacy charset changes how the quoted-printable bytes
      // read; this decoder speaks only UTF-8, so decline rather than show
      // text a conforming importer would read differently.
      const charset = /(?:^|;)CHARSET="?([^;"]*)"?(?:;|$)/i.exec(property)?.[1];
      if (charset !== undefined && !/^(?:utf-8|us-ascii)$/i.test(charset)) return null;
    }
    const raw = quotedPrintable
      ? decodeQuotedPrintable(line.slice(colon + 1))
      : line.slice(colon + 1);
    if (raw === null) return null;
    const value = decodeBackslashValue(raw);
    if (value === null || !structuredValueFits(value)) return null;
    if (key === "FN") {
      if (value === "") return null;
      formattedNameCount += 1;
    }
    expandedTotal += utf8Length(value);
    if (expandedTotal > ANALYZER_LIMITS.expandedBytes) return null;
    candidates.push({
      id: `${key.toLowerCase()}-${candidates.length}`,
      label,
      value,
      ...(key === "NOTE" ? { collapsed: true } : {}),
    });
  }
  // RFC 6350 requires exactly one VERSION as the first property and one or
  // more FN properties. Older vCard profiles permit VERSION elsewhere; we
  // still require it so the parser never guesses which grammar applies.
  if (version === undefined || formattedNameCount < 1) return null;
  if (version === "4.0" && versionIndex !== 0) return null;
  if (structuredNameCount > 1) return null;
  if (version !== "4.0" && structuredNameCount < 1) return null;
  return selectiveStructuredReport(
    "contact",
    text,
    "Contact",
    "vCard contact",
    totalProperties,
    candidates,
  );
}

function parseMecard(text: string): AnalysisReport | null {
  if (!text.toUpperCase().startsWith("MECARD:")) return null;
  const parsed = parseDelimitedFields(text.slice(7));
  if (parsed === null) return null;
  const fields = new ReportFields();
  let shown = 0;
  for (const item of parsed) {
    const label = CONTACT_LABELS[item.key];
    if (label === undefined) continue;
    if (!structuredValueFits(item.value)) return null;
    fields.add(`${item.key.toLowerCase()}-${shown}`, label, item.value, {
      collapsed: item.key === "NOTE",
    });
    shown += 1;
  }
  if (shown === 0) return null;
  return inertReport("contact", fields);
}

const CALENDAR_LABELS: Readonly<Record<string, string>> = Object.freeze({
  SUMMARY: "Event",
  DTSTART: "Starts",
  DTEND: "Ends",
  LOCATION: "Location",
  DESCRIPTION: "Description",
});

function parseCalendar(text: string): AnalysisReport | null {
  const lines = unfoldLines(text);
  const first = lines?.[0]?.toUpperCase();
  if (lines === null || (first !== "BEGIN:VCALENDAR" && first !== "BEGIN:VEVENT")) {
    return null;
  }
  const root = first.slice(6);
  const openComponents: string[] = [];
  let rootClosed = false;
  let eventCount = 0;
  let totalProperties = 0;
  const candidates: SelectiveFieldCandidate[] = [];
  let expandedTotal = 0;
  for (const [index, line] of lines.entries()) {
    const upper = line.toUpperCase();
    if (upper.startsWith("BEGIN:")) {
      if (rootClosed) return null;
      const component = upper.slice(6);
      const parent = openComponents.at(-1);
      if (openComponents.length === 0) {
        if (index !== 0 || component !== root) return null;
        if (component === "VEVENT") eventCount = 1;
      } else if (component === "VEVENT") {
        if (parent !== "VCALENDAR" || eventCount !== 0) return null;
        eventCount = 1;
      } else if (component === "VCALENDAR") {
        return null;
      } else if (parent === "VEVENT" || parent === "VTODO") {
        // VALARM is the only nested component whose omission we can account
        // for without confusing its fields with the parent event/task.
        if (component !== "VALARM") return null;
      } else if (parent === "VTIMEZONE") {
        if (component !== "STANDARD" && component !== "DAYLIGHT") return null;
      } else if (parent === "VCALENDAR") {
        if (component === "VALARM") return null;
      } else {
        return null;
      }
      openComponents.push(component);
      if (openComponents.length > ANALYZER_LIMITS.nesting) return null;
      continue;
    }
    if (upper.startsWith("END:")) {
      // Every END must close the component the matching BEGIN opened.
      if (openComponents.pop() !== upper.slice(4)) return null;
      if (openComponents.length === 0) {
        if (index !== lines.length - 1) return null;
        rootClosed = true;
      }
      continue;
    }
    // A content line outside every component belongs to no iCalendar object
    // (RFC 5545 section 3.4), so fail closed rather than display it.
    if (openComponents.length === 0) return null;
    const colon = unquotedColonIndex(line);
    if (colon <= 0) return null;
    totalProperties += 1;
    const inReviewedEvent =
      (openComponents.length === 1 && openComponents[0] === "VEVENT") ||
      (openComponents.length === 2 &&
        openComponents[0] === "VCALENDAR" &&
        openComponents[1] === "VEVENT");
    if (!inReviewedEvent) continue;
    const property = line.slice(0, colon);
    const key = property.split(";", 1)[0]?.toUpperCase() ?? "";
    const label = CALENDAR_LABELS[key];
    if (label === undefined) continue;
    const value = decodeBackslashValue(line.slice(colon + 1));
    if (value === null || !structuredValueFits(value)) return null;
    const parameterSeparator = property.indexOf(";");
    const contextualValue =
      (key === "DTSTART" || key === "DTEND") && parameterSeparator >= 0
        ? `${value} (${property.slice(parameterSeparator + 1)})`
        : value;
    if (!structuredValueFits(contextualValue)) return null;
    expandedTotal += utf8Length(contextualValue);
    if (expandedTotal > ANALYZER_LIMITS.expandedBytes) return null;
    candidates.push({
      id: `${key.toLowerCase()}-${candidates.length}`,
      label,
      value: contextualValue,
      ...(key === "DESCRIPTION" ? { collapsed: true } : {}),
    });
  }
  if (openComponents.length !== 0 || !rootClosed || eventCount !== 1) return null;
  return selectiveStructuredReport(
    "calendar",
    text,
    "Calendar",
    "Calendar entry",
    totalProperties,
    candidates,
  );
}

function boundedPercentDecode(value: string): string | null {
  if (value.length > ANALYZER_LIMITS.expandedBytes * 3) return null;
  try {
    const decoded = decodeURIComponent(value);
    return utf8Length(decoded) <= ANALYZER_LIMITS.expandedBytes ? decoded : null;
  } catch {
    return null;
  }
}

/**
 * Decodes the value of `name`. Returns undefined when the parameter is absent
 * and null when a present value or a field name fails bounded decoding, or
 * when the name repeats: platforms disagree on which duplicate a handler app
 * would use, so a faithful summary must decline rather than show only one of
 * them.
 */
function queryParameter(query: string, name: string): string | undefined | null {
  const pairs = query.split("&");
  if (pairs.length > ANALYZER_LIMITS.logicalFields) return null;
  let found: string | undefined;
  for (const pair of pairs) {
    const equals = pair.indexOf("=");
    const encodedKey = equals === -1 ? pair : pair.slice(0, equals);
    if (encodedKey === "") continue;
    // RFC 6068 percent-encodes header field names as well as values, so the
    // key must decode before the comparison catches encoded bcc or body.
    const key = boundedPercentDecode(encodedKey);
    if (key === null) return null;
    if (key.toLowerCase() !== name) continue;
    if (found !== undefined) return null;
    // URI query syntax permits a key without "=". For a recognized name it
    // is a present empty value, not an absent parameter; this also catches a
    // key-only occurrence followed by a valued duplicate.
    const decoded = boundedPercentDecode(equals === -1 ? "" : pair.slice(equals + 1));
    if (decoded === null || !structuredValueFits(decoded)) return null;
    found = decoded;
  }
  return found;
}

function isGlobalNumber(value: string): boolean {
  return /^\+(?=[0-9().-]*[0-9])(?:[0-9().-]*[0-9][0-9().-]*)$/u.test(value);
}

function isPhoneContext(value: string): boolean {
  if (isGlobalNumber(value)) return true;
  return /^(?:[A-Z0-9](?:[A-Z0-9-]*[A-Z0-9])?)(?:\.(?:[A-Z0-9](?:[A-Z0-9-]*[A-Z0-9])?))*$/iu.test(
    value,
  );
}

function isPlausibleTelephoneSubscriber(value: string): boolean {
  const [subscriber = "", ...parameters] = value.split(";");
  const global = subscriber.startsWith("+");
  if (global) {
    if (!isGlobalNumber(subscriber)) return false;
  } else if (!/^(?=[0-9A-F*#().-]*[0-9A-F])[0-9A-F*#().-]+$/iu.test(subscriber)) {
    return false;
  }

  const seen = new Set<string>();
  let hasPhoneContext = false;
  let hasExtension = false;
  let hasIsub = false;
  for (const parameter of parameters) {
    const equals = parameter.indexOf("=");
    const name = (equals === -1 ? parameter : parameter.slice(0, equals)).toLowerCase();
    const parameterValue = equals === -1 ? undefined : parameter.slice(equals + 1);
    if (
      !/^[a-z0-9-]+$/u.test(name) ||
      (parameterValue !== undefined &&
        (parameterValue === "" || /[;,\s?#]/u.test(parameterValue)))
    ) {
      return false;
    }
    if (seen.has(name)) return false;
    seen.add(name);
    if (name === "phone-context") {
      if (parameterValue === undefined || !isPhoneContext(parameterValue)) return false;
      hasPhoneContext = true;
    } else if (name === "ext") {
      if (
        parameterValue === undefined ||
        !/^(?=[0-9().-]*[0-9])[0-9().-]+$/u.test(parameterValue)
      ) {
        return false;
      }
      hasExtension = true;
    } else if (name === "isub") {
      if (parameterValue === undefined) return false;
      hasIsub = true;
    }
  }
  if (hasExtension && hasIsub) return false;
  return global ? !hasPhoneContext : hasPhoneContext;
}

function hasPlausibleMessageRecipients(value: string): boolean {
  return value !== "" && value.split(",").every(isPlausibleTelephoneSubscriber);
}

function hasValidGeoCoordinates(value: string): boolean {
  const [tuple = "", ...parameters] = value.split(";");
  const parts = tuple.split(",");
  if (parts.length !== 2 && parts.length !== 3) return false;
  const decimal = /^-?\d+(?:\.\d+)?$/u;
  if (!parts.every((part) => decimal.test(part))) return false;
  const [latitude = Number.NaN, longitude = Number.NaN, altitude] = parts.map(Number);
  if (
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    latitude < -90 ||
    latitude > 90 ||
    longitude < -180 ||
    longitude > 180 ||
    (altitude !== undefined && !Number.isFinite(altitude))
  ) {
    return false;
  }
  const seen = new Set<string>();
  let hasCrs = false;
  for (const [index, parameter] of parameters.entries()) {
    const equals = parameter.indexOf("=");
    const name = (equals === -1 ? parameter : parameter.slice(0, equals)).toLowerCase();
    const parameterValue = equals === -1 ? undefined : parameter.slice(equals + 1);
    if (
      !/^[a-z0-9-]+$/u.test(name) ||
      (parameterValue !== undefined &&
        (parameterValue === "" || /[;\s?#]/u.test(parameterValue))) ||
      seen.has(name)
    ) {
      return false;
    }
    seen.add(name);
    if (name === "crs") {
      if (index !== 0 || parameterValue?.toLowerCase() !== "wgs84") return false;
      hasCrs = true;
    } else if (name === "u") {
      const expectedIndex = hasCrs ? 1 : 0;
      if (
        index !== expectedIndex ||
        parameterValue === undefined ||
        !/^\d+(?:\.\d+)?$/u.test(parameterValue)
      ) {
        return false;
      }
    }
  }
  return true;
}

function hasEncodedPartitionDelimiter(value: string): boolean {
  return /%(?:2c|3b|3d|3f)/iu.test(value);
}

function parseApplicationUri(text: string): AnalysisReport | null {
  const schemeMatch = /^([a-z][a-z0-9+.-]*):(.*)$/is.exec(text);
  if (schemeMatch === null) return null;
  const scheme = (schemeMatch[1] ?? "").toLowerCase();
  const rest = schemeMatch[2] ?? "";
  const query = rest.includes("?") ? rest.slice(rest.indexOf("?") + 1) : "";
  const fields = new ReportFields();

  if (scheme === "mailto") {
    const address = boundedPercentDecode(rest.split("?", 1)[0] ?? "");
    if (address === null || !structuredValueFits(address)) return null;
    const to = queryParameter(query, "to");
    const cc = queryParameter(query, "cc");
    const bcc = queryParameter(query, "bcc");
    const subject = queryParameter(query, "subject");
    const body = queryParameter(query, "body");
    if (to === null || cc === null || bcc === null || subject === null || body === null) {
      return null;
    }
    // RFC 6068 combines the addr-spec part with the "to" header field; mail
    // clients address both, so the summary must show both and never render
    // an empty recipient row as if the message had no recipient.
    const recipients = [address, to ?? ""].filter((value) => value !== "").join(", ");
    if (recipients !== "") {
      fields.add("recipient", "Email recipient", recipients);
    }
    if (cc !== undefined) {
      fields.add("cc", "Email CC", cc);
    }
    if (bcc !== undefined) {
      fields.add("bcc", "Email BCC", bcc);
    }
    if (subject !== undefined) {
      fields.add("subject", "Email subject", subject);
    }
    if (body !== undefined) {
      fields.add("body", "Email body", body, {
        collapsed: true,
      });
    }
    fields.add("summary", "Action", "Email details (inspect only)", {
      reportPolicy: "safe",
    });
    return inertReport("email", fields);
  }
  if (["sms", "smsto", "mms", "mmsto"].includes(scheme)) {
    const colonForm = scheme === "smsto" || scheme === "mmsto";
    // SMSTO/MMSTO are legacy colon-form conventions rather than RFC 5724
    // query URIs. Preserve every character after the recipient delimiter as
    // the message body, including literal question marks.
    const target = colonForm ? rest : (rest.split("?", 1)[0] ?? "");
    const messageQuery = colonForm ? "" : query;
    const colon = colonForm ? target.indexOf(":") : -1;
    if (!colonForm && target.includes(":")) return null;
    const rawRecipient = colon === -1 ? target : target.slice(0, colon);
    if (hasEncodedPartitionDelimiter(rawRecipient)) return null;
    // RFC 5724 destinations may carry ;phone-context and comma-separated
    // extra recipients; show the complete telephone-subscriber list.
    const recipient = boundedPercentDecode(
      rawRecipient,
    );
    if (
      recipient === null ||
      !structuredValueFits(recipient) ||
      !hasPlausibleMessageRecipients(recipient)
    ) {
      return null;
    }
    // The SMSTO:number:message convention prefills the text after a second
    // colon; the handler app will send it, so the summary must show it.
    const colonBody =
      colon === -1 ? undefined : boundedPercentDecode(target.slice(colon + 1));
    if (colonBody === null) return null;
    if (colonBody !== undefined && !structuredValueFits(colonBody)) return null;
    const queryBody = queryParameter(messageQuery, "body");
    if (queryBody === null) return null;
    // The colon-form and query-form bodies compete; handler apps disagree on
    // which text they prefill, so a faithful summary must decline rather
    // than show only one of them.
    if (colonBody !== undefined && queryBody !== undefined) return null;
    const body = queryBody ?? colonBody;
    if (recipient !== "") {
      fields.add("recipient", "Message recipient", recipient);
    }
    if (body !== undefined) {
      fields.add("body", "Message body", body, {
        collapsed: true,
      });
    }
    fields.add("summary", "Action", "Message details (inspect only)", {
      reportPolicy: "safe",
    });
    return inertReport("sms", fields);
  }
  if (scheme === "tel") {
    if (hasEncodedPartitionDelimiter(rest)) return null;
    const number = boundedPercentDecode(rest);
    if (
      number === null ||
      !structuredValueFits(number) ||
      !isPlausibleTelephoneSubscriber(number)
    ) {
      return null;
    }
    fields.add("number", "Telephone number", number);
    return inertReport("telephone", fields);
  }
  if (scheme === "geo") {
    if (rest.includes("?") || hasEncodedPartitionDelimiter(rest)) return null;
    const coordinates = boundedPercentDecode(rest.split("?", 1)[0] ?? "");
    if (
      coordinates === null ||
      !structuredValueFits(coordinates) ||
      !hasValidGeoCoordinates(coordinates)
    ) {
      return null;
    }
    fields.add("coordinates", "Coordinates", coordinates);
    return inertReport("geo", fields);
  }

  const paymentSchemes = new Set([
    "bitcoin",
    "ethereum",
    "lightning",
    "monero",
    "payto",
    "solana",
    "zcash",
  ]);
  const paymentRelated = paymentSchemes.has(scheme);
  const summary =
    rest === ""
      ? "URI scheme only (no payload)"
      : paymentRelated
        ? "Payment-related URI (payload not validated)"
        : "URI scheme recognized; payload not validated";
  fields.add("scheme", "URI scheme", scheme, { reportPolicy: "safe" });
  fields.add(
    "summary",
    paymentRelated ? "Payment" : "Action",
    summary,
    { reportPolicy: "safe" },
  );
  return inertReport(paymentRelated ? "payment" : "custom-uri", fields);
}

/** Ordered structured-payload registry after the HTTP(S) parser. */
export function analyzeStructuredText(text: string): AnalysisReport | null {
  if (/^WIFI:/i.test(text)) {
    return parseWifi(text) ?? maskedUnparsedSensitiveReport(text);
  }
  if (/^(?:otpauth|otpauth-migration):/i.test(text)) {
    return parseOtp(text) ?? maskedUnparsedSensitiveReport(text);
  }
  if (/^DPP:/i.test(text)) {
    return parseDpp(text) ?? maskedUnparsedSensitiveReport(text);
  }
  if (/^BEGIN:VCARD(?:\r?\n|\r)/i.test(text)) {
    return parseCardLines(text) ?? maskedUnparsedSensitiveReport(text);
  }
  if (/^MECARD:/i.test(text)) {
    return parseMecard(text) ?? maskedUnparsedSensitiveReport(text);
  }
  if (/^BEGIN:(?:VCALENDAR|VEVENT)(?:\r?\n|\r)/i.test(text)) {
    return parseCalendar(text) ?? maskedUnparsedSensitiveReport(text);
  }
  // A failed parse of a recognized personal-data scheme must not fall back to
  // plain unmasked text; the colon keeps ordinary prose like "smsomething" out.
  if (/^(?:sms|smsto|mms|mmsto|mailto|tel|geo):/i.test(text)) {
    return parseApplicationUri(text) ?? maskedUnparsedSensitiveReport(text);
  }
  return parseApplicationUri(text);
}
