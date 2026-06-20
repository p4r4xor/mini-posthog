/**
 * Trace handle implementation.
 *
 * A trace is the logical thread grouping related runs - run-level retries and
 * conversational turns (docs/architecture.md §3). It holds the shared
 * agentName/userId/tags context and mints `Run` handles. Trace outcome/totals
 * are *derived* server-side from the runs, so `end()` is bookkeeping only and
 * emits no server event.
 */
import type { CaptureEvent } from "@ata/contracts";
import { RunImpl } from "./run.js";
import type { Run, StartRunOptions, Tags, Trace } from "./types.js";

export interface TraceContext {
  traceId: string;
  agentName: string;
  userId: string;
  tags: Tags | undefined;
  enqueue: (event: CaptureEvent) => void;
}

export class TraceImpl implements Trace {
  readonly traceId: string;

  constructor(private readonly ctx: TraceContext) {
    this.traceId = ctx.traceId;
  }

  startRun(opts: StartRunOptions): Run {
    return new RunImpl(
      {
        traceId: this.ctx.traceId,
        runId: opts.runId ?? `run_${crypto.randomUUID()}`,
        agentName: this.ctx.agentName,
        userId: this.ctx.userId,
        tags: this.ctx.tags,
        enqueue: this.ctx.enqueue,
      },
      opts.input,
      opts.at,
    );
  }

  /**
   * No-op by design: a trace emits no server event - its state (outcome, totals,
   * duration) is derived server-side from its runs. Present for lifecycle symmetry
   * with `run.end()` and to allow future client-side bookkeeping.
   */
  end(): void {}
}
