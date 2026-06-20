/**
 * The Query view: a natural-language input + clickable example questions. On
 * submit we POST /query and render either the chart-ready result (with a visible
 * latency/engine/source/rowCount badge row) or, when the question isn't
 * supported, the rejection reason and the supported-question catalog.
 */
import type { JSX } from "react";
import { useState } from "react";
import type { QueryResponse } from "../../api-client/index.js";
import { runQuery } from "../../api-client/index.js";
import { ResultChart } from "./ResultChart.js";

/**
 * The hardcoded example questions from the spec. These exercise every chart hint
 * (line/bar/table), every aggregation family (avg/count/sum/ratio/count_distinct),
 * and the percentile path (p95).
 */
const EXAMPLE_QUESTIONS = [
  "Average LLM latency by model over time",
  "Which tools fail the most?",
  "Token usage by agent type",
  "Cost per successful run by model",
  "Top 10 slowest traces",
  "Error rate by tool name",
  "Number of runs per hour",
  "Average steps per run by outcome",
  "p95 LLM latency by model",
] as const;

export function QueryView(): JSX.Element {
  const [question, setQuestion] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [response, setResponse] = useState<QueryResponse | null>(null);

  /** Run a question (from the input or an example chip). */
  async function submit(q: string): Promise<void> {
    const trimmed = q.trim();
    if (!trimmed || loading) return;
    setQuestion(trimmed);
    setLoading(true);
    setError(null);
    try {
      const res = await runQuery({ q: trimmed });
      setResponse(res);
    } catch (err) {
      setResponse(null);
      setError(err instanceof Error ? err.message : "Unexpected error");
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="query-view">
      <form
        className="query-form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit(question);
        }}
      >
        <input
          className="query-input"
          type="text"
          placeholder="Ask a question, e.g. “Average LLM latency by model over time”"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          aria-label="Natural language query"
        />
        <button className="btn primary" type="submit" disabled={loading}>
          {loading ? "Running…" : "Run"}
        </button>
      </form>

      <div className="examples">
        <span className="examples-label">Try:</span>
        {EXAMPLE_QUESTIONS.map((q) => (
          <button
            key={q}
            type="button"
            className="chip"
            disabled={loading}
            onClick={() => void submit(q)}
          >
            {q}
          </button>
        ))}
      </div>

      {error && <div className="banner error">Request failed: {error}</div>}

      {response && <QueryResultPanel response={response} />}
    </section>
  );
}

/** Renders the success (chart + meta) or failure (reason + catalog) branch. */
function QueryResultPanel({ response }: { response: QueryResponse }): JSX.Element {
  if (!response.ok) {
    return (
      <div className="banner warn">
        <strong>Not a supported question.</strong>
        <p>{response.reason}</p>
        {response.supported.length > 0 && (
          <>
            <p className="muted">Try one of these supported questions:</p>
            <ul className="supported-list">
              {response.supported.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ul>
          </>
        )}
      </div>
    );
  }

  const { result, source } = response;
  return (
    <div className="result-panel">
      <div className="meta-row">
        <Badge label="latency" value={`${result.meta.latencyMs} ms`} accent />
        <Badge label="engine" value={result.meta.engine} />
        <Badge label="planner" value={source} />
        <Badge label="rows" value={String(result.meta.rowCount)} />
        <Badge label="chart" value={result.chartHint} />
      </div>
      <ResultChart result={result} />
    </div>
  );
}

function Badge({
  label,
  value,
  accent = false,
}: {
  label: string;
  value: string;
  accent?: boolean;
}): JSX.Element {
  return (
    <span className={`badge${accent ? " accent" : ""}`}>
      <span className="badge-label">{label}</span>
      <span className="badge-value">{value}</span>
    </span>
  );
}
