/**
 * In-memory batching queue with size + interval flush triggers.
 *
 * Responsibilities:
 *   - Buffer enqueued events with bounded backpressure.
 *   - Flush when the buffer reaches `flushAt`, on a `flushIntervalMs` timer, or
 *     on demand (`flush`).
 *   - Chunk each flush into HTTP batches of <= MAX_BATCH events.
 *   - Serialize flushes so two never run concurrently.
 *
 * Backpressure policy: **drop-newest**. When the queue is full, the incoming
 * event is discarded (rather than blocking the caller or evicting older,
 * already-buffered events) and `onError` is notified. This keeps capture calls
 * synchronous and non-blocking on the agent's hot path; losing the freshest
 * event is preferable to stalling agent execution or dropping history that may
 * already be mid-flush.
 */
import type { CaptureEvent } from "@ata/contracts";
import { sendBatch } from "./transport.js";
import type { ResolvedConfig } from "./types.js";

/** Max events per HTTP request (server contract allows up to 1000; we stay well under). */
const MAX_BATCH = 500;

export class BatchQueue {
  private readonly buffer: CaptureEvent[] = [];
  private timer: ReturnType<typeof setInterval> | undefined;
  /** Guards against overlapping flushes; chained so callers all await completion. */
  private flushing: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(private readonly config: ResolvedConfig) {}

  /** Start the background interval timer. Idempotent. */
  start(): void {
    if (this.timer !== undefined || this.closed) return;
    this.timer = setInterval(() => {
      // Fire-and-forget; errors surface via onError inside flush().
      void this.flush();
    }, this.config.flushIntervalMs);
    // Don't keep the Node process alive solely for the flush timer.
    // In Node the timer is a `Timeout` with `.unref()`; in the browser it's a
    // numeric handle with no such method, so probe for the method at runtime.
    const handle = this.timer as unknown as { unref?: () => void };
    handle.unref?.();
  }

  /**
   * Enqueue an event. Returns false if it was dropped due to backpressure.
   * Triggers a flush (fire-and-forget) once the buffer reaches `flushAt`.
   */
  enqueue(event: CaptureEvent): boolean {
    if (this.buffer.length >= this.config.maxQueueSize) {
      // drop-newest: discard the incoming event, notify, keep the hot path fast.
      this.config.onError(
        new Error(
          `queue full (maxQueueSize=${this.config.maxQueueSize}); dropping event`,
        ),
        [event],
      );
      return false;
    }

    this.buffer.push(event);

    if (this.buffer.length >= this.config.flushAt) {
      void this.flush();
    }
    return true;
  }

  /**
   * Drain the queue. Concurrent calls coalesce onto the same in-flight chain so
   * batches are never sent twice and `flush()` always resolves after the queue
   * (as observed at call time) has been drained.
   */
  flush(): Promise<void> {
    this.flushing = this.flushing.then(() => this.drain());
    return this.flushing;
  }

  /** Drain every currently-buffered event in chunks. */
  private async drain(): Promise<void> {
    while (this.buffer.length > 0) {
      const chunk = this.buffer.splice(0, MAX_BATCH);
      try {
        await sendBatch(this.config, chunk);
      } catch (err) {
        // Retry budget exhausted or permanent failure: drop the chunk, notify.
        this.config.onError(
          err instanceof Error ? err : new Error(String(err)),
          chunk,
        );
      }
    }
  }

  /** Stop the timer and perform a final flush. */
  async shutdown(): Promise<void> {
    this.closed = true;
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    await this.flush();
  }
}
