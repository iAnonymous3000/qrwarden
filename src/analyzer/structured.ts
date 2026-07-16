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

function parseDelimitedFields(value: string): ParsedField[] | null {
  const pieces = splitEscaped(value, ";");
  if (pieces === null) return null;
  const result: ParsedField[] = [];
  for (const piece of pieces) {
    if (piece === "") continue;
    const colon = piece.indexOf(":");
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
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const property = line.slice(0, colon);
    const key = property.split(";", 1)[0]?.toUpperCase() ?? "";
    const label = CONTACT_LABELS[key];
    if (label === undefined || /(?:^|;)ENCODING=(?:B|BASE64)(?:;|$)/i.test(property)) continue;
    const value = decodeBackslashValue(line.slice(colon + 1));
    if (value === null || !structuredValueFits(value)) return null;
    expandedTotal += utf8Length(value);
    if (expandedTotal > ANALYZER_LIMITS.expandedBytes) return null;
    fields.add(`${key.toLowerCase()}-${shown}`, label, value, { collapsed: key === "NOTE" });
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
  let depth = 0;
  const fields = new ReportFields();
  let shown = 0;
  let expandedTotal = 0;
  for (const line of lines) {
    if (line.toUpperCase().startsWith("BEGIN:")) {
      depth += 1;
      if (depth > ANALYZER_LIMITS.nesting) return null;
      continue;
    }
    if (line.toUpperCase().startsWith("END:")) {
      depth -= 1;
      if (depth < 0) return null;
      continue;
    }
    const colon = line.indexOf(":");
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
    });
    shown += 1;
  }
  if (depth !== 0) return null;
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

function parseApplicationUri(text: string): AnalysisReport | null {
  const schemeMatch = /^([a-z][a-z0-9+.-]*):(.*)$/is.exec(text);
  if (schemeMatch === null) return null;
  const scheme = (schemeMatch[1] ?? "").toLowerCase();
  const rest = schemeMatch[2] ?? "";
  const fields = new ReportFields();

  if (scheme === "mailto") {
    const address = boundedPercentDecode(rest.split("?", 1)[0] ?? "");
    if (address === null || !structuredValueFits(address)) return null;
    fields.add("recipient", "Email recipient", address);
    fields.add("summary", "Action", "Email details (inspect only)");
    return inertReport("email", fields);
  }
  if (["sms", "smsto", "mms", "mmsto"].includes(scheme)) {
    const recipient = boundedPercentDecode(rest.split(/[?:;]/, 1)[0] ?? "");
    if (recipient === null || !structuredValueFits(recipient)) return null;
    fields.add("recipient", "Message recipient", recipient);
    fields.add("summary", "Action", "Message details (inspect only)");
    return inertReport("sms", fields);
  }
  if (scheme === "tel") {
    const number = boundedPercentDecode(rest);
    if (number === null || !structuredValueFits(number)) return null;
    fields.add("number", "Telephone number", number);
    return inertReport("telephone", fields);
  }
  if (scheme === "geo") {
    const coordinates = boundedPercentDecode(rest.split("?", 1)[0] ?? "");
    if (coordinates === null || !structuredValueFits(coordinates)) return null;
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
  if (/^BEGIN:VCARD(?:\r?\n|\r)/i.test(text)) return parseCardLines(text);
  if (/^MECARD:/i.test(text)) return parseMecard(text);
  if (/^BEGIN:(?:VCALENDAR|VEVENT)(?:\r?\n|\r)/i.test(text)) {
    return parseCalendar(text);
  }
  return parseApplicationUri(text);
}
