import type { DisplayField } from "../analyzer/types";
import { COPY } from "./index";
import { APP_LOCALE } from "./locale";

/**
 * Analyzer evidence arrives as literal English strings rather than message
 * identifiers. These helpers translate the known field labels and signal
 * titles through the locale tables and mark anything that stays English so
 * assistive technology can switch pronunciation per part (language-of-parts).
 */
export interface EvidenceText {
  readonly text: string;
  /** "en" when the text remains English inside a non-English page. */
  readonly lang: "en" | undefined;
}

/**
 * Signal detail sentences are parametric English text until the analyzer
 * emits message identifiers, so on non-English pages they carry lang="en".
 */
export const ENGLISH_EVIDENCE_LANG: "en" | undefined =
  APP_LOCALE === "en" ? undefined : "en";

function translateEvidence(
  table: Readonly<Record<string, string>>,
  english: string,
): EvidenceText {
  if (APP_LOCALE === "en") return { text: english, lang: undefined };
  const translated = table[english];
  return translated === undefined
    ? { text: english, lang: "en" }
    : { text: translated, lang: undefined };
}

export function translateFieldLabel(label: string): EvidenceText {
  return translateEvidence(COPY.fieldLabels, label);
}

export function translateSignalTitle(title: string): EvidenceText {
  return translateEvidence(COPY.signalTitles, title);
}

/**
 * Field ids whose values the analyzer synthesizes entirely in English, so an
 * unlisted value is still English and stays marked lang="en" (fail closed).
 */
const SYNTHESIZED_VALUE_FIELD_IDS: ReadonlySet<string> = new Set([
  "fragment",
  "destination-category",
  "otp-type",
  "dpp-type",
  "summary",
]);

/**
 * Field ids that usually carry verbatim decoded evidence but fall back to
 * exact synthesized English strings; only those strings translate, and every
 * other value passes through unmarked as verbatim content.
 */
const MIXED_VALUE_FALLBACKS: Readonly<Record<string, readonly string[]>> =
  Object.freeze({
    "registrable-domain": Object.freeze(["Not available"]),
    "byte-count": Object.freeze(["Unavailable"]),
    "hex-preview": Object.freeze(["Unavailable", "Empty"]),
    "security": Object.freeze(["Not specified"]),
  });

const PORT_DESCRIPTOR = /^(\d+) \((effective|explicit)\)$/u;

/**
 * Translates the analyzer's synthesized English field values for display,
 * keyed by the stable field id so verbatim QR content is never rewritten.
 * Unknown synthesized values (for example IANA registry category names)
 * remain English marked lang="en" per the language-of-parts policy.
 */
export function translateFieldValue(
  field: Pick<DisplayField, "id" | "label" | "kind" | "value" | "count">,
): EvidenceText {
  if (APP_LOCALE === "en") return { text: field.value, lang: undefined };
  if (field.id === "port" && field.kind === "port") {
    const match = PORT_DESCRIPTOR.exec(field.value);
    if (match === null) return { text: field.value, lang: "en" };
    return {
      text:
        match[2] === "effective"
          ? COPY.portValueEffective(match[1]!)
          : COPY.portValueExplicit(match[1]!),
      lang: undefined,
    };
  }
  if (
    (field.id === "query-names" || field.id === "fragment-names") &&
    field.count === 0 &&
    field.value === "None"
  ) {
    // The count distinguishes this synthesized empty-state value from a real
    // attacker-controlled parameter whose literal name happens to be "None".
    return translateEvidence(COPY.fieldValues, field.value);
  }
  if (
    SYNTHESIZED_VALUE_FIELD_IDS.has(field.id) ||
    (field.id === "content" && field.label === "QR content")
  ) {
    return translateEvidence(COPY.fieldValues, field.value);
  }
  const fallbacks = MIXED_VALUE_FALLBACKS[field.id];
  if (fallbacks !== undefined && fallbacks.includes(field.value)) {
    return translateEvidence(COPY.fieldValues, field.value);
  }
  return { text: field.value, lang: undefined };
}
