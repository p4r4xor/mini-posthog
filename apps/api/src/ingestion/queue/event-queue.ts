import type { CaptureEvent } from "@ata/contracts";

/**
 * EventQueue port — the buffer that decouples ingestion from the database
 * (docs/architecture.md §12). `/capture` only validates + enqueues and returns
 * fast; a worker drains the queue and does the heavy batched insert. This is the
 * shock-absorber that survives DB stalls and the 10× peak.
 *
 * Implementations: {@link MemoryEventQueue} (tests / single-process dev) and
 * {@link RedisStreamQueue} (real decoupled buffering). Production swaps in
 * Kafka/Redpanda behind this same interface — see the §12 durability note.
 *
 * Only ever carries SLIM events (payload already externalized to the BlobStore),
 * so the backlog is ~300 B/event, not ~4 KB.
 */

/** A message pulled from the queue: the slim event, its tenant, and an ack id. */
export interface QueuedMessage {
  /** Queue-native id used to acknowledge the message after a successful insert. */
  id: string;
  projectId: string;
  event: CaptureEvent;
}

export interface ConsumeOptions {
  /** Max events handed to the worker per batch (large → cheap inserts). */
  batchSize: number;
  /** Max ms to wait while filling a batch before processing a partial one. */
  batchMs: number;
  /** Abort to stop the consume loop (graceful shutdown). */
  signal: AbortSignal;
}

export interface EventQueue {
  /** Append slim events for a project; returns the count enqueued. */
  enqueue(projectId: string, events: CaptureEvent[]): Promise<number>;
  /** Current backlog depth — drives 429 backpressure at the edge. */
  depth(): Promise<number>;
  /**
   * Consume in batches until aborted. If `handler` resolves, the batch is acked;
   * if it throws, the messages stay pending and are redelivered (and after
   * repeated failures routed to a dead-letter stream by the implementation).
   */
  consume(
    handler: (batch: QueuedMessage[]) => Promise<void>,
    opts: ConsumeOptions,
  ): Promise<void>;
  close(): Promise<void>;
}
