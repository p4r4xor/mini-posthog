import { describe, expect, it } from "vitest";
import { parseTimeRange } from "../../src/query/planner/time-range.js";

// Fixed "now" for determinism: Sat 2026-06-20 12:00 UTC.
const NOW = new Date("2026-06-20T12:00:00.000Z");

describe("parseTimeRange", () => {
  it("absolute single day: 'on 18th June' → that whole UTC day", () => {
    expect(parseTimeRange("which tools fail the most on 18th June", NOW)).toEqual({
      from: "2026-06-18T00:00:00.000Z",
      to: "2026-06-19T00:00:00.000Z",
    });
  });

  it("absolute single day: 'on June 18' and ISO '2026-06-18' agree", () => {
    const a = parseTimeRange("errors on June 18", NOW);
    const b = parseTimeRange("errors on 2026-06-18", NOW);
    expect(a).toEqual(b);
    expect(a?.from).toBe("2026-06-18T00:00:00.000Z");
  });

  it("relative: 'last 24 hours'", () => {
    expect(parseTimeRange("avg latency over the last 24 hours", NOW)).toEqual({
      from: "2026-06-19T12:00:00.000Z",
      to: "2026-06-20T12:00:00.000Z",
    });
  });

  it("relative: 'yesterday'", () => {
    expect(parseTimeRange("how many runs yesterday", NOW)).toEqual({
      from: "2026-06-19T00:00:00.000Z",
      to: "2026-06-20T00:00:00.000Z",
    });
  });

  it("range: 'between June 1 and June 10' is end-exclusive of the next day", () => {
    expect(parseTimeRange("cost between June 1 and June 10", NOW)).toEqual({
      from: "2026-06-01T00:00:00.000Z",
      to: "2026-06-11T00:00:00.000Z",
    });
  });

  it("'since June 15' runs up to now", () => {
    expect(parseTimeRange("errors since June 15", NOW)).toEqual({
      from: "2026-06-15T00:00:00.000Z",
      to: "2026-06-20T12:00:00.000Z",
    });
  });

  it("numeric dates: DD/MM/YYYY, MM/DD/YYYY, YYYY/MM/DD all resolve to the same day", () => {
    const expected = {
      from: "2026-06-20T00:00:00.000Z",
      to: "2026-06-21T00:00:00.000Z",
    };
    expect(parseTimeRange("average steps per run by outcome on 20/06/2026", NOW)).toEqual(
      expected,
    );
    expect(parseTimeRange("errors on 06/20/2026", NOW)).toEqual(expected); // unambiguous MM/DD
    expect(parseTimeRange("errors on 2026/06/20", NOW)).toEqual(expected);
    expect(parseTimeRange("errors on 2026-06-20", NOW)).toEqual(expected);
    // different day → different window
    expect(parseTimeRange("errors on 15/06/2026", NOW)?.from).toBe(
      "2026-06-15T00:00:00.000Z",
    );
  });

  it("returns null when there is no time expression (so the default applies)", () => {
    expect(parseTimeRange("which tools fail the most", NOW)).toBeNull();
    expect(parseTimeRange("p95 LLM latency by model", NOW)).toBeNull();
    expect(parseTimeRange("top 10 slowest traces", NOW)).toBeNull();
    expect(parseTimeRange("number of runs per hour", NOW)).toBeNull();
  });
});
