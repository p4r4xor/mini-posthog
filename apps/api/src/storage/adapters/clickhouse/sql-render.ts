import type {
  CompiledGroupKey,
  CompiledMetric,
  CompiledPredicate,
  CompiledQuery,
  TimeGrain,
} from "@ata/contracts";
import { resolveField, resolveSource } from "./field-map.js";

/**
 * Render a neutral `CompiledQuery` into ClickHouse SQL with BOUND PARAMETERS using
 * ClickHouse's `{name:Type}` placeholder syntax + a `query_params` map (NO string
 * interpolation of values → injection-safe, docs/architecture.md §9). Only
 * whitelisted column names / operators are interpolated.
 *
 * The renderer owns the dialect: `toStartOfMinute/Hour/Day(ts)` for time buckets,
 * `countIf(cond)` for ratio predicates, `quantile({p})(col)` for percentiles,
 * `{pN:Type}` placeholders.
 */
export interface RenderedSql {
  sql: string;
  /** Named bind values for ClickHouse `query_params` (keys match `{name:Type}`). */
  params: Record<string, unknown>;
}

/** Collects bind params and hands back the matching `{pN:Type}` placeholder. */
class ParamBag {
  readonly values: Record<string, unknown> = {};
  private n = 0;

  /** Bind a value, inferring its ClickHouse param type, return the placeholder. */
  add(value: unknown): string {
    const name = `p${this.n++}`;
    this.values[name] = value;
    return `{${name}:${chType(value)}}`;
  }
}

/**
 * Infer the ClickHouse param type for a JS value. We keep this conservative: our
 * compared values are tenant ids / enum strings / numbers / ISO timestamps. Strings
 * default to `String`; ClickHouse coerces a String literal to the column type
 * (LowCardinality/Enum/DateTime) on comparison, which is exactly what we want for
 * the timeRange (DateTime64) and event_type (Enum8) predicates.
 */
function chType(value: unknown): string {
  if (typeof value === "number") {
    return Number.isInteger(value) ? "Int64" : "Float64";
  }
  if (typeof value === "boolean") return "Bool";
  return "String";
}

/**
 * Normalise an ISO-8601 timestamp into a ClickHouse DateTime64(3) literal
 * "YYYY-MM-DD HH:MM:SS.mmm" in UTC (ClickHouse does not accept the trailing-Z ISO
 * form for DateTime64 comparison params).
 */
function toChDateTime(iso8601: string): string {
  const d = new Date(iso8601);
  if (Number.isNaN(d.getTime())) return iso8601;
  const pad = (val: number, w = 2) => String(val).padStart(w, "0");
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.` +
    `${pad(d.getUTCMilliseconds(), 3)}`
  );
}

const FILTER_OP_SQL = {
  eq: "=",
  neq: "!=",
  gt: ">",
  gte: ">=",
  lt: "<",
  lte: "<=",
} as const;

/** Time-bucket expression per grain (col already resolved). */
function bucketExpr(grain: TimeGrain, col: string): string {
  switch (grain) {
    case "second":
      return `toStartOfSecond(${col})`; // needs DateTime64 - our timestamp is
    case "minute":
      return `toStartOfMinute(${col})`;
    case "hour":
      return `toStartOfHour(${col})`;
    case "day":
      return `toStartOfDay(${col})`;
    case "week":
      return `toStartOfWeek(${col}, 1)`; // mode 1 = Monday, matches DuckDB ISO week
    case "month":
      return `toStartOfMonth(${col})`;
  }
}

/** Render one predicate to a SQL boolean expression, binding its value(s). */
function renderPredicate(
  source: CompiledQuery["source"],
  pred: CompiledPredicate,
  bag: ParamBag,
): string {
  if (pred.kind === "timeRange") {
    const col = resolveField(source, pred.column);
    // half-open [from, to). Bind as CH DateTime64 literals ("YYYY-MM-DD
    // HH:MM:SS.mmm", UTC) - ClickHouse won't coerce an ISO-8601 "...Z" string to
    // DateTime64 directly, so we normalise here (param values are still bound, not
    // interpolated → injection-safe).
    const from = bag.add(toChDateTime(pred.from));
    const to = bag.add(toChDateTime(pred.to));
    return `${col} >= ${from} AND ${col} < ${to}`;
  }

  const col = resolveField(source, pred.column);

  if (pred.op === "in") {
    const list = Array.isArray(pred.value) ? pred.value : [pred.value];
    if (list.length === 0) return "1 = 0";
    const placeholders = list.map((v) => bag.add(v)).join(", ");
    return `${col} IN (${placeholders})`;
  }

  const opSql = FILTER_OP_SQL[pred.op];
  const ph = bag.add(pred.value);
  return `${col} ${opSql} ${ph}`;
}

/** Render the metric expression, aliased to the metric's alias. */
function renderMetric(
  source: CompiledQuery["source"],
  metric: CompiledMetric,
  bag: ParamBag,
): string {
  switch (metric.kind) {
    case "count":
      return `count(*) AS \`${metric.alias}\``;
    case "count_distinct": {
      const col = resolveField(source, metric.column);
      return `uniqExact(${col}) AS \`${metric.alias}\``;
    }
    case "simple": {
      const col = resolveField(source, metric.column);
      return `${metric.fn}(${col}) AS \`${metric.alias}\``;
    }
    case "quantile": {
      const col = resolveField(source, metric.column);
      // p is a validated number in (0,1); inlined as a numeric literal (no
      // injection surface). ClickHouse requires a constant fraction here.
      return `quantile(${Number(metric.p)})(${col}) AS \`${metric.alias}\``;
    }
    case "ratio": {
      const num = renderCountIf(source, metric.numerator, bag);
      const den = renderCountIf(source, metric.denominator, bag);
      // Guard divide-by-zero → NULL (cleaner than NaN/Inf for the chart layer).
      return `(${num} / nullIf(${den}, 0)) AS \`${metric.alias}\``;
    }
  }
}

/** countIf(predicate AND …); an empty predicate list counts all rows. */
function renderCountIf(
  source: CompiledQuery["source"],
  preds: CompiledPredicate[],
  bag: ParamBag,
): string {
  if (preds.length === 0) return "count(*)";
  const cond = preds.map((p) => renderPredicate(source, p, bag)).join(" AND ");
  return `countIf(${cond})`;
}

/** Render a group key to its SELECT expression, aliased. */
function renderGroupKeyExpr(
  source: CompiledQuery["source"],
  key: CompiledGroupKey,
): string {
  if (key.kind === "timeBucket") {
    const col = resolveField(source, key.column);
    return `${bucketExpr(key.grain, col)} AS \`${key.alias}\``;
  }
  const col = resolveField(source, key.column);
  return `${col} AS \`${key.alias}\``;
}

/** The bare grouping expression (no alias) for GROUP BY. */
function renderGroupKeyBare(
  source: CompiledQuery["source"],
  key: CompiledGroupKey,
): string {
  if (key.kind === "timeBucket") {
    const col = resolveField(source, key.column);
    return `${bucketExpr(key.grain, col)}`;
  }
  return resolveField(source, key.column);
}

export function renderAggregate(query: CompiledQuery): RenderedSql {
  const bag = new ParamBag();
  const source = resolveSource(query.source);

  const selectParts: string[] = [];
  for (const key of query.groupBy) {
    selectParts.push(renderGroupKeyExpr(query.source, key));
  }
  selectParts.push(renderMetric(query.source, query.metric, bag));

  let sql = `SELECT ${selectParts.join(", ")} FROM ${source}`;

  if (query.where.length > 0) {
    const conds = query.where.map((p) => renderPredicate(query.source, p, bag));
    sql += ` WHERE ${conds.join(" AND ")}`;
  }

  if (query.groupBy.length > 0) {
    const groupExprs = query.groupBy.map((k) => renderGroupKeyBare(query.source, k));
    sql += ` GROUP BY ${groupExprs.join(", ")}`;
  }

  if (query.orderBy) {
    // ref is an alias (metric or group key); backtick-quote it so it binds to the
    // output column.
    const dir = query.orderBy.dir === "desc" ? "DESC" : "ASC";
    sql += ` ORDER BY \`${query.orderBy.ref}\` ${dir}`;
  }

  if (query.limit !== undefined) {
    sql += ` LIMIT ${Math.trunc(query.limit)}`;
  }

  return { sql, params: bag.values };
}
