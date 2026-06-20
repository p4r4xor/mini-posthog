import type { ChartHint, QueryPlan } from "./query-plan.js";

/**
 * The shape returned by the query API to the frontend. Engine-neutral and
 * chart-ready: columns describe roles, rows are plain records, meta exposes the
 * (visible) query latency the UI displays.
 */

export type ColumnRole = "dimension" | "time" | "measure";

export interface ResultColumn {
  /** Output key present in every row. */
  name: string;
  role: ColumnRole;
}

export type CellValue = string | number | boolean | null;

export interface QueryResultMeta {
  /** Wall-clock execution time of the query, surfaced in the UI. */
  latencyMs: number;
  rowCount: number;
  /** Which storage adapter served the query (e.g. "duckdb", "clickhouse"). */
  engine: string;
  /** The validated plan that produced this result (for transparency/debug). */
  plan: QueryPlan;
}

export interface QueryResult {
  columns: ResultColumn[];
  rows: Array<Record<string, CellValue>>;
  meta: QueryResultMeta;
  chartHint: ChartHint;
}
