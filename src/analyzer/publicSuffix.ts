import { PUBLIC_SUFFIX_SNAPSHOT } from "../data/publicSuffixSnapshot";

const ICANN = new Set<string>(PUBLIC_SUFFIX_SNAPSHOT.icannRules);
const PRIVATE = new Set<string>(PUBLIC_SUFFIX_SNAPSHOT.privateRules);
const WILDCARD = new Set<string>(PUBLIC_SUFFIX_SNAPSHOT.wildcardRules);
const PRIVATE_WILDCARD = new Set<string>(PUBLIC_SUFFIX_SNAPSHOT.privateWildcardRules);
const EXCEPTION = new Set<string>(PUBLIC_SUFFIX_SNAPSHOT.exceptionRules);
const PRIVATE_EXCEPTION = new Set<string>(PUBLIC_SUFFIX_SNAPSHOT.privateExceptionRules);

export interface RegistrableDomainResult {
  readonly registrableDomain: string | null;
  readonly publicSuffix: string;
  readonly section: "icann" | "private" | "default";
}

export function registrableDomain(hostname: string): RegistrableDomainResult {
  const normalized = hostname.toLowerCase().replace(/\.$/, "");
  const labels = normalized.split(".").filter(Boolean);
  if (labels.length === 0) {
    return { registrableDomain: null, publicSuffix: "", section: "default" };
  }

  let suffixLength = 1;
  let section: RegistrableDomainResult["section"] = "default";
  for (let index = 0; index < labels.length; index += 1) {
    const candidate = labels.slice(index).join(".");
    const candidateLength = labels.length - index;
    if (PRIVATE_EXCEPTION.has(candidate)) {
      suffixLength = labels.length - index - 1;
      section = "private";
      break;
    }
    if (EXCEPTION.has(candidate)) {
      suffixLength = labels.length - index - 1;
      section = "icann";
      break;
    }
    if (
      PRIVATE.has(candidate) &&
      (candidateLength > suffixLength ||
        (candidateLength === suffixLength && section === "default"))
    ) {
      suffixLength = candidateLength;
      section = "private";
    } else if (
      ICANN.has(candidate) &&
      (candidateLength > suffixLength ||
        (candidateLength === suffixLength && section === "default"))
    ) {
      suffixLength = candidateLength;
      section = "icann";
    }
    if (index + 1 < labels.length && candidateLength > suffixLength) {
      const wildcardBase = labels.slice(index + 1).join(".");
      if (PRIVATE_WILDCARD.has(wildcardBase)) {
        suffixLength = candidateLength;
        section = "private";
      } else if (WILDCARD.has(wildcardBase)) {
        suffixLength = candidateLength;
        section = "icann";
      }
    }
  }

  const publicSuffix = labels.slice(-suffixLength).join(".");
  const registrable =
    labels.length > suffixLength
      ? labels.slice(-(suffixLength + 1)).join(".")
      : null;
  return { registrableDomain: registrable, publicSuffix, section };
}
