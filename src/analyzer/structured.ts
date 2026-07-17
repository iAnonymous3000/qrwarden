import { ANALYZER_LIMITS, ReportFields, scalarLength } from "./limits";
import { createReport } from "./report";
import type { AnalysisReport, PayloadKind } from "./types";

interface ParsedField {
  readonly key: string;
  readonly value: string;
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function structuredValueFits(value: string): boolean {
  return (
    scalarLength(value) <= ANALYZER_LIMITS.fieldScalars &&
    utf8Length(value) <= ANALYZER_LIMITS.expandedBytes
  );
}

function splitEscaped(value: string, delimiter: string): string[] | null {
  const fields: string[] = [];
  let current = "";
  let escaped = false;
  let expandedBytes = 0;
  for (const character of value) {
    if (escaped) {
      const decoded = character === "n" || character === "N" ? "\n" : character;
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

function parseDelimitedFields(value: string): ParsedField[] | null {
  const pieces = splitEscaped(value, ";");
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

function findField(fields: readonly ParsedField[], key: string): string | undefined {
  return fields.find((field) => field.key === key)?.value;
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

function parseWifi(text: string): AnalysisReport | null {
  if (!text.toUpperCase().startsWith("WIFI:")) return null;
  const parsed = parseDelimitedFields(text.slice(5));
  if (parsed === null) return null;
  const ssid = findField(parsed, "S");
  const security = findField(parsed, "T") ?? "Not specified";
  if (ssid === undefined || !structuredValueFits(ssid) || !structuredValueFits(security)) {
    return null;
  }
  const password = findField(parsed, "P");
  if (password !== undefined && !structuredValueFits(password)) return null;

  const fields = new ReportFields();
  fields.add("ssid", "Network name (SSID)", ssid);
  fields.add("security", "Security type", security);
  if (password !== undefined) {
    fields.add("password", "Password", password, { sensitive: true, masked: true });
  }
  const hidden = findField(parsed, "H");
  if (hidden !== undefined) fields.add("hidden", "Hidden network", hidden);
  return inertReport("wifi", fields);
}

function parseOtp(text: string): AnalysisReport | null {
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(text)?.[1]?.toLowerCase();
  if (scheme !== "otpauth" && scheme !== "otpauth-migration") return null;
  if (!structuredValueFits(text)) return null;
  const fields = new ReportFields();
  fields.add(
    "otp-type",
    "OTP setup type",
    scheme === "otpauth-migration" ? "OTP migration" : "OTP account",
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
  if (!structuredValueFits(text)) return null;
  const fields = new ReportFields();
  fields.add("dpp-type", "Provisioning type", "DPP bootstrap");
  fields.add("dpp-payload", "Complete bootstrap payload", text, {
    sensitive: true,
    masked: true,
    collapsed: true,
  });
  return inertReport("dpp", fields);
}

function unfoldLines(text: string): string[] | null {
  const physical = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const logical: string[] = [];
  let continuationDepth = 0;
  for (const line of physical) {
    if (/^[ \t]/.test(line)) {
      if (logical.length === 0) return null;
      continuationDepth += 1;
      if (continuationDepth > ANALYZER_LIMITS.nesting) return null;
      logical[logical.length - 1] += line.slice(1);
    } else {
      continuationDepth = 0;
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
 * bytes and a trailing "=" is a soft line break, while invalid escapes stay
 * literal. The decoded bytes read as UTF-8 with replacement characters.
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
      if (index !== value.length - 1) bytes.push(0x3d);
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

function parseCardLines(text: string): AnalysisReport | null {
  const lines = unfoldLines(text);
  if (
    lines === null ||
    lines[0]?.toUpperCase() !== "BEGIN:VCARD" ||
    lines.at(-1)?.toUpperCase() !== "END:VCARD"
  ) {
    return null;
  }
  const fields = new ReportFields();
  let shown = 0;
  let expandedTotal = 0;
  for (const line of lines.slice(1, -1)) {
    const colon = unquotedColonIndex(line);
    if (colon <= 0) continue;
    // An RFC 6350 group prefix such as "item1." never changes the property.
    const property = line.slice(0, colon).replace(/^[A-Za-z0-9-]+\./, "");
    const key = property.split(";", 1)[0]?.toUpperCase() ?? "";
    const label = CONTACT_LABELS[key];
    if (label === undefined || /(?:^|;)ENCODING=(?:B|BASE64)(?:;|$)/i.test(property)) continue;
    const raw = /(?:^|;)ENCODING=QUOTED-PRINTABLE(?:;|$)/i.test(property)
      ? decodeQuotedPrintable(line.slice(colon + 1))
      : line.slice(colon + 1);
    if (raw === null) return null;
    const value = decodeBackslashValue(raw);
    if (value === null || !structuredValueFits(value)) return null;
    expandedTotal += utf8Length(value);
    if (expandedTotal > ANALYZER_LIMITS.expandedBytes) return null;
    fields.add(`${key.toLowerCase()}-${shown}`, label, value, {
      collapsed: key === "NOTE",
      reportRedacted: true,
    });
    shown += 1;
  }
  if (shown === 0) fields.add("summary", "Contact", "vCard contact");
  return inertReport("contact", fields);
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
      reportRedacted: true,
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
  const openComponents: string[] = [];
  const fields = new ReportFields();
  let shown = 0;
  let expandedTotal = 0;
  for (const line of lines) {
    const upper = line.toUpperCase();
    if (upper.startsWith("BEGIN:")) {
      openComponents.push(upper.slice(6));
      if (openComponents.length > ANALYZER_LIMITS.nesting) return null;
      continue;
    }
    if (upper.startsWith("END:")) {
      // Every END must close the component the matching BEGIN opened.
      if (openComponents.pop() !== upper.slice(4)) return null;
      continue;
    }
    const colon = unquotedColonIndex(line);
    if (colon <= 0) continue;
    const key = line.slice(0, colon).split(";", 1)[0]?.toUpperCase() ?? "";
    const label = CALENDAR_LABELS[key];
    if (label === undefined) continue;
    const value = decodeBackslashValue(line.slice(colon + 1));
    if (value === null || !structuredValueFits(value)) return null;
    expandedTotal += utf8Length(value);
    if (expandedTotal > ANALYZER_LIMITS.expandedBytes) return null;
    fields.add(`${key.toLowerCase()}-${shown}`, label, value, {
      collapsed: key === "DESCRIPTION",
      reportRedacted: true,
    });
    shown += 1;
  }
  if (openComponents.length !== 0) return null;
  if (shown === 0) fields.add("summary", "Calendar", "Calendar entry");
  return inertReport("calendar", fields);
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
 * and null when a present value fails bounded decoding, or when the name
 * repeats: platforms disagree on which duplicate a handler app would use, so
 * a faithful summary must decline rather than show only one of them.
 */
function queryParameter(query: string, name: string): string | undefined | null {
  const pairs = query.split("&");
  if (pairs.length > ANALYZER_LIMITS.logicalFields) return null;
  let found: string | undefined;
  for (const pair of pairs) {
    const equals = pair.indexOf("=");
    if (equals <= 0 || pair.slice(0, equals).toLowerCase() !== name) continue;
    if (found !== undefined) return null;
    const decoded = boundedPercentDecode(pair.slice(equals + 1));
    if (decoded === null || !structuredValueFits(decoded)) return null;
    found = decoded;
  }
  return found;
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
      fields.add("recipient", "Email recipient", recipients, { reportRedacted: true });
    }
    if (cc !== undefined) {
      fields.add("cc", "Email CC", cc, { reportRedacted: true });
    }
    if (bcc !== undefined) {
      fields.add("bcc", "Email BCC", bcc, { reportRedacted: true });
    }
    if (subject !== undefined) {
      fields.add("subject", "Email subject", subject, { reportRedacted: true });
    }
    if (body !== undefined) {
      fields.add("body", "Email body", body, {
        collapsed: true,
        reportRedacted: true,
      });
    }
    fields.add("summary", "Action", "Email details (inspect only)");
    return inertReport("email", fields);
  }
  if (["sms", "smsto", "mms", "mmsto"].includes(scheme)) {
    const target = rest.split("?", 1)[0] ?? "";
    const colon = target.indexOf(":");
    const recipient = boundedPercentDecode(
      (colon === -1 ? target : target.slice(0, colon)).split(";", 1)[0] ?? "",
    );
    if (recipient === null || !structuredValueFits(recipient)) return null;
    // The SMSTO:number:message convention prefills the text after a second
    // colon; the handler app will send it, so the summary must show it.
    const colonBody =
      colon === -1 ? undefined : boundedPercentDecode(target.slice(colon + 1));
    if (colonBody === null) return null;
    if (colonBody !== undefined && !structuredValueFits(colonBody)) return null;
    const queryBody = queryParameter(query, "body");
    if (queryBody === null) return null;
    const body = queryBody ?? colonBody;
    fields.add("recipient", "Message recipient", recipient, { reportRedacted: true });
    if (body !== undefined) {
      fields.add("body", "Message body", body, {
        collapsed: true,
        reportRedacted: true,
      });
    }
    fields.add("summary", "Action", "Message details (inspect only)");
    return inertReport("sms", fields);
  }
  if (scheme === "tel") {
    const number = boundedPercentDecode(rest);
    if (number === null || !structuredValueFits(number)) return null;
    fields.add("number", "Telephone number", number, { reportRedacted: true });
    return inertReport("telephone", fields);
  }
  if (scheme === "geo") {
    const coordinates = boundedPercentDecode(rest.split("?", 1)[0] ?? "");
    if (coordinates === null || !structuredValueFits(coordinates)) return null;
    fields.add("coordinates", "Coordinates", coordinates, { reportRedacted: true });
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
  fields.add("scheme", "URI scheme", scheme);
  fields.add(
    "summary",
    paymentSchemes.has(scheme) ? "Payment" : "Action",
    paymentSchemes.has(scheme)
      ? "Payment request (inspect only)"
      : "Custom application link (inspect only)",
  );
  return inertReport(paymentSchemes.has(scheme) ? "payment" : "custom-uri", fields);
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
