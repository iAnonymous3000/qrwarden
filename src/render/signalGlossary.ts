import type { AnalysisSignalCode } from "../analyzer";
import { COPY } from "../copy";
import type { SignalGlossaryCopy } from "../copy/locales/en";

export type SignalGlossaryEntry = SignalGlossaryCopy;

/**
 * Plain-language explanation for every analyzer signal, resolved from the
 * active locale. The dictionaries are exhaustive over AnalysisSignalCode, so
 * adding a signal without explaining it fails the build.
 */
export const SIGNAL_GLOSSARY: Readonly<
  Record<AnalysisSignalCode, SignalGlossaryEntry>
> = COPY.signalGlossary;

export const SIGNAL_GLOSSARY_CODES = Object.freeze(
  Object.keys(SIGNAL_GLOSSARY) as readonly AnalysisSignalCode[],
);
