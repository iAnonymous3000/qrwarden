export interface RuntimeIdleSnapshot {
  readonly viewKind: string;
  readonly hasActiveReport: boolean;
  readonly hasOpenConfirmation: boolean;
  readonly imageBusy: boolean;
  readonly cameraAttached: boolean;
  readonly cameraTaskBusy: boolean;
  readonly clipboardBusy: boolean;
  readonly hasPendingShare: boolean;
  readonly hasRetainedResources: boolean;
}

/** The synchronous PREPARE_UPDATE predicate; every non-home resource is busy. */
export function isRuntimeIdle(snapshot: RuntimeIdleSnapshot): boolean {
  return (
    snapshot.viewKind === "home" &&
    !snapshot.hasActiveReport &&
    !snapshot.hasOpenConfirmation &&
    !snapshot.imageBusy &&
    !snapshot.cameraAttached &&
    !snapshot.cameraTaskBusy &&
    !snapshot.clipboardBusy &&
    !snapshot.hasPendingShare &&
    !snapshot.hasRetainedResources
  );
}
