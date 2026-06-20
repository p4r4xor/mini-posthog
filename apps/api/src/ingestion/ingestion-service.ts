import {
  CaptureEvent,
  type CaptureEventResult,
  type CaptureResponse,
} from "@ata/contracts";
import type { BlobStore } from "../blob/blob-store.js";
import { externalizePayload } from "./payload.js";
import type { EventQueue } from "./queue/event-queue.js";

/**
 * Ingestion service (docs/architecture.md §12) - the EDGE of the async pipeline.
 *
 * It does NOT touch the database. Per request it:
 *   1. checks backpressure (queue depth) and sheds load with a signal the HTTP
 *      layer turns into 429 - the SDK already backs off on 429;
 *   2. validates each event (per-event partial success);
 *   3. externalizes each valid event's payload to the BlobStore, leaving a slim
 *      event (the 4 KB of text never enters the queue);
 *   4. enqueues the slim events and returns fast (HTTP 202).
 *
 * The worker drains the queue and does the idempotent insert, so `accepted` here
 * means "buffered for processing", and dedup is resolved downstream (hence
 * `duplicates: 0` at this layer).
 */
export interface IngestionOptions {
  /** Reject (429) once the queue backlog reaches this depth. */
  maxQueueDepth: number;
}

export type IngestionResult =
  | { status: "accepted"; response: CaptureResponse }
  | { status: "backpressure"; depth: number };

export class IngestionService {
  constructor(
    private readonly queue: EventQueue,
    private readonly blob: BlobStore,
    private readonly opts: IngestionOptions,
  ) {}

  async capture(events: unknown[], projectId: string): Promise<IngestionResult> {
    const depth = await this.queue.depth();
    if (depth >= this.opts.maxQueueDepth) {
      return { status: "backpressure", depth };
    }

    const slim: CaptureEvent[] = [];
    const results: CaptureEventResult[] = [];
    let rejected = 0;

    for (let index = 0; index < events.length; index++) {
      const parsed = CaptureEvent.safeParse(events[index]);
      if (!parsed.success) {
        rejected += 1;
        results.push({
          eventId: extractEventId(events[index]) ?? `index:${index}`,
          status: "rejected",
          error: parsed.error.issues
            .map((i) => `${i.path.join(".")}: ${i.message}`)
            .join("; "),
        });
        continue;
      }
      // Strip large payload to the BlobStore BEFORE enqueue - keeps the queue slim.
      slim.push(await externalizePayload(parsed.data, this.blob));
    }

    const accepted = await this.queue.enqueue(projectId, slim);
    return {
      status: "accepted",
      response: { accepted, duplicates: 0, rejected, results },
    };
  }
}

function extractEventId(raw: unknown): string | undefined {
  if (raw && typeof raw === "object") {
    const id = (raw as { eventId?: unknown }).eventId;
    if (typeof id === "string") return id;
  }
  return undefined;
}
