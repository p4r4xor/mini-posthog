import type { CaptureEvent } from "@ata/contracts";
import type { ConsumeOptions, EventQueue, QueuedMessage } from "./event-queue.js";

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * In-process FIFO EventQueue for tests and single-process dev (no Redis needed).
 * Same contract as the Redis impl: at-least-once (a failing batch is requeued).
 * Not durable across restarts — that's exactly the gap Redis/Kafka close.
 */
export class MemoryEventQueue implements EventQueue {
  private readonly queue: QueuedMessage[] = [];
  private seq = 0;

  async enqueue(projectId: string, events: CaptureEvent[]): Promise<number> {
    for (const event of events) {
      this.queue.push({ id: String(++this.seq), projectId, event });
    }
    return events.length;
  }

  async depth(): Promise<number> {
    return this.queue.length;
  }

  /** Process up to `batchSize` queued messages once; requeue the batch on error. */
  async pump(
    handler: (batch: QueuedMessage[]) => Promise<void>,
    batchSize: number,
  ): Promise<number> {
    if (this.queue.length === 0) return 0;
    const batch = this.queue.splice(0, batchSize);
    try {
      await handler(batch);
      return batch.length;
    } catch (err) {
      this.queue.unshift(...batch); // at-least-once: redeliver
      throw err;
    }
  }

  async consume(
    handler: (batch: QueuedMessage[]) => Promise<void>,
    opts: ConsumeOptions,
  ): Promise<void> {
    while (!opts.signal.aborted) {
      let processed = 0;
      try {
        processed = await this.pump(handler, opts.batchSize);
      } catch {
        await delay(opts.batchMs); // back off on handler failure before retry
      }
      if (processed === 0) await delay(opts.batchMs);
    }
  }

  async close(): Promise<void> {}
}
