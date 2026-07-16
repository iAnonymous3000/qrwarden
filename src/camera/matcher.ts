export interface FrozenBytes {
  readonly byteLength: number;
  readonly hex: string;
}

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface Quadrilateral {
  readonly topLeft: Point;
  readonly topRight: Point;
  readonly bottomRight: Point;
  readonly bottomLeft: Point;
}

export interface DetectionFingerprint {
  readonly format: string;
  readonly symbologyIdentifier: string;
  readonly parsedVersion: number | null;
  readonly hasECI: boolean;
  readonly bytesECI: FrozenBytes;
  readonly sequenceSize: number;
  readonly sequenceIndex: number;
  readonly sequenceId: string;
  readonly rawBytes: FrozenBytes;
}

export interface CameraDetection {
  readonly fingerprint: DetectionFingerprint;
  readonly position: Quadrilateral;
  readonly originalIndex: number;
}

export interface DetectionFrame {
  readonly width: number;
  readonly height: number;
  readonly detections: readonly CameraDetection[];
}

function sameBytes(left: FrozenBytes, right: FrozenBytes): boolean {
  return (
    left.byteLength === right.byteLength &&
    left.hex.length === left.byteLength * 2 &&
    right.hex.length === right.byteLength * 2 &&
    left.hex === right.hex
  );
}

export function sameFingerprint(
  left: DetectionFingerprint,
  right: DetectionFingerprint,
): boolean {
  return (
    left.format === right.format &&
    left.symbologyIdentifier === right.symbologyIdentifier &&
    left.parsedVersion === right.parsedVersion &&
    left.hasECI === right.hasECI &&
    sameBytes(left.bytesECI, right.bytesECI) &&
    left.sequenceSize === right.sequenceSize &&
    left.sequenceIndex === right.sequenceIndex &&
    left.sequenceId === right.sequenceId &&
    sameBytes(left.rawBytes, right.rawBytes)
  );
}

export function centroid(position: Quadrilateral): Point {
  const points = [
    position.topLeft,
    position.topRight,
    position.bottomRight,
    position.bottomLeft,
  ];
  return Object.freeze({
    x: points.reduce((sum, point) => sum + point.x, 0) / points.length,
    y: points.reduce((sum, point) => sum + point.y, 0) / points.length,
  });
}

function normalizedDistance(
  previous: CameraDetection,
  current: CameraDetection,
  width: number,
  height: number,
): number {
  const left = centroid(previous.position);
  const right = centroid(current.position);
  const dx = ((right.x / width) - (left.x / width)) * width;
  const dy = ((right.y / height) - (left.y / height)) * height;
  return Math.hypot(dx, dy) / Math.min(width, height);
}

function findPerfectMatching(
  edges: readonly (readonly number[])[],
  forbidden: readonly [number, number] | null = null,
): readonly number[] | null {
  const matchedPreviousByCurrent = new Array<number>(edges.length).fill(-1);

  const visit = (previousIndex: number, seen: boolean[]): boolean => {
    for (const currentIndex of edges[previousIndex] ?? []) {
      if (
        forbidden !== null &&
        forbidden[0] === previousIndex &&
        forbidden[1] === currentIndex
      ) {
        continue;
      }
      if (seen[currentIndex]) {
        continue;
      }
      seen[currentIndex] = true;
      const incumbent = matchedPreviousByCurrent[currentIndex] ?? -1;
      if (incumbent === -1 || visit(incumbent, seen)) {
        matchedPreviousByCurrent[currentIndex] = previousIndex;
        return true;
      }
    }
    return false;
  };

  for (let previousIndex = 0; previousIndex < edges.length; previousIndex += 1) {
    if (!visit(previousIndex, new Array<boolean>(edges.length).fill(false))) {
      return null;
    }
  }

  const currentByPrevious = new Array<number>(edges.length).fill(-1);
  for (
    let currentIndex = 0;
    currentIndex < matchedPreviousByCurrent.length;
    currentIndex += 1
  ) {
    const previousIndex = matchedPreviousByCurrent[currentIndex] ?? -1;
    if (previousIndex >= 0) {
      currentByPrevious[previousIndex] = currentIndex;
    }
  }
  return currentByPrevious.every((value) => value >= 0)
    ? Object.freeze(currentByPrevious)
    : null;
}

export type FrameMatch =
  | { readonly kind: "accepted"; readonly currentByPrevious: readonly number[] }
  | { readonly kind: "reset" };

export function matchConsecutiveFrames(
  previous: DetectionFrame,
  current: DetectionFrame,
): FrameMatch {
  const count = previous.detections.length;
  if (
    count < 1 ||
    count > 8 ||
    current.detections.length !== count ||
    previous.width !== current.width ||
    previous.height !== current.height ||
    previous.width <= 0 ||
    previous.height <= 0
  ) {
    return Object.freeze({ kind: "reset" });
  }

  const edges = previous.detections.map((prior) =>
    Object.freeze(
      current.detections.flatMap((candidate, currentIndex) =>
        sameFingerprint(prior.fingerprint, candidate.fingerprint) &&
        normalizedDistance(prior, candidate, previous.width, previous.height) <= 0.12
          ? [currentIndex]
          : [],
      ),
    ),
  );

  const matching = findPerfectMatching(edges);
  if (matching === null) {
    return Object.freeze({ kind: "reset" });
  }

  for (let previousIndex = 0; previousIndex < matching.length; previousIndex += 1) {
    const currentIndex = matching[previousIndex];
    if (currentIndex === undefined) {
      return Object.freeze({ kind: "reset" });
    }
    if (findPerfectMatching(edges, [previousIndex, currentIndex]) !== null) {
      return Object.freeze({ kind: "reset" });
    }
  }

  return Object.freeze({ kind: "accepted", currentByPrevious: matching });
}

export function orderDetections(
  detections: readonly CameraDetection[],
): readonly CameraDetection[] {
  return Object.freeze(
    [...detections].sort((left, right) => {
      const a = centroid(left.position);
      const b = centroid(right.position);
      return a.y - b.y || a.x - b.x || left.originalIndex - right.originalIndex;
    }),
  );
}
