/**
 * Seeded, deterministic PRNG for reproducible trace generation.
 *
 * We deliberately do NOT touch `Math.random()` anywhere in generation logic — a
 * given seed must always produce the exact same event stream, so the simulator
 * is unit-testable and benchmark runs are reproducible. `mulberry32` is a tiny,
 * fast, well-distributed 32-bit generator; good enough for synthetic data.
 */

/** A pure random source: `next()` returns a float in [0, 1). */
export interface Rng {
  /** Uniform float in [0, 1). */
  next(): number;
}

/**
 * Construct a mulberry32 PRNG from a 32-bit integer seed.
 *
 * Stateful by design (each `next()` advances the internal state), but fully
 * deterministic: `mulberry32(s)` always yields the same sequence.
 */
export function mulberry32(seed: number): Rng {
  let state = seed >>> 0;
  return {
    next(): number {
      state = (state + 0x6d2b79f5) | 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
  };
}

/** Integer in [min, max] inclusive. */
export function randInt(rng: Rng, min: number, max: number): number {
  return min + Math.floor(rng.next() * (max - min + 1));
}

/** Float in [min, max). */
export function randFloat(rng: Rng, min: number, max: number): number {
  return min + rng.next() * (max - min);
}

/** True with probability `p` in [0, 1]. */
export function chance(rng: Rng, p: number): boolean {
  return rng.next() < p;
}

/** Pick a uniformly-random element. Caller guarantees a non-empty array. */
export function pick<T>(rng: Rng, items: readonly T[]): T {
  // `items` is non-empty by contract; index is always in range.
  return items[randInt(rng, 0, items.length - 1)] as T;
}

/**
 * Weighted pick: choose an element proportional to its weight. `weights` must
 * be the same length as `items` and sum to a positive number.
 */
export function weightedPick<T>(
  rng: Rng,
  items: readonly T[],
  weights: readonly number[],
): T {
  const total = weights.reduce((a, b) => a + b, 0);
  let threshold = rng.next() * total;
  for (let i = 0; i < items.length; i++) {
    threshold -= weights[i] as number;
    if (threshold < 0) return items[i] as T;
  }
  return items[items.length - 1] as T;
}

/**
 * Approximate a log-normal-ish positive draw without `Math.log`/Box-Muller
 * overhead: average several uniform draws (central-limit → bell), then skew
 * toward the low end so most values cluster near `min` with a long right tail.
 * Good enough to give latency/token/cost distributions a realistic shape.
 */
export function skewed(rng: Rng, min: number, max: number, skew = 2): number {
  // Mean of `skew` uniforms is bell-shaped in [0,1]; raising to a power pushes
  // mass toward 0, producing a right-skewed (long-tail) distribution.
  let acc = 0;
  for (let i = 0; i < skew; i++) acc += rng.next();
  const u = Math.pow(acc / skew, 1.6);
  return min + u * (max - min);
}
