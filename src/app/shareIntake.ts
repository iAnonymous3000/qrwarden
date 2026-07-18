import type { ProblemCode } from "./problems";

/** Mirrors the worker's rejection vocabulary for invalid share-target posts. */
export type ShareRejectionReason =
  | "multiple-files"
  | "too-large"
  | "unsupported-type"
  | "unreadable";

export type ShareIntakeEntry =
  | { readonly kind: "image"; readonly file: File }
  | { readonly kind: "rejected"; readonly reason: ShareRejectionReason };

/** Mirrors the worker's bounded parking so buffered shares stay small. */
export const SHARE_INTAKE_MAX_BUFFERED = 4;

/** Coerces an untrusted worker-message reason; unknown values fail closed. */
export function shareRejectionReason(value: unknown): ShareRejectionReason {
  return value === "multiple-files" ||
    value === "too-large" ||
    value === "unsupported-type"
    ? value
    : "unreadable";
}

/** Maps a rejected share onto its source-specific recovery copy. */
export function shareRejectionProblem(reason: ShareRejectionReason): ProblemCode {
  switch (reason) {
    case "multiple-files":
      return "share-multiple-files";
    case "too-large":
      return "share-too-large";
    case "unsupported-type":
      return "share-unsupported-type";
    case "unreadable":
      return "share-unreadable";
  }
}

/**
 * Appends to the buffered-share queue fail-closed: a full buffer refuses the
 * newest entry instead of silently overwriting an older parked share, and
 * consumption drains oldest first so overlapping shares stay deterministic.
 */
export function bufferShareIntake(
  entries: readonly ShareIntakeEntry[],
  entry: ShareIntakeEntry,
): readonly ShareIntakeEntry[] {
  if (entries.length >= SHARE_INTAKE_MAX_BUFFERED) {
    return entries;
  }
  return [...entries, entry];
}

/**
 * A buffered share may only be consumed by an unlocked home view that is
 * actually shown: a hidden document must not resume decoding work its
 * lifecycle suspension just parked.
 */
export function canConsumeShare(
  locked: boolean,
  viewKind: string,
  visibilityState: DocumentVisibilityState,
): boolean {
  return !locked && viewKind === "home" && visibilityState !== "hidden";
}
