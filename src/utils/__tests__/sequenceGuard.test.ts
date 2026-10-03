import { describe, it, expect } from "vitest";
import { createSequenceGuard } from "@/utils/sequenceGuard";

describe("createSequenceGuard", () => {
  it("issues monotonically increasing tokens", () => {
    const guard = createSequenceGuard();
    const first = guard.next();
    const second = guard.next();
    expect(second).toBeGreaterThan(first);
  });

  it("reports the latest issued token as current", () => {
    const guard = createSequenceGuard();
    const token = guard.next();
    expect(guard.isCurrent(token)).toBe(true);
  });

  it("reports a superseded token as not current", () => {
    const guard = createSequenceGuard();
    const stale = guard.next();
    guard.next(); // a newer request started
    expect(guard.isCurrent(stale)).toBe(false);
  });

  it("isolates separate guards", () => {
    const a = createSequenceGuard();
    const b = createSequenceGuard();
    const tokenA = a.next();
    b.next();
    b.next();
    // b advancing must not invalidate a's own latest token.
    expect(a.isCurrent(tokenA)).toBe(true);
  });
});
