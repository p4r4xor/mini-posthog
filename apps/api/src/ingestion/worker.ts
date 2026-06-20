import { captureEventToRow, type EventStore } from "@ata/contracts";
import type { EventQueue, QueuedMessage } from "./queue/event-queue.js";

export interface WorkerOptions {
  /** Max events per insert - large batches keep ClickHouse happy ("too many parts"). */
  batchSize: number;
  /** Max ms to wait while filling a batch. */
  batchMs: number;
}

/**
 * The async ingestion worker (docs/architecture.md §12). Drains the queue and
 * does the heavy, batched, idempotent insert into the EventStore - the opposite
 * end of the decoupled pipeline from `/capture`. In the prototype it runs
 * in-process; in production it's a separate horizontally-scaled deployment
 * (scale on consumer lag). The slim events it receives already had their payload
 * externalized at the edge, so it just flattens to rows and inserts.
 */
export class IngestionWorker {
  constructor(
    private readonly queue: EventQueue,
    private readonly store: EventStore,
    private readonly opts: WorkerOptions,
  ) {}

  /** Process one batch: flatten slim events → rows → idempotent insert. */
  readonly handleBatch = async (batch: QueuedMessage[]): Promise<void> => {
    if (batch.length === 0) return;
    const rows = batch.map((m) => captureEventToRow(m.event, m.projectId));
    await this.store.insertBatch(rows); // idempotent by eventId (at-least-once safe)
  };

  /** Run the consume loop until `signal` aborts. */
  start(signal: AbortSignal): Promise<void> {
    return this.queue.consume(this.handleBatch, {
      batchSize: this.opts.batchSize,
      batchMs: this.opts.batchMs,
      signal,
    });
  }
}
