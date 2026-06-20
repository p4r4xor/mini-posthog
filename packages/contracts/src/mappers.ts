import type { CaptureEvent } from "./events.js";
import type { EventRow } from "./storage.js";

/**
 * Canonical translation from the wire DTO to the flat storage row. Kept in the
 * contracts package so there is exactly one definition of how a polymorphic
 * `CaptureEvent` flattens into the wide `events` table. Ingestion uses this; no
 * other layer reaches across representations.
 *
 * Absent type-specific fields become null - the sparse-column model. `projectId`
 * is supplied by ingestion (resolved from the API key), never by the client.
 */
export function captureEventToRow(event: CaptureEvent, projectId: string): EventRow {
  return {
    eventId: event.eventId,
    traceId: event.traceId,
    runId: event.runId,
    projectId,
    eventType: event.eventType,
    timestamp: event.timestamp,
    agentName: event.agentName,
    userId: event.userId,
    stepIndex: event.stepIndex,
    model: "model" in event ? event.model : null,
    toolName: "toolName" in event ? (event.toolName ?? null) : null,
    status: "status" in event ? (event.status ?? null) : null,
    errorType: "errorType" in event ? event.errorType : null,
    latencyMs: "latencyMs" in event ? (event.latencyMs ?? null) : null,
    inputTokens: "inputTokens" in event ? event.inputTokens : null,
    outputTokens: "outputTokens" in event ? event.outputTokens : null,
    costUsd: "costUsd" in event ? (event.costUsd ?? null) : null,
    metadata: event.metadata ?? {},
  };
}
