/**
 * Renders a QueryResult according to its `chartHint`:
 *   - "line"  → time-series LineChart (x = time column, one series per dimension
 *               value when a categorical dimension is present, y = the measure).
 *   - "bar"   → BarChart (x = dimension column, y = measure).
 *   - "table" → a plain HTML table of every column/row.
 *
 * The result is column-role driven: we locate the "time"/"dimension"/"measure"
 * columns from `result.columns` rather than hard-coding names, so any supported
 * plan renders without per-question logic.
 */

import type { JSX } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { CellValue, QueryResult, ResultColumn } from "../../api-client/index.js";

/** A small palette cycled across series so multi-line/grouped charts stay legible. */
const SERIES_COLORS = [
  "#6366f1",
  "#10b981",
  "#f59e0b",
  "#ef4444",
  "#06b6d4",
  "#8b5cf6",
  "#ec4899",
  "#84cc16",
];

function colorFor(index: number): string {
  return SERIES_COLORS[index % SERIES_COLORS.length] as string;
}

/** First column matching a role (columns carry role metadata in the contract). */
function columnByRole(
  columns: ResultColumn[],
  role: ResultColumn["role"],
): ResultColumn | undefined {
  return columns.find((c) => c.role === role);
}

/** Stringify a cell for axis/table display, normalising null/boolean.
 *  Accepts `undefined` too, since indexing a row by key may miss a column. */
function display(value: CellValue | undefined): string {
  if (value === null || value === undefined) return "-";
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}

export function ResultChart({ result }: { result: QueryResult }): JSX.Element {
  if (result.rows.length === 0) {
    return <p className="muted">No rows matched this query.</p>;
  }

  switch (result.chartHint) {
    case "line":
      return <LineView result={result} />;
    case "bar":
      return <BarView result={result} />;
    default:
      return <TableView result={result} />;
  }
}

/**
 * Line view. The x-axis is the time column. If there is also a categorical
 * dimension (e.g. model), we pivot the rows into one series per distinct value;
 * otherwise we draw a single line for the measure column.
 */
function LineView({ result }: { result: QueryResult }): JSX.Element {
  const timeCol = columnByRole(result.columns, "time");
  const dimCol = columnByRole(result.columns, "dimension");
  const measureCol = columnByRole(result.columns, "measure");

  // Without time + measure columns we can't draw a line; fall back to a table.
  if (!timeCol || !measureCol) return <TableView result={result} />;

  const xKey = timeCol.name;
  const measureKey = measureCol.name;

  if (dimCol) {
    // Pivot: { [time]: ..., [seriesValue]: measure } so each series is a key.
    const seriesValues = Array.from(
      new Set(result.rows.map((r) => display(r[dimCol.name]))),
    );
    const byTime = new Map<string, Record<string, CellValue>>();
    for (const row of result.rows) {
      const t = display(row[xKey]);
      const bucket: Record<string, CellValue> = byTime.get(t) ?? {
        [xKey]: row[xKey] ?? null,
      };
      bucket[display(row[dimCol.name])] = row[measureKey] ?? null;
      byTime.set(t, bucket);
    }
    const data = Array.from(byTime.values());

    return (
      <ResponsiveContainer width="100%" height={360}>
        <LineChart data={data} margin={{ top: 8, right: 24, bottom: 8, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#26262e" />
          <XAxis dataKey={xKey} tick={{ fontSize: 11 }} stroke="#8a8a96" />
          <YAxis tick={{ fontSize: 11 }} stroke="#8a8a96" />
          <Tooltip contentStyle={tooltipStyle} />
          <Legend />
          {seriesValues.map((value, i) => (
            <Line
              key={value}
              type="monotone"
              dataKey={value}
              name={value}
              stroke={colorFor(i)}
              dot={false}
              strokeWidth={2}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    );
  }

  // Single-series line (e.g. runs per hour).
  return (
    <ResponsiveContainer width="100%" height={360}>
      <LineChart data={result.rows} margin={{ top: 8, right: 24, bottom: 8, left: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#26262e" />
        <XAxis dataKey={xKey} tick={{ fontSize: 11 }} stroke="#8a8a96" />
        <YAxis tick={{ fontSize: 11 }} stroke="#8a8a96" />
        <Tooltip contentStyle={tooltipStyle} />
        <Line
          type="monotone"
          dataKey={measureKey}
          name={measureKey}
          stroke={colorFor(0)}
          dot={false}
          strokeWidth={2}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}

/** Bar view: x = the categorical dimension, y = the measure. */
function BarView({ result }: { result: QueryResult }): JSX.Element {
  const dimCol = columnByRole(result.columns, "dimension");
  const measureCol = columnByRole(result.columns, "measure");

  if (!dimCol || !measureCol) return <TableView result={result} />;

  return (
    <ResponsiveContainer width="100%" height={360}>
      <BarChart data={result.rows} margin={{ top: 8, right: 24, bottom: 8, left: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#26262e" />
        <XAxis
          dataKey={dimCol.name}
          tick={{ fontSize: 11 }}
          stroke="#8a8a96"
          interval={0}
          angle={-15}
          textAnchor="end"
          height={56}
        />
        <YAxis tick={{ fontSize: 11 }} stroke="#8a8a96" />
        <Tooltip contentStyle={tooltipStyle} cursor={{ fill: "#ffffff0d" }} />
        <Bar
          dataKey={measureCol.name}
          name={measureCol.name}
          fill={colorFor(0)}
          radius={[3, 3, 0, 0]}
        />
      </BarChart>
    </ResponsiveContainer>
  );
}

/** Table view: render every column header + every row cell verbatim. */
function TableView({ result }: { result: QueryResult }): JSX.Element {
  return (
    <div className="table-scroll">
      <table className="data-table">
        <thead>
          <tr>
            {result.columns.map((c) => (
              <th key={c.name}>
                {c.name}
                <span className="col-role">{c.role}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {result.rows.map((row) => (
            <tr key={result.columns.map((c) => String(row[c.name] ?? "")).join("¦")}>
              {result.columns.map((c) => (
                <td key={c.name}>{display(row[c.name])}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const tooltipStyle = {
  background: "#1a1a20",
  border: "1px solid #2e2e38",
  borderRadius: 8,
  fontSize: 12,
} as const;
