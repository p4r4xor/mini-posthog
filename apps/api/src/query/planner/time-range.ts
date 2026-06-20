import type { TimeRange } from "@ata/contracts";

/**
 * Parse a time window out of a natural-language question (docs/architecture.md §10).
 *
 * Returns a {from,to} range when the text contains a time expression, else null
 * (the caller then falls back to the default lookback / an explicit request range).
 * Deterministic: everything is computed from the injected `now` in UTC, so it
 * matches the UTC timestamps we store and is reproducible in tests.
 *
 * Supported:
 *   - relative:  "last/past N hours|days|weeks|months", "last hour",
 *                "last 24 hours", "today", "yesterday",
 *                "this week|month", "last week|month"
 *   - absolute:  "on 18th June", "on June 18", "on 2026-06-18", a bare such date
 *   - ranges:    "between <date> and <date>", "from <date> to <date>", "since <date>"
 */

const MS_HOUR = 3_600_000;
const MS_DAY = 86_400_000;

const MONTHS: Record<string, number> = {
  jan: 0,
  january: 0,
  feb: 1,
  february: 1,
  mar: 2,
  march: 2,
  apr: 3,
  april: 3,
  may: 4,
  jun: 5,
  june: 5,
  jul: 6,
  july: 6,
  aug: 7,
  august: 7,
  sep: 8,
  sept: 8,
  september: 8,
  oct: 9,
  october: 9,
  nov: 10,
  november: 10,
  dec: 11,
  december: 11,
};

const iso = (ms: number): string => new Date(ms).toISOString();
const range = (fromMs: number, toMs: number): TimeRange => ({
  from: iso(fromMs),
  to: iso(toMs),
});

function startOfUTCDay(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}
function startOfUTCMonth(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}
/** Monday-based start of the week containing `ms`. */
function startOfUTCWeek(ms: number): number {
  const day = new Date(ms).getUTCDay(); // 0=Sun..6=Sat
  const sinceMonday = (day + 6) % 7;
  return startOfUTCDay(ms) - sinceMonday * MS_DAY;
}

/** Pick the year so a bare month/day lands in the recent past, not the future. */
function yearFor(month: number, day: number, now: Date): number {
  const y = now.getUTCFullYear();
  const candidate = Date.UTC(y, month, day);
  return candidate > now.getTime() + MS_DAY ? y - 1 : y;
}

/** Parse a single calendar date (UTC midnight) from a fragment, or null. */
function parseDate(fragment: string, now: Date): number | null {
  const s = fragment.trim();
  const isoM = s.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (isoM) return Date.UTC(Number(isoM[1]), Number(isoM[2]) - 1, Number(isoM[3]));

  // "june 18" / "june 18th"
  const md = s.match(/\b([a-z]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b/);
  if (md && MONTHS[md[1]!] !== undefined) {
    const m = MONTHS[md[1]!]!;
    const day = Number(md[2]);
    return Date.UTC(yearFor(m, day, now), m, day);
  }
  // "18 june" / "18th june" / "18th of june"
  const dm = s.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?([a-z]+)\b/);
  if (dm && MONTHS[dm[2]!] !== undefined) {
    const m = MONTHS[dm[2]!]!;
    const day = Number(dm[1]);
    return Date.UTC(yearFor(m, day, now), m, day);
  }
  return null;
}

export function parseTimeRange(nl: string, now: Date): TimeRange | null {
  const text = nl.toLowerCase();
  const nowMs = now.getTime();

  const rel = text.match(/\b(?:last|past|previous)\s+(\d+)\s*(hour|day|week|month)s?\b/);
  if (rel) {
    const n = Number(rel[1]);
    const unit = rel[2];
    const mult =
      unit === "hour"
        ? MS_HOUR
        : unit === "day"
          ? MS_DAY
          : unit === "week"
            ? 7 * MS_DAY
            : 30 * MS_DAY;
    return range(nowMs - n * mult, nowMs);
  }
  if (/\b(?:last|past)\s+hour\b/.test(text)) return range(nowMs - MS_HOUR, nowMs);
  if (/\btoday\b/.test(text)) return range(startOfUTCDay(nowMs), nowMs);
  if (/\byesterday\b/.test(text)) {
    const s = startOfUTCDay(nowMs);
    return range(s - MS_DAY, s);
  }
  if (/\bthis week\b/.test(text)) return range(startOfUTCWeek(nowMs), nowMs);
  if (/\blast week\b/.test(text)) {
    const w = startOfUTCWeek(nowMs);
    return range(w - 7 * MS_DAY, w);
  }
  if (/\bthis month\b/.test(text)) return range(startOfUTCMonth(nowMs), nowMs);
  if (/\blast month\b/.test(text)) {
    const m = startOfUTCMonth(nowMs);
    return range(startOfUTCMonth(m - 1), m);
  }

  const between = text.match(
    /\b(?:between|from)\s+(.+?)\s+(?:and|to|until|till)\s+(.+?)(?:[.?!]|$)/,
  );
  if (between) {
    const a = parseDate(between[1]!, now);
    const b = parseDate(between[2]!, now);
    if (a !== null && b !== null)
      return range(startOfUTCDay(a), startOfUTCDay(b) + MS_DAY);
  }

  const since = text.match(/\b(?:since|after)\s+(.+?)(?:[.?!]|$)/);
  if (since) {
    const a = parseDate(since[1]!, now);
    if (a !== null) return range(startOfUTCDay(a), nowMs);
  }

  // Single day: "on <date>", else a bare date anywhere in the text.
  const onMatch = text.match(/\bon\s+(.+?)(?:[.?!]|$)/);
  const dayMs = onMatch ? parseDate(onMatch[1]!, now) : parseDate(text, now);
  if (dayMs !== null) return range(dayMs, dayMs + MS_DAY);

  return null;
}
