/**
 * Trace detail: the selected trace's runs plus an ordered event timeline. Events
 * are sorted by step index so the timeline reads in execution order; each entry
 * shows type, model/tool, status, latency and cost.
 */
import type { EventRow, RunSummary, TraceDetail } from "../../api-client/index.js";

/** Compact ISO → local time for timeline rows. */
function fmtTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

function fmtMs(ms: number | null): string {
  return ms === null || ms === undefined ? "—" : `${ms} ms`;
}

function fmtUsd(usd: number | null | undefined): string {
  return usd === null || usd === undefined ? "—" : `$${usd.toFixed(4)}`;
}

export function TraceDetailView({ trace }: { trace: TraceDetail }): JSX.Element {
  const orderedEvents = [...trace.events].sort((a, b) => a.stepIndex - b.stepIndex);

  return (
    <div className="trace-detail">
      <header className="detail-header">
        <h2>{trace.traceId}</h2>
        <div className="meta-row">
          <span className={`pill status-${trace.outcome}`}>{trace.outcome}</span>
          <span className="pill">agent: {trace.agentName}</span>
          <span className="pill">runs: {trace.runCount}</span>
          <span className="pill">duration: {fmtMs(trace.durationMs)}</span>
          <span className="pill">cost: {fmtUsd(trace.costUsd)}</span>
        </div>
      </header>

      <h3>Runs</h3>
      <div className="table-scroll">
        <table className="data-table">
          <thead>
            <tr>
              <th>runId</th>
              <th>outcome</th>
              <th>model</th>
              <th>steps</th>
              <th>duration</th>
              <th>compute</th>
              <th>cost</th>
              <th>errors</th>
              <th>retries</th>
            </tr>
          </thead>
          <tbody>
            {trace.runs.map((run: RunSummary) => (
              <tr key={run.runId}>
                <td className="mono">{run.runId}</td>
                <td>
                  <span className={`pill status-${run.outcome}`}>{run.outcome}</span>
                </td>
                <td>{run.primaryModel ?? "—"}</td>
                <td>{run.stepCount}</td>
                <td>{fmtMs(run.durationMs)}</td>
                <td>{fmtMs(run.computeMs)}</td>
                <td>{fmtUsd(run.costUsd)}</td>
                <td>{run.errorCount}</td>
                <td>{run.retryCount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h3>Event timeline ({orderedEvents.length})</h3>
      <ol className="timeline">
        {orderedEvents.map((ev: EventRow) => (
          <li key={ev.eventId} className="timeline-item">
            <span className="step-index">#{ev.stepIndex}</span>
            <span className={`event-type type-${ev.eventType}`}>{ev.eventType}</span>
            <span className="timeline-detail">
              {ev.model && <span className="tag">model: {ev.model}</span>}
              {ev.toolName && <span className="tag">tool: {ev.toolName}</span>}
              {ev.status && (
                <span className={`tag status-${ev.status}`}>{ev.status}</span>
              )}
              {ev.errorType && <span className="tag err">err: {ev.errorType}</span>}
            </span>
            <span className="timeline-metrics">
              <span>{fmtMs(ev.latencyMs)}</span>
              <span>{fmtUsd(ev.costUsd)}</span>
              <span className="muted">{fmtTime(ev.timestamp)}</span>
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}
