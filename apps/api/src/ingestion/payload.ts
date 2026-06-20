import type { CaptureEvent, EventRow } from "@ata/contracts";
import type { BlobStore } from "../blob/blob-store.js";

/**
 * Payload externalization (docs/architecture.md §6/§12).
 *
 * THE KEY IDEA - "4 KB never enters the queue":
 * An event's `metadata` mixes two very different kinds of data:
 *   - small *properties* we filter/group on or want inline (tags, route, attempt) -
 *     tens of bytes;
 *   - large *payload* text (the prompt `input`, the response `output`) - the bulk
 *     of the ~4 KB, and NEVER aggregated, only shown in the explorer.
 *
 * Before an event is enqueued, we strip the payload fields, write them to the
 * BlobStore (S3 in prod), and replace them with a tiny `payloadRef`. So the event
 * that flows SDK → /capture → queue → worker → ClickHouse is the ~300 B analytical
 * record, while the 4 KB of text sits in cheap object storage, fetched only when a
 * human opens the trace. The queue (and the hot store) only ever carry the slim
 * event.
 */

/**
 * The large payload lives in TOP-LEVEL event fields: `input` (on run_started) and
 * `output` (on run_completed) - the prompt and final response text. (They were
 * previously dropped entirely on ingestion since they aren't analytical columns;
 * externalizing them both shrinks the queue AND finally persists them.)
 */
const PAYLOAD_FIELDS = ["input", "output"] as const;

/**
 * Move the payload text out of the top-level event fields into the BlobStore,
 * returning a slim event with a `payloadRef` in metadata. The required `input`
 * field is replaced with "" (keeping the event a valid CaptureEvent) and the
 * optional `output` is removed; the full text is fetched back on read via
 * {@link hydratePayload}. No-op if the event carries no payload.
 */
export async function externalizePayload(
  event: CaptureEvent,
  blob: BlobStore,
): Promise<CaptureEvent> {
  const e = event as Record<string, unknown>;
  const payload: Record<string, unknown> = {};
  for (const f of PAYLOAD_FIELDS) {
    if (typeof e[f] === "string" && (e[f] as string).length > 0) payload[f] = e[f];
  }
  if (Object.keys(payload).length === 0) return event;

  const ref = await blob.put(event.eventId, JSON.stringify(payload));

  const slim: Record<string, unknown> = {
    ...e,
    metadata: { ...(event.metadata ?? {}), payloadRef: ref },
  };
  if ("input" in slim) slim.input = ""; // required string on run_started - keep valid
  if ("output" in slim) delete slim.output; // optional on run_completed
  return slim as CaptureEvent;
}

/**
 * Read side: given a stored row, fetch its externalized payload (if any) and
 * merge it back into metadata so the explorer shows the full input/output.
 */
export async function hydratePayload(
  row: EventRow,
  blob: BlobStore,
): Promise<Record<string, unknown>> {
  const md = row.metadata ?? {};
  const ref = md.payloadRef;
  if (typeof ref !== "string") return md;
  const raw = await blob.get(ref);
  if (!raw) return md;
  const { payloadRef: _omit, ...rest } = md;
  return { ...rest, ...(JSON.parse(raw) as Record<string, unknown>) };
}
