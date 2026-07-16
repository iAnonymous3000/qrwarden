import { describe, expect, it, vi } from "vitest";

import { WorkState } from "../../src/app/workState";

describe("work generation", () => {
  it("invalidates stale callbacks and suspends idempotently", () => {
    const state = new WorkState();
    const token = state.begin();
    const cleanup = vi.fn();
    state.retain(cleanup);
    expect(state.isLive(token)).toBe(true);
    state.suspend();
    state.suspend();
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(state.isLive(token)).toBe(false);
  });

  it("resumes only with a fresh generation after suspension", () => {
    const state = new WorkState();
    const beforeSuspend = state.begin();

    state.suspend();
    const afterResume = state.begin();

    expect(state.suspended).toBe(false);
    expect(afterResume).toBeGreaterThan(beforeSuspend);
    expect(state.isLive(beforeSuspend)).toBe(false);
    expect(state.isLive(afterResume)).toBe(true);
  });

  it("can transfer retained ownership away before suspension", () => {
    const state = new WorkState();
    const cleanup = vi.fn();
    const release = state.retain(cleanup);
    expect(state.hasRetainedResources).toBe(true);

    release();
    release();
    expect(state.hasRetainedResources).toBe(false);
    state.suspend();

    expect(cleanup).not.toHaveBeenCalled();
  });

  it("continues closing retained resources when one cleanup throws", () => {
    const state = new WorkState();
    const first = vi.fn(() => {
      throw new Error("cleanup failed");
    });
    const second = vi.fn();
    const third = vi.fn();
    state.retain(first);
    state.retain(second);
    state.retain(third);

    expect(() => state.suspend()).not.toThrow();
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    expect(third).toHaveBeenCalledTimes(1);
    expect(state.hasRetainedResources).toBe(false);
  });

  it("immediately closes a resource retained after suspension", () => {
    const state = new WorkState();
    const cleanup = vi.fn();
    state.suspend();

    const release = state.retain(cleanup);
    release();

    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(state.hasRetainedResources).toBe(false);
  });

  it("makes callbacks stale immediately while retaining cleanup ownership", () => {
    const state = new WorkState();
    const token = state.begin();
    const cleanup = vi.fn();
    state.retain(cleanup);

    const invalidatedGeneration = state.invalidate();

    expect(state.isLive(token)).toBe(false);
    expect(state.isLive(invalidatedGeneration)).toBe(true);
    expect(state.hasRetainedResources).toBe(true);
    expect(cleanup).not.toHaveBeenCalled();

    state.suspend();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });
});
