/**
 * Map a decoded protobuf `Event` (flat) to a wire `CaptureEvent`-shaped object.
 *
 * We only copy the fields valid for the event's type so the downstream
 * `CaptureEvent.safeParse` (strict union) accepts it — i.e. gRPC reuses the exact
 * same validation as HTTP. The result is `unknown` on purpose: IngestionService
 * validates it, this mapper never asserts correctness.
 */

const EVENT_TYPE: Record<string, string> = {
  RUN_STARTED: "run_started",
  LLM_CALL: "llm_call",
  TOOL_CALL: "tool_call",
  STEP_COMPLETED: "step_completed",
  ERROR: "error",
  RETRY: "retry",
  RUN_COMPLETED: "run_completed",
};

/** Decoded proto field bag (proto-loader returns plain objects). */
type ProtoEvent = Record<string, unknown>;

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);

function parseMetadata(v: unknown): Record<string, unknown> {
  const raw = str(v);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export function protoEventToWire(e: ProtoEvent): unknown {
  const eventType = EVENT_TYPE[str(e.event_type)] ?? str(e.event_type);
  const base = {
    eventId: str(e.event_id),
    traceId: str(e.trace_id),
    runId: str(e.run_id),
    timestamp: str(e.timestamp),
    agentName: str(e.agent_name),
    userId: str(e.user_id),
    stepIndex: num(e.step_index) ?? 0,
    metadata: parseMetadata(e.metadata_json),
  };
  const latencyMs = num(e.latency_ms);
  const optLatency = latencyMs !== undefined ? { latencyMs } : {};

  switch (eventType) {
    case "run_started":
      return { ...base, eventType, status: "running", input: str(e.input) };
    case "llm_call":
      return {
        ...base,
        eventType,
        model: str(e.model),
        status: str(e.status) || "success",
        latencyMs: latencyMs ?? 0,
        inputTokens: num(e.input_tokens) ?? 0,
        outputTokens: num(e.output_tokens) ?? 0,
        costUsd: num(e.cost_usd) ?? 0,
      };
    case "tool_call":
      return {
        ...base,
        eventType,
        toolName: str(e.tool_name),
        status: str(e.status) || "success",
        latencyMs: latencyMs ?? 0,
        ...(num(e.cost_usd) !== undefined ? { costUsd: num(e.cost_usd) } : {}),
      };
    case "step_completed":
      return { ...base, eventType, ...optLatency };
    case "error":
      return {
        ...base,
        eventType,
        status: "failed",
        errorType: str(e.error_type),
        ...(str(e.tool_name) ? { toolName: str(e.tool_name) } : {}),
        ...(str(e.message) ? { message: str(e.message) } : {}),
        ...optLatency,
      };
    case "retry":
      return {
        ...base,
        eventType,
        attempt: num(e.attempt) ?? 1,
        ...(str(e.tool_name) ? { toolName: str(e.tool_name) } : {}),
        ...(str(e.status) ? { status: str(e.status) } : {}),
        ...optLatency,
      };
    case "run_completed":
      return {
        ...base,
        eventType,
        status: str(e.status) || "success",
        ...(str(e.output) ? { output: str(e.output) } : {}),
      };
    default:
      return { ...base, eventType };
  }
}
