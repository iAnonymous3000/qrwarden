import { describe, expect, it } from "vitest";

import { PROBLEM_COPY, type ProblemCode } from "../../src/app/problems";
import { COPY } from "../../src/copy";

describe("problem recovery actions", () => {
  it.each(["camera-paused", "camera-stopped"] as const)(
    "offers a camera restart for %s",
    (problem) => {
      expect(PROBLEM_COPY[problem].primaryAction).toBe("resume-camera");
      expect(PROBLEM_COPY[problem].body).toContain(COPY.resumeScanning);
    },
  );

  it("does not offer a camera restart for unrelated problems", () => {
    const unrelated = Object.keys(PROBLEM_COPY).filter(
      (problem): problem is ProblemCode =>
        problem !== "camera-paused" && problem !== "camera-stopped",
    );

    expect(unrelated).not.toHaveLength(0);
    for (const problem of unrelated) {
      expect(PROBLEM_COPY[problem].primaryAction).toBeUndefined();
    }
  });

  it("keeps both recovery labels in reviewed copy", () => {
    expect(COPY.resumeScanning).toBe("Resume scanning");
    expect(COPY.tryAnotherCode).toBe("Try another code");
  });

  it("reserves danger styling for reader and link-integrity failures", () => {
    const dangerProblems = Object.entries(PROBLEM_COPY)
      .filter(([, copy]) => copy.tone === "danger")
      .map(([problem]) => problem);

    expect(dangerProblems).toEqual(["reader-stopped", "link-changed"]);
    expect(PROBLEM_COPY["no-result"].tone).toBe("recovery");
    expect(PROBLEM_COPY["camera-access-needed"].tone).toBe("recovery");
  });
});
