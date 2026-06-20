/**
 * The typed HTTP client. Three functions cover the whole UI surface:
 * `runQuery` (NL → QueryResult), `listTraces`, and `getTrace`. All calls are
 * same-origin — Vite proxies /query and /traces to the API on :3000 (see
 * vite.config.ts) — so we use relative paths and let the proxy/host resolve.
 */
import type {
  ListTracesParams,
  QueryRequest,
  QueryResponse,
  TraceDetail,
  TraceSummary,
} from "./types.js";

/** Thrown for transport/HTTP failures that aren't a structured query rejection. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** Build a query string from a params object, dropping undefined/empty values. */
function toQueryString(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === "") continue;
    search.set(key, String(value));
  }
  const qs = search.toString();
  return qs ? `?${qs}` : "";
}

/**
 * POST a natural-language question. Returns the discriminated `QueryResponse`:
 * a 200 carries `{ ok:true, ... }`, a 400 carries `{ ok:false, reason, supported }`.
 * Both are valid outcomes we render, so we return the body in either case and
 * only throw for genuinely unexpected statuses.
 */
export async function runQuery(req: QueryRequest): Promise<QueryResponse> {
  const res = await fetch("/query", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(req),
  });

  // 200 (ok:true) and 400 (ok:false) both carry a JSON envelope we want.
  if (res.status === 200 || res.status === 400) {
    return (await res.json()) as QueryResponse;
  }
  throw new ApiError(`Query failed (HTTP ${res.status})`, res.status);
}

/** GET the trace list for the explorer, with optional filters. */
export async function listTraces(params: ListTracesParams = {}): Promise<TraceSummary[]> {
  const res = await fetch(`/traces${toQueryString({ ...params })}`);
  if (!res.ok) throw new ApiError(`Failed to list traces (HTTP ${res.status})`, res.status);
  return (await res.json()) as TraceSummary[];
}

/** GET one trace with its runs + event timeline. Returns null on 404. */
export async function getTrace(traceId: string): Promise<TraceDetail | null> {
  const res = await fetch(`/traces/${encodeURIComponent(traceId)}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new ApiError(`Failed to load trace (HTTP ${res.status})`, res.status);
  return (await res.json()) as TraceDetail;
}
