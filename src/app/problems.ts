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
  readonly primaryAction?: "resume-camera" | "retry-camera";
  readonly imageFallback?: boolean;
  readonly tone: "danger" | "recovery";
}

export const PROBLEM_COPY: Readonly<Record<ProblemCode, ProblemCopy>> =
  Object.freeze({
    "no-result": {
      heading: COPY.noQrHeading,
      body: COPY.noQrBody,
      tone: "recovery",
    },
    unsupported: {
      heading: COPY.unsupportedCodeHeading,
      body: COPY.unsupportedCodeBody,
      tone: "recovery",
    },
    overflow: {
      heading: COPY.tooManyHeading,
      body: COPY.tooManyBody,
      tone: "recovery",
    },
    "image-too-large": {
      heading: COPY.imageTooLargeHeading,
      body: COPY.imageTooLargeBody,
      tone: "recovery",
    },
    "unsupported-image-type": {
      heading: COPY.unsupportedImageHeading,
      body: COPY.unsupportedImageBody,
      tone: "recovery",
    },
    "image-unreadable": {
      heading: COPY.imageUnreadableHeading,
      body: COPY.imageUnreadableBody,
      tone: "recovery",
    },
    "took-too-long": {
      heading: COPY.timeoutHeading,
      body: COPY.timeoutBody,
      tone: "recovery",
    },
    "choose-one-image": {
      heading: COPY.chooseOneImageHeading,
      body: COPY.chooseOneImageBody,
      tone: "recovery",
    },
    "image-stopped": {
      heading: COPY.imageStoppedHeading,
      body: COPY.imageStoppedBody,
      tone: "recovery",
    },
    "reader-stopped": {
      heading: COPY.readerStoppedHeading,
      body: COPY.readerStoppedBody,
      tone: "danger",
    },
    "link-changed": {
      heading: COPY.linkChangedHeading,
      body: COPY.linkChangedBody,
      tone: "danger",
    },
    "camera-unavailable": {
      heading: COPY.cameraUnavailableHeading,
      body: COPY.cameraUnavailableBody,
      primaryAction: "retry-camera",
      imageFallback: true,
      tone: "recovery",
    },
    "camera-access-needed": {
      heading: COPY.cameraAccessHeading,
      body: COPY.cameraAccessBody,
      primaryAction: "retry-camera",
      imageFallback: true,
      tone: "recovery",
    },
    "no-camera": {
      heading: COPY.noCameraHeading,
      body: COPY.noCameraBody,
      primaryAction: "retry-camera",
      imageFallback: true,
      tone: "recovery",
    },
    "camera-could-not-start": {
      heading: COPY.cameraStartHeading,
      body: COPY.cameraStartBody,
      primaryAction: "retry-camera",
      imageFallback: true,
      tone: "recovery",
    },
    "camera-stopped": {
      heading: COPY.cameraStoppedHeading,
      body: COPY.cameraStoppedBody,
      primaryAction: "resume-camera",
      tone: "recovery",
    },
    "camera-paused": {
      heading: COPY.cameraPausedHeading,
      body: COPY.cameraPausedBody,
      primaryAction: "resume-camera",
      tone: "recovery",
    },
  });
