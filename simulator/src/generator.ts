/**
 * Pure, deterministic trace generator.
 *
 * `generateTrace(rng, ctx)` yields the ordered sequence of SDK calls that make
 * up ONE trace — `start_trace`, one-or-more runs each bracketed by
 * `start_run`/`end_run`, with `llm_call`/`tool_call`/`step`/`error`/`retry`
 * captures in between. It performs NO I/O and never constructs an SDK client;
 * the driver (run-simulation.ts) replays these descriptors against a real
 * client, and tests can assert directly on what is yielded.
 *
 * Determinism: every random choice and every timestamp is derived from the
 * passed-in `rng` and the base time window in `ctx`. No `Math.random()` / no
 * `Date.now()`. Same seed + same ctx ⇒ identical stream.
 *
 * Time spread (docs/architecture.md §7 — time-series queries need real
 * distribution): each trace gets a start time spread across the window, and a
 * per-trace clock advances by each event's simulated latency, so `at` on every
 * capture reflects when it "happened".
 */
import {
  AGENTS,
  ERROR_TYPES,
  MODELS,
  SAMPLE_INPUTS,
  TOOLS,
  userId,
  type AgentProfile,
  type ModelProfile,
  type ToolProfile,
} from "./profiles.js";
import {
  chance,
  pick,
  randInt,
  skewed,
  weightedPick,
  type Rng,
} from "./rng.js";

/** Per-trace generation context. */
export interface TraceContext {
  /** 0-based index of this trace in the overall run (varies the output). */
  index: number;
  /** Start of the historical window (ms epoch). */
  windowStartMs: number;
  /** End of the historical window (ms epoch). */
  windowEndMs: number;
}

/**
 * The SDK-call descriptors the generator yields. A driver maps each to the
 * corresponding real SDK method; tests assert on them directly. Timestamps are
 * ISO strings so they drop straight into the SDK's `at` option and the wire.
 */
export type SimCall =
  | { kind: "start_trace"; agentName: string; userId: string; tags: Record<string, unknown> }
  | { kind: "start_run"; input: string; at: string }
  | {
      kind: "llm_call";
      model: string;
      latencyMs: number;
      inputTokens: number;
      outputTokens: number;
      costUsd: number;
      status: "success" | "failed";
      at: string;
    }
  | {
      kind: "tool_call";
      toolName: string;
      latencyMs: number;
      status: "success" | "failed";
      costUsd?: number;
      at: string;
    }
  | { kind: "step"; latencyMs: number; at: string }
  | { kind: "error"; errorType: string; message: string; toolName?: string; latencyMs: number; at: string }
  | { kind: "retry"; attempt: number; toolName?: string; status: "success" | "failed"; latencyMs: number; at: string }
  | { kind: "end_run"; status: "success" | "failed"; output?: string; at: string }
  | { kind: "end_trace" };

const round2 = (n: number): number => Math.round(n * 100) / 100;
const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;

function llmCost(model: ModelProfile, inputTokens: number, outputTokens: number): number {
  return round6(
    (inputTokens / 1000) * model.costPer1kInput +
      (outputTokens / 1000) * model.costPer1kOutput,
  );
}

/**
 * Mutable per-trace clock. Starts at the trace's spread start time and advances
 * by each event's latency so events within a run are time-ordered.
 */
class Clock {
  constructor(private ms: number) {}
  /** Current instant as an ISO string (used as the event's `at`). */
  now(): string {
    return new Date(this.ms).toISOString();
  }
  /** Advance by `ms` and return the new instant as ISO. */
  advance(ms: number): string {
    this.ms += Math.max(0, Math.round(ms));
    return this.now();
  }
}

/**
 * Generate one trace as a sequence of SimCalls.
 *
 * Shape: pick an agent (weighted) and a user; spread the trace start across the
 * window. Run the agent loop (LLM + tool steps, with step-level retries +
 * errors). With some probability the whole run fails and the trace gets a
 * SECOND run — a run-level retry, i.e. a trace with more than one run.
 */
export function* generateTrace(rng: Rng, ctx: TraceContext): Generator<SimCall> {
  const agent = weightedPick(rng, AGENTS, AGENTS.map((a) => a.weight));
  const uid = userId(ctx.index * 7 + randInt(rng, 0, 5));

  yield {
    kind: "start_trace",
    agentName: agent.name,
    userId: uid,
    tags: {
      env: chance(rng, 0.85) ? "prod" : "staging",
      tier: chance(rng, 0.3) ? "pro" : "free",
    },
  };

  // Spread trace start uniformly across the window, deterministically.
  const span = Math.max(1, ctx.windowEndMs - ctx.windowStartMs);
  const traceStartMs = ctx.windowStartMs + Math.floor(rng.next() * span);

  // First run; on failure we may issue a run-level retry (a second run).
  const firstFailed = yield* generateRun(rng, agent, traceStartMs, 1);

  if (firstFailed && chance(rng, 0.6)) {
    // Run-level retry: re-run the whole agent shortly after, on the same trace.
    const retryStartMs = traceStartMs + randInt(rng, 2_000, 60_000);
    yield* generateRun(rng, agent, retryStartMs, 2);
  }

  yield { kind: "end_trace" };
}

/**
 * Emit one run (start_run … captures … end_run). Returns whether the run
 * failed, so the caller can decide on a run-level retry.
 */
function* generateRun(
  rng: Rng,
  agent: AgentProfile,
  startMs: number,
  attempt: number,
): Generator<SimCall, boolean> {
  const clock = new Clock(startMs);
  const input = pick(rng, SAMPLE_INPUTS);

  yield { kind: "start_run", input, at: clock.now() };

  const steps = randInt(rng, agent.stepRange[0], agent.stepRange[1]);
  // A run fails if its planned outcome is failure (slightly higher on retries
  // is unrealistic; we keep it the base rate so retries can succeed).
  const runWillFail = chance(rng, agent.runFailureRate);
  // If the run will fail, pick which step is the fatal one.
  const fatalStep = runWillFail ? randInt(rng, 0, steps - 1) : -1;

  let runHadError = false;

  for (let s = 0; s < steps; s++) {
    const fatalHere = s === fatalStep;

    // Each step is an LLM call, optionally followed by a tool call.
    yield* emitLlmCall(rng, clock, fatalHere && chance(rng, 0.5));

    if (chance(rng, 0.7)) {
      const tool = pickTool(rng, agent);
      const toolFatal = fatalHere && !runHadError && chance(rng, 0.6);
      const failed = toolFatal || chance(rng, tool.failureRate);

      if (failed) {
        // Step-level retry: re-attempt the tool a couple of times.
        const retries = randInt(rng, 1, 3);
        let recovered = false;
        for (let r = 1; r <= retries; r++) {
          const retryLatency = skewed(rng, tool.latencyMs[0], tool.latencyMs[1]);
          const retrySucceeded = !toolFatal && chance(rng, 0.5);
          yield {
            kind: "retry",
            attempt: r,
            toolName: tool.name,
            status: retrySucceeded ? "success" : "failed",
            latencyMs: round2(retryLatency),
            at: clock.advance(retryLatency),
          };
          if (retrySucceeded) {
            recovered = true;
            break;
          }
        }
        if (!recovered) {
          // Emit an error event for the exhausted/fatal failure.
          const errLatency = skewed(rng, tool.latencyMs[0], tool.latencyMs[1]);
          yield {
            kind: "error",
            errorType: pick(rng, ERROR_TYPES),
            message: `${tool.name} failed after retries`,
            toolName: tool.name,
            latencyMs: round2(errLatency),
            at: clock.advance(errLatency),
          };
          runHadError = true;
        } else {
          yield* emitToolCall(rng, clock, tool, "success");
        }
      } else {
        yield* emitToolCall(rng, clock, tool, "success");
      }
    }

    // Occasional intermediate reasoning step.
    if (chance(rng, 0.4)) {
      const stepLatency = skewed(rng, 20, 600);
      yield { kind: "step", latencyMs: round2(stepLatency), at: clock.advance(stepLatency) };
    }

    if (fatalHere) {
      if (!runHadError) {
        const errLatency = skewed(rng, 50, 1200);
        yield {
          kind: "error",
          errorType: pick(rng, ERROR_TYPES),
          message: "run aborted",
          latencyMs: round2(errLatency),
          at: clock.advance(errLatency),
        };
      }
      runHadError = true;
      break;
    }
  }

  const status: "success" | "failed" = runWillFail ? "failed" : "success";
  yield {
    kind: "end_run",
    status,
    output: status === "success" ? "Completed task" : "Failed to complete task",
    at: clock.advance(skewed(rng, 5, 120)),
  };

  return status === "failed";
}

function* emitLlmCall(rng: Rng, clock: Clock, forceFail: boolean): Generator<SimCall> {
  const model = weightedPick(rng, MODELS, MODELS.map((m) => m.weight));
  const latencyMs = skewed(rng, model.latencyMs[0], model.latencyMs[1]);
  const inputTokens = Math.round(skewed(rng, model.inputTokens[0], model.inputTokens[1]));
  const outputTokens = Math.round(skewed(rng, model.outputTokens[0], model.outputTokens[1]));
  const failed = forceFail || chance(rng, model.failureRate);
  yield {
    kind: "llm_call",
    model: model.name,
    latencyMs: round2(latencyMs),
    inputTokens,
    outputTokens: failed ? 0 : outputTokens,
    costUsd: failed ? 0 : llmCost(model, inputTokens, outputTokens),
    status: failed ? "failed" : "success",
    at: clock.advance(latencyMs),
  };
}

function* emitToolCall(
  rng: Rng,
  clock: Clock,
  tool: ToolProfile,
  status: "success" | "failed",
): Generator<SimCall> {
  const latencyMs = skewed(rng, tool.latencyMs[0], tool.latencyMs[1]);
  yield {
    kind: "tool_call",
    toolName: tool.name,
    latencyMs: round2(latencyMs),
    status,
    ...(tool.costUsd !== undefined ? { costUsd: tool.costUsd } : {}),
    at: clock.advance(latencyMs),
  };
}

function pickTool(rng: Rng, agent: AgentProfile): ToolProfile {
  // Mostly the agent's preferred tools; occasionally any tool.
  if (chance(rng, 0.85)) {
    const name = pick(rng, agent.preferredTools);
    const found = TOOLS.find((t) => t.name === name);
    if (found) return found;
  }
  return weightedPick(rng, TOOLS, TOOLS.map((t) => t.weight));
}

/** Number of wire events a SimCall stream produces (everything but start_trace/end_trace). */
export function countEvents(calls: Iterable<SimCall>): number {
  let n = 0;
  for (const c of calls) {
    if (c.kind !== "start_trace" && c.kind !== "end_trace") n++;
  }
  return n;
}
