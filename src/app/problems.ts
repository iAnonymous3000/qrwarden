import { COPY } from "../copy";

export type ProblemCode =
  | "no-result"
  | "unsupported"
  | "overflow"
  | "image-too-large"
  | "unsupported-image-type"
  | "image-unreadable"
  | "took-too-long"
  | "choose-one-image"
  | "image-stopped"
  | "reader-stopped"
  | "link-changed"
  | "camera-unavailable"
  | "camera-access-needed"
  | "no-camera"
  | "camera-could-not-start"
  | "camera-stopped"
  | "camera-paused";

export interface ProblemCopy {
  readonly heading: string;
  readonly body: string;
  readonly primaryAction?: "resume-camera";
}

export const PROBLEM_COPY: Readonly<Record<ProblemCode, ProblemCopy>> =
  Object.freeze({
    "no-result": { heading: COPY.noQrHeading, body: COPY.noQrBody },
    unsupported: {
      heading: COPY.unsupportedCodeHeading,
      body: COPY.unsupportedCodeBody,
    },
    overflow: { heading: COPY.tooManyHeading, body: COPY.tooManyBody },
    "image-too-large": {
      heading: COPY.imageTooLargeHeading,
      body: COPY.imageTooLargeBody,
    },
    "unsupported-image-type": {
      heading: COPY.unsupportedImageHeading,
      body: COPY.unsupportedImageBody,
    },
    "image-unreadable": {
      heading: COPY.imageUnreadableHeading,
      body: COPY.imageUnreadableBody,
    },
    "took-too-long": {
      heading: COPY.timeoutHeading,
      body: COPY.timeoutBody,
    },
    "choose-one-image": {
      heading: COPY.chooseOneImageHeading,
      body: COPY.chooseOneImageBody,
    },
    "image-stopped": {
      heading: COPY.imageStoppedHeading,
      body: COPY.imageStoppedBody,
    },
    "reader-stopped": {
      heading: COPY.readerStoppedHeading,
      body: COPY.readerStoppedBody,
    },
    "link-changed": {
      heading: COPY.linkChangedHeading,
      body: COPY.linkChangedBody,
    },
    "camera-unavailable": {
      heading: COPY.cameraUnavailableHeading,
      body: COPY.cameraUnavailableBody,
    },
    "camera-access-needed": {
      heading: COPY.cameraAccessHeading,
      body: COPY.cameraAccessBody,
    },
    "no-camera": { heading: COPY.noCameraHeading, body: COPY.noCameraBody },
    "camera-could-not-start": {
      heading: COPY.cameraStartHeading,
      body: COPY.cameraStartBody,
    },
    "camera-stopped": {
      heading: COPY.cameraStoppedHeading,
      body: COPY.cameraStoppedBody,
      primaryAction: "resume-camera",
    },
    "camera-paused": {
      heading: COPY.cameraPausedHeading,
      body: COPY.cameraPausedBody,
      primaryAction: "resume-camera",
    },
  });
