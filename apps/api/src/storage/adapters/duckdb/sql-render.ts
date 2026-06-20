import type {
  CompiledGroupKey,
  CompiledMetric,
  CompiledPredicate,
  CompiledQuery,
  TimeGrain,
} from "@ata/contracts";
import { resolveField, resolveSource } from "./field-map.js";

/**
 * Render a neutral `CompiledQuery` into DuckDB SQL with BOUND PARAMETERS
 * (positional `$1, $2, …`). All user/data values flow through `params`; only
 * whitelisted column names and operators are interpolated, so there is no
 * injection surface (docs/architecture.md §9).
 *
 * The renderer owns the dialect: `date_trunc(grain, ts)` for time buckets,
 * `count_if(...)` for ratio predicates, `$n` placeholders.
 */

export interface RenderedSql {
  sql: string;
  /** Positional bind values, 1-indexed in SQL (params[0] → $1). */
  params: unknown[];
}

/** Collects bind params and hands back the matching `$n` placeholder. */
class ParamBag {
  readonly values: unknown[] = [];
  add(value: unknown): string {
    this.values.push(value);
    return `$${this.values.length}`;
  }
}

const FILTER_OP_SQL = {
  eq: "=",
  neq: "!=",
  gt: ">",
  gte: ">=",
  lt: "<",
  lte: "<=",
} as const;

function grainSql(grain: TimeGrain): string {
  // DuckDB date_trunc accepts 'second' | 'minute' | 'hour' | 'day' directly.
  return grain;
}

/** Render one predicate to a SQL boolean expression, binding its value(s). */
function renderPredicate(
  source: CompiledQuery["source"],
  pred: CompiledPredicate,
  bag: ParamBag,
): string {
  if (pred.kind === "timeRange") {
    const col = resolveField(source, pred.column);
    const from = bag.add(pred.from);
    const to = bag.add(pred.to);
    // half-open [from, to) - standard for time buckets.
    return `${col} >= ${from} AND ${col} < ${to}`;
  }

  const col = resolveField(source, pred.column);

  if (pred.op === "in") {
    const list = Array.isArray(pred.value) ? pred.value : [pred.value];
    if (list.length === 0) return "FALSE";
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
      return `count(*) AS "${metric.alias}"`;
    case "count_distinct": {
      const col = resolveField(source, metric.column);
      return `count(DISTINCT ${col}) AS "${metric.alias}"`;
    }
    case "simple": {
      const col = resolveField(source, metric.column);
      return `${metric.fn}(${col}) AS "${metric.alias}"`;
    }
    case "quantile": {
      const col = resolveField(source, metric.column);
      // p is a validated number in (0,1); inlined as a numeric literal (no
      // injection surface). DuckDB requires a constant fraction here.
      return `quantile_cont(${col}, ${Number(metric.p)}) AS "${metric.alias}"`;
    }
    case "ratio": {
      const num = renderCountIf(source, metric.numerator, bag);
      const den = renderCountIf(source, metric.denominator, bag);
      // Guard divide-by-zero → NULL (cleaner than NaN/Inf for the chart layer).
      return `(${num} * 1.0 / nullif(${den}, 0)) AS "${metric.alias}"`;
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
  return `count(*) FILTER (WHERE ${cond})`;
}

/** Render a group key to its SELECT expression, aliased. */
function renderGroupKeyExpr(
  source: CompiledQuery["source"],
  key: CompiledGroupKey,
): string {
  if (key.kind === "timeBucket") {
    const col = resolveField(source, key.column);
    return `date_trunc('${grainSql(key.grain)}', ${col}) AS "${key.alias}"`;
  }
  const col = resolveField(source, key.column);
  return `${col} AS "${key.alias}"`;
}

/** The bare grouping expression (no alias) for GROUP BY. */
function renderGroupKeyBare(
  source: CompiledQuery["source"],
  key: CompiledGroupKey,
): string {
  if (key.kind === "timeBucket") {
    const col = resolveField(source, key.column);
    return `date_trunc('${grainSql(key.grain)}', ${col})`;
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
  // Metric last so ratio params are bound after group/where in $n order. Order of
  // param binding doesn't matter for correctness (each $n is positional), but we
  // build SELECT then WHERE then ORDER deterministically.
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
    // ref is an alias (metric or group key); quote it so it binds to the output column.
    const dir = query.orderBy.dir === "desc" ? "DESC" : "ASC";
    sql += ` ORDER BY "${query.orderBy.ref}" ${dir}`;
  }

  if (query.limit !== undefined) {
    sql += ` LIMIT ${Math.trunc(query.limit)}`;
  }

  return { sql, params: bag.values };
}
