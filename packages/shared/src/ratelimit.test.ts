import { describe, expect, it } from "vitest";
import { clientIp, createRateLimiter } from "./ratelimit.ts";

describe("rate limiter", () => {
  it("allows up to max per window, then refuses with Retry-After until the window resets", () => {
    let t = 1_000_000;
    const rl = createRateLimiter(() => t);
    const limit = { max: 3, windowSeconds: 60 };
    expect([1, 2, 3].map(() => rl.take("a", limit).ok)).toEqual([true, true, true]);
    expect(rl.take("a", limit)).toEqual({ ok: false, retryAfterSeconds: 60 });
    expect(rl.take("b", limit).ok).toBe(true); // other keys are independent
    t += 45_000;
    expect(rl.take("a", limit)).toEqual({ ok: false, retryAfterSeconds: 15 });
    t += 15_000;
    expect(rl.take("a", limit).ok).toBe(true);
  });

  it("prunes expired windows instead of growing without bound", () => {
    let t = 0;
    const rl = createRateLimiter(() => t, 100);
    for (let i = 0; i < 100; i++) rl.take(`k${i}`, { max: 1, windowSeconds: 1 });
    t += 2_000;
    rl.take("new", { max: 1, windowSeconds: 1 });
    expect(rl.size).toBe(1);
  });

  it("reads the first X-Forwarded-For entry", () => {
    expect(clientIp("203.0.113.7, 10.0.0.1")).toBe("203.0.113.7");
    expect(clientIp(null)).toBe("direct");
    expect(clientIp("  ")).toBe("direct");
  });
});
