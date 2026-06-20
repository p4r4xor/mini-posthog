/**
 * BlobStore port - durable storage for large, non-analytical payloads
 * (prompt/response text). Kept OUT of the analytical row and OUT of the queue:
 * at ~4 KB/event and 1B events/day that's ~4 TB/day of text that is never
 * aggregated, only viewed in the trace explorer. So we write it here (cheap
 * object storage in prod) and keep only a small reference on the event.
 *
 * Local dev uses {@link LocalBlobStore} (filesystem); production swaps in an S3
 * adapter behind this same interface - exactly the Langfuse/Helicone pattern
 * ("keep big payloads out of the hot path, pass references").
 */
export interface BlobStore {
  /**
   * Store `data` under `key`, returning an opaque reference string to persist on
   * the event. Idempotent: the same key overwrites identical content.
   */
  put(key: string, data: string): Promise<string>;
  /** Fetch by reference, or null if missing. Used to hydrate the explorer. */
  get(ref: string): Promise<string | null>;
  close(): Promise<void>;
}
