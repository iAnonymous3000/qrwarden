import { describe, expect, it } from "vitest";

import {
  matchConsecutiveFrames,
  orderDetections,
  type CameraDetection,
  type DetectionFrame,
} from "../../src/camera/matcher";

function detection(
  byte: string,
  x: number,
  y: number,
  originalIndex = 0,
): CameraDetection {
  const point = (dx: number, dy: number) => ({ x: x + dx, y: y + dy });
  return {
    fingerprint: {
      format: "QRCode",
      symbologyIdentifier: "]Q1",
      parsedVersion: 1,
      hasECI: false,
      bytesECI: { byteLength: 4, hex: `5d5131${byte}` },
      sequenceSize: -1,
      sequenceIndex: -1,
      sequenceId: "",
      rawBytes: { byteLength: 1, hex: byte },
    },
    position: {
      topLeft: point(-5, -5),
      topRight: point(5, -5),
      bottomRight: point(5, 5),
      bottomLeft: point(-5, 5),
    },
    originalIndex,
  };
}

function frame(detections: readonly CameraDetection[]): DetectionFrame {
  return { width: 1000, height: 500, detections };
}

describe("consecutive camera matching", () => {
  it("accepts one identical symbol under the 12 percent movement limit", () => {
    expect(
      matchConsecutiveFrames(frame([detection("aa", 100, 100)]), frame([detection("aa", 140, 110)])),
    ).toEqual({ kind: "accepted", currentByPrevious: [0] });
  });

  it("resets on identity, dimensions, and distance changes", () => {
    expect(
      matchConsecutiveFrames(frame([detection("aa", 100, 100)]), frame([detection("bb", 100, 100)])),
    ).toEqual({ kind: "reset" });
    expect(
      matchConsecutiveFrames(frame([detection("aa", 100, 100)]), {
        ...frame([detection("aa", 100, 100)]),
        width: 999,
      }),
    ).toEqual({ kind: "reset" });
    expect(
      matchConsecutiveFrames(frame([detection("aa", 100, 100)]), frame([detection("aa", 200, 100)])),
    ).toEqual({ kind: "reset" });
  });

  it("rejects an ambiguous perfect matching for identical nearby codes", () => {
    const previous = frame([
      detection("aa", 100, 100, 0),
      detection("aa", 120, 100, 1),
    ]);
    const current = frame([
      detection("aa", 105, 100, 0),
      detection("aa", 115, 100, 1),
    ]);
    expect(matchConsecutiveFrames(previous, current)).toEqual({ kind: "reset" });
  });

  it("uses y, x, then reader index for stable selection order", () => {
    const ordered = orderDetections([
      detection("aa", 200, 200, 2),
      detection("bb", 200, 100, 1),
      detection("cc", 100, 100, 0),
    ]);
    expect(ordered.map((entry) => entry.originalIndex)).toEqual([0, 1, 2]);
  });
});
