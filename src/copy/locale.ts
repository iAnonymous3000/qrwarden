export type AppLocale = "en" | "es";

const SUPPORTED_LOCALES: readonly AppLocale[] = ["en", "es"];

/**
 * Resolves the application locale from browser language preferences. The
 * first supported primary language subtag wins; everything else falls back
 * to English. Resolution is pure and total so workers, tests, and pages
 * without a navigator all get a deterministic locale.
 */
export function resolveAppLocale(
  languages: readonly (string | undefined)[],
): AppLocale {
  for (const language of languages) {
    if (typeof language !== "string") continue;
    const primary = language.split("-", 1)[0]?.toLowerCase() ?? "";
    const match = SUPPORTED_LOCALES.find((locale) => locale === primary);
    if (match !== undefined) return match;
  }
  return "en";
}

function browserLanguages(): readonly (string | undefined)[] {
  const navigatorLike = (
    globalThis as {
      readonly navigator?: {
        readonly languages?: readonly string[];
        readonly language?: string;
      };
    }
  ).navigator;
  if (navigatorLike === undefined) return [];
  const languages: unknown = navigatorLike.languages;
  if (Array.isArray(languages)) {
    const spoken = languages.filter(
      (entry): entry is string => typeof entry === "string",
    );
    if (spoken.length > 0) return spoken;
  }
  return [navigatorLike.language];
}

export const APP_LOCALE: AppLocale = resolveAppLocale(browserLanguages());
