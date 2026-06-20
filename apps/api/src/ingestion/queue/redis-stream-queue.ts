import type { CaptureEvent } from "@ata/contracts";
import { Redis } from "ioredis";
import type { ConsumeOptions, EventQueue, QueuedMessage } from "./event-queue.js";

/**
 * Redis Streams EventQueue - real decoupled buffering for local/prototype
 * (docs/architecture.md §12). Producers `XADD` slim events; a consumer GROUP
 * drains them with at-least-once delivery (`XREADGROUP` → process → `XACK`).
 *
 * Resilience:
 *  - `MAXLEN ~ cap` bounds memory (approximate trim). NOTE: trimming is lossy
 *    under sustained overload - the documented Redis-vs-Kafka tradeoff (Kafka
 *    drops by age on disk, not by force). We pair it with edge 429s so we shed
 *    load before trimming bites.
 *  - crashed consumers are recovered via `XAUTOCLAIM` (reclaim idle pending).
 *  - poison batches go to a dead-letter stream after `maxDeliveries` attempts.
 *
 * Production swaps Kafka/Redpanda behind the same EventQueue port: disk-backed
 * buffer (days, not RAM-minutes), partitions, replication.
 */
export interface RedisStreamQueueOptions {
  url: string;
  stream?: string;
  group?: string;
  consumer?: string;
  maxLen?: number;
  maxDeliveries?: number;
  /** ms a message may sit pending (in a dead consumer) before reclaim. */
  visibilityMs?: number;
}

const FIELD_PROJECT = "p";
const FIELD_EVENT = "e";

export class RedisStreamQueue implements EventQueue {
  private readonly redis: Redis;
  private readonly stream: string;
  private readonly group: string;
  private readonly consumer: string;
  private readonly dlq: string;
  private readonly maxLen: number;
  private readonly maxDeliveries: number;
  private readonly visibilityMs: number;
  private ready = false;
  /** Best-effort per-message attempt counter (resets on restart). */
  private readonly attempts = new Map<string, number>();

  constructor(opts: RedisStreamQueueOptions) {
    this.redis = new Redis(opts.url, { maxRetriesPerRequest: null });
    this.stream = opts.stream ?? "ata:events";
    this.group = opts.group ?? "ata:workers";
    this.consumer = opts.consumer ?? `c-${process.pid}`;
    this.dlq = `${this.stream}:dlq`;
    this.maxLen = opts.maxLen ?? 5_000_000;
    this.maxDeliveries = opts.maxDeliveries ?? 5;
    this.visibilityMs = opts.visibilityMs ?? 30_000;
  }

  private async ensureGroup(): Promise<void> {
    if (this.ready) return;
    try {
      await this.redis.xgroup("CREATE", this.stream, this.group, "$", "MKSTREAM");
    } catch (err) {
      // BUSYGROUP = group already exists; anything else is real.
      if (!(err instanceof Error) || !err.message.includes("BUSYGROUP")) throw err;
    }
    this.ready = true;
  }

  async enqueue(projectId: string, events: CaptureEvent[]): Promise<number> {
    await this.ensureGroup();
    const pipe = this.redis.pipeline();
    for (const event of events) {
      pipe.xadd(
        this.stream,
        "MAXLEN",
        "~",
        this.maxLen,
        "*",
        FIELD_PROJECT,
        projectId,
        FIELD_EVENT,
        JSON.stringify(event),
      );
    }
    await pipe.exec();
    return events.length;
  }

  async depth(): Promise<number> {
    return this.redis.xlen(this.stream);
  }

  async consume(
    handler: (batch: QueuedMessage[]) => Promise<void>,
    opts: ConsumeOptions,
  ): Promise<void> {
    await this.ensureGroup();
    while (!opts.signal.aborted) {
      const reclaimed = await this.reclaimStale(opts.batchSize);
      const fresh = reclaimed.length > 0 ? [] : await this.readNew(opts);
      const batch = reclaimed.length > 0 ? reclaimed : fresh;
      if (batch.length === 0) continue;

      try {
        await handler(batch);
        await this.ack(batch);
      } catch {
        await this.handleFailure(batch);
      }
    }
  }

  private parseEntries(entries: Array<[string, string[]]>): QueuedMessage[] {
    return entries.map(([id, fields]) => {
      const map = new Map<string, string>();
      for (let i = 0; i < fields.length; i += 2) map.set(fields[i]!, fields[i + 1]!);
      return {
        id,
        projectId: map.get(FIELD_PROJECT) ?? "",
        event: JSON.parse(map.get(FIELD_EVENT) ?? "{}") as CaptureEvent,
      };
    });
  }

  private async readNew(opts: ConsumeOptions): Promise<QueuedMessage[]> {
    const res = (await this.redis.xreadgroup(
      "GROUP",
      this.group,
      this.consumer,
      "COUNT",
      opts.batchSize,
      "BLOCK",
      opts.batchMs,
      "STREAMS",
      this.stream,
      ">",
    )) as Array<[string, Array<[string, string[]]>]> | null;
    if (!res || res.length === 0) return [];
    return this.parseEntries(res[0]![1]);
  }

  private async reclaimStale(count: number): Promise<QueuedMessage[]> {
    const res = (await this.redis.xautoclaim(
      this.stream,
      this.group,
      this.consumer,
      this.visibilityMs,
      "0",
      "COUNT",
      count,
    )) as [string, Array<[string, string[]]>, string[]] | null;
    if (!res) return [];
    return this.parseEntries(res[1] ?? []);
  }

  private async ack(batch: QueuedMessage[]): Promise<void> {
    await this.redis.xack(this.stream, this.group, ...batch.map((m) => m.id));
    for (const m of batch) this.attempts.delete(m.id);
  }

  /** On handler failure: retry up to maxDeliveries, then dead-letter + ack. */
  private async handleFailure(batch: QueuedMessage[]): Promise<void> {
    const pipe = this.redis.pipeline();
    const giveUp: string[] = [];
    for (const m of batch) {
      const n = (this.attempts.get(m.id) ?? 0) + 1;
      this.attempts.set(m.id, n);
      if (n >= this.maxDeliveries) {
        pipe.xadd(
          this.dlq,
          "*",
          FIELD_PROJECT,
          m.projectId,
          FIELD_EVENT,
          JSON.stringify(m.event),
        );
        giveUp.push(m.id);
      }
    }
    if (giveUp.length > 0) {
      pipe.xack(this.stream, this.group, ...giveUp);
      for (const id of giveUp) this.attempts.delete(id);
    }
    await pipe.exec();
    // Non-dead-lettered messages stay pending → reclaimed/retried next loop.
  }

  async close(): Promise<void> {
    this.redis.disconnect();
  }
}
