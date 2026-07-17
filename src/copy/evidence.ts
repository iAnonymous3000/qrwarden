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
