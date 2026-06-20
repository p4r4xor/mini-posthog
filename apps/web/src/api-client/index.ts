/** Public surface of the typed API client. */
export { ApiError, getTrace, listTraces, runQuery } from "./client.js";
export type {
  CellValue,
  ChartHint,
  ColumnRole,
  EventRow,
  ListTracesParams,
  QueryFailure,
  QueryRequest,
  QueryResponse,
  QueryResult,
  QueryResultMeta,
  QuerySuccess,
  ResultColumn,
  RunSummary,
  TraceDetail,
  TraceSummary,
} from "./types.js";
