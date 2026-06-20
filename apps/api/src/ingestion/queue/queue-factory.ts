import type { QueueKind } from "../../config.js";
import type { EventQueue } from "./event-queue.js";
import { MemoryEventQueue } from "./memory-queue.js";
import { RedisStreamQueue } from "./redis-stream-queue.js";

/** Construct the configured queue backend (memory for dev/tests, Redis for real). */
export function createQueue(kind: QueueKind, opts: { redisUrl: string }): EventQueue {
  if (kind === "redis") return new RedisStreamQueue({ url: opts.redisUrl });
  return new MemoryEventQueue();
}
