import type { ShareRejectionReason } from "../sw/protocol";
import type { ProblemCode } from "./problems";

/** Re-export the protocol vocabulary used by app recovery state. */
export type { ShareRejectionReason } from "../sw/protocol";

export type ShareIntakeEntry =
  | { readonly kind: "image"; readonly file: File }
  | { readonly kind: "rejected"; readonly reason: ShareRejectionReason };

/** Four deliverable entries plus one coalesced, visible overflow rejection. */
export const SHARE_INTAKE_MAX_DELIVERIES = 4;
export const SHARE_INTAKE_MAX_BUFFERED = SHARE_INTAKE_MAX_DELIVERIES + 1;

/** Maps a rejected share onto its source-specific recovery copy. */
export function shareRejectionProblem(reason: ShareRejectionReason): ProblemCode {
  switch (reason) {
    case "busy":
      return "share-busy";
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
 * Appends to the buffered-share queue in arrival order. Four owned deliveries
 * are retained exactly; a fifth is represented by one terminal busy rejection
 * rather than disappearing silently, and later overflow coalesces into it.
 */
export function bufferShareIntake(
  entries: readonly ShareIntakeEntry[],
  entry: ShareIntakeEntry,
): readonly ShareIntakeEntry[] {
  const isBusy = (candidate: ShareIntakeEntry): boolean =>
    candidate.kind === "rejected" && candidate.reason === "busy";
  const deliveries = entries
    .filter((candidate) => !isBusy(candidate))
    .slice(0, SHARE_INTAKE_MAX_DELIVERIES);
  const entryIsBusy = isBusy(entry);
  const deliverySlotsWereFull =
    deliveries.length >= SHARE_INTAKE_MAX_DELIVERIES;
  const busy = entries.some(isBusy) || entryIsBusy;
  if (!entryIsBusy && !deliverySlotsWereFull) {
    deliveries.push(entry);
  }
  // If a non-busy arrival found all four delivery slots occupied, represent
  // that loss with the same one terminal busy sentinel. Keeping the sentinel
  // outside the delivery count lets a later valid share refill a consumed
  // slot instead of being silently discarded.
  const overflowed = !entryIsBusy && deliverySlotsWereFull;
  return busy || overflowed
    ? [...deliveries, { kind: "rejected", reason: "busy" }]
    : deliveries;
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
