/**
 * The Explorer view: a filterable trace list (GET /traces) on the left, and the
 * selected trace's detail (GET /traces/:id) on the right. Filters drive the list
 * fetch; clicking a row loads that trace's runs + event timeline.
 */
import type { JSX } from "react";
import { useEffect, useState } from "react";
import type {
  ListTracesParams,
  TraceDetail,
  TraceSummary,
} from "../../api-client/index.js";
import { getTrace, listTraces } from "../../api-client/index.js";
import { TraceDetailView } from "./TraceDetailView.js";
import { TraceFilters } from "./TraceFilters.js";

function fmtTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

function fmtMs(ms: number | null): string {
  return ms === null || ms === undefined ? "-" : `${ms} ms`;
}

export function ExplorerView(): JSX.Element {
  const [params, setParams] = useState<ListTracesParams>({ limit: 100 });
  const [traces, setTraces] = useState<TraceSummary[]>([]);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<TraceDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  // Fetch the trace list whenever the applied filter params change.
  useEffect(() => {
    let cancelled = false;
    setListLoading(true);
    setListError(null);
    listTraces(params)
      .then((rows) => {
        if (!cancelled) setTraces(rows);
      })
      .catch((err: unknown) => {
        if (!cancelled)
          setListError(err instanceof Error ? err.message : "Failed to load");
      })
      .finally(() => {
        if (!cancelled) setListLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [params]);

  // Fetch the detail whenever a trace is selected.
  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    setDetailLoading(true);
    setDetailError(null);
    getTrace(selectedId)
      .then((d) => {
        if (cancelled) return;
        if (d === null) setDetailError("Trace not found (404).");
        setDetail(d);
      })
      .catch((err: unknown) => {
        if (!cancelled)
          setDetailError(err instanceof Error ? err.message : "Failed to load");
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  return (
    <section className="explorer-view">
      <TraceFilters
        loading={listLoading}
        onApply={(next) => {
          setSelectedId(null);
          setParams({ ...next, limit: 100 });
        }}
      />

      <div className="explorer-grid">
        <div className="trace-list">
          <div className="list-head">
            <h3>Traces</h3>
            <span className="muted">{traces.length} shown</span>
          </div>
          {listError && <div className="banner error">{listError}</div>}
          {!listError && traces.length === 0 && !listLoading && (
            <p className="muted">No traces match these filters.</p>
          )}
          <ul className="trace-rows">
            {traces.map((t) => (
              <li key={t.traceId}>
                <button
                  type="button"
                  className={`trace-row${selectedId === t.traceId ? " active" : ""}`}
                  onClick={() => setSelectedId(t.traceId)}
                >
                  <span className="trace-row-top">
                    <span className="mono ellipsis">{t.traceId}</span>
                    <span className={`pill status-${t.outcome}`}>{t.outcome}</span>
                  </span>
                  <span className="trace-row-bottom muted">
                    {t.agentName} · {t.runCount} runs · {fmtMs(t.durationMs)} ·{" "}
                    {fmtTime(t.startedAt)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>

        <div className="trace-detail-pane">
          {detailLoading && <p className="muted">Loading trace…</p>}
          {detailError && <div className="banner error">{detailError}</div>}
          {!detailLoading && !detailError && !detail && (
            <p className="muted">Select a trace to inspect its runs and events.</p>
          )}
          {detail && <TraceDetailView trace={detail} />}
        </div>
      </div>
    </section>
  );
}
