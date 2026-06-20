import {
  CaptureEvent,
  type CaptureEventResult,
  type CaptureResponse,
  captureEventToRow,
  type EventRow,
  type EventStore,
} from "@ata/contracts";

/**
 * Ingestion service (docs/architecture.md §12).
 *
 * Validates each event at the edge, maps valid ones to flat storage rows, and
 * inserts them idempotently. Validation is per-event (partial success): one
 * malformed event never blocks the rest of the batch — it is rejected and
 * reported with its index/error while the valid events still proceed.
 */
export class IngestionService {
  constructor(private readonly store: EventStore) {}

  async capture(events: unknown[], projectId: string): Promise<CaptureResponse> {
    const rows: EventRow[] = [];
    const results: CaptureEventResult[] = [];
    let rejected = 0;

    events.forEach((raw, index) => {
      const parsed = CaptureEvent.safeParse(raw);
      if (parsed.success) {
        rows.push(captureEventToRow(parsed.data, projectId));
        return;
      }
      rejected += 1;
      const eventId =
        raw &&
        typeof raw === "object" &&
        typeof (raw as { eventId?: unknown }).eventId === "string"
          ? (raw as { eventId: string }).eventId
          : undefined;
      results.push({
        // CaptureEventResult requires an eventId; fall back to a positional id
        // when the malformed event didn't carry a usable one.
        eventId: eventId ?? `index:${index}`,
        status: "rejected",
        error: parsed.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; "),
      });
    });

    const insert = await this.store.insertBatch(rows);

    return {
      accepted: insert.inserted,
      duplicates: insert.duplicates,
      rejected,
      results,
    };
  }
}
