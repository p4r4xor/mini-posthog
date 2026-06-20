/**
 * Re-exports the contract types the UI consumes, plus the HTTP envelope shapes
 * the backend wraps responses in (these envelopes live at the API boundary, not
 * in @ata/contracts, so we model them here).
 */
import type { QueryResult } from "@ata/contracts";

export type {
  CellValue,
  ChartHint,
  ColumnRole,
  EventRow,
  QueryResult,
  QueryResultMeta,
  ResultColumn,
  RunSummary,
  TraceDetail,
  TraceSummary,
} from "@ata/contracts";

/** Request body for `POST /query`. */
export interface QueryRequest {
  q: string;
  timeRange?: { from: string; to: string };
  limit?: number;
}

/** Successful `POST /query` response - a chart-ready result + its provenance. */
export interface QuerySuccess {
  ok: true;
  /** Whether the deterministic catalog or the LLM fallback planned the query. */
  source: "deterministic" | "llm";
  result: QueryResult;
}

/** Rejected query - the NL did not map onto a supported plan. */
export interface QueryFailure {
  ok: false;
  reason: string;
  /** Human-readable list of questions the backend knows how to answer. */
  supported: string[];
}

export type QueryResponse = QuerySuccess | QueryFailure;

/** Filters accepted by `GET /traces` (all optional, sent as query params). */
export interface ListTracesParams {
  from?: string;
  to?: string;
  agentName?: string;
  model?: string;
  toolName?: string;
  status?: string;
  userId?: string;
  limit?: number;
  offset?: number;
}
