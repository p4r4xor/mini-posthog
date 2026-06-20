/** Public surface of the typed API client. */
export { runQuery, listTraces, getTrace, ApiError } from "./client.js";
export type {
  QueryRequest,
  QueryResponse,
  QuerySuccess,
  QueryFailure,
  ListTracesParams,
  QueryResult,
  ResultColumn,
  CellValue,
  ColumnRole,
  QueryResultMeta,
  ChartHint,
  TraceSummary,
  TraceDetail,
  RunSummary,
  EventRow,
} from "./types.js";
