import { COPY } from "../copy";
import type { OfflineState } from "../sw/client";

export type UpdateActivationFeedback = "busy" | "started" | "unavailable" | null;

export interface UpdateInstallPresentation {
  readonly visible: boolean;
  readonly disabled: boolean;
  readonly message: string | null;
}

export function presentUpdateInstall(options: {
  readonly offlineState: OfflineState;
  readonly locked: boolean;
  readonly home: boolean;
  readonly serviceWorkerAvailable: boolean;
  readonly feedback: UpdateActivationFeedback;
}): UpdateInstallPresentation {
  const visible =
    options.offlineState === "update-ready" && options.serviceWorkerAvailable;
  const screenAllowsInstall = visible && !options.locked && options.home;
  const disabled =
    !screenAllowsInstall ||
    options.feedback === "started" ||
    options.feedback === "unavailable";
  const message =
    options.feedback === "started"
      ? COPY.updateStartingBody
      : options.feedback === "unavailable"
        ? COPY.updateUnavailableBody
        : options.feedback === "busy" ||
            (visible && !options.locked && !options.home)
          ? COPY.updateBusyBody
          : null;
  return { visible, disabled, message };
}
