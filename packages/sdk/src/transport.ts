/**
 * HTTP transport for shipping batches to `POST ${host}/capture`.
 *
 * Retry policy (see docs/architecture.md §11/§12):
 *   - 2xx                       → success.
 *   - network error / 429 / 5xx → retryable: exponential backoff + jitter,
 *                                 capped at `maxRetries`.
 *   - other 4xx                 → permanent: do not retry (malformed batch,
 *                                 bad api key, etc.) - caller drops the batch.
 *
 * `eventId` is client-generated so the server can dedup our at-least-once
 * deliveries; retrying a batch is therefore safe.
 */
import type { CaptureEvent } from "@ata/contracts";
import type { ResolvedConfig } from "./types.js";

/** Thrown for a permanent (non-retryable) HTTP 4xx response. */
export class PermanentTransportError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "PermanentTransportError";
  }
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const isRetryableStatus = (status: number): boolean => status === 429 || status >= 500;

/** Backoff for the Nth (0-based) retry: base * 2^attempt + [0, base) jitter. */
function backoffMs(retryBaseMs: number, attempt: number): number {
  const exp = retryBaseMs * 2 ** attempt;
  const jitter = Math.random() * retryBaseMs;
  return exp + jitter;
}

/**
 * Send a single batch, retrying transient failures. Resolves on success.
 * Rejects with the last error once the retry budget is exhausted, or
 * immediately with a {@link PermanentTransportError} on a non-retryable 4xx.
 */
export async function sendBatch(
  config: ResolvedConfig,
  events: CaptureEvent[],
): Promise<void> {
  const url = `${config.host.replace(/\/$/, "")}/capture`;
  const body = JSON.stringify({ events });

  let lastError: Error = new Error("transport failed");

  // attempt 0 is the initial try; attempts 1..maxRetries are retries.
  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    if (attempt > 0) {
      await sleep(backoffMs(config.retryBaseMs, attempt - 1));
    }

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": config.apiKey,
        },
        body,
      });

      if (res.ok) return;

      if (!isRetryableStatus(res.status)) {
        // Permanent: malformed batch / auth error - retrying won't help.
        throw new PermanentTransportError(
          `capture rejected with HTTP ${res.status}`,
          res.status,
        );
      }

      lastError = new Error(`capture failed with HTTP ${res.status}`);
    } catch (err) {
      // Permanent errors bubble straight out; everything else is retryable.
      if (err instanceof PermanentTransportError) throw err;
      lastError = err instanceof Error ? err : new Error(String(err));
    }
  }

  throw lastError;
}
