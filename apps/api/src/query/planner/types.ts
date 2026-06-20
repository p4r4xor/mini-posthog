import type { QueryPlan, TimeRange } from "@ata/contracts";

/**
 * Shared types for the NL→QueryPlan planner (docs/architecture.md §10).
 *
 * The planner is a hybrid: deterministic templates run first, then a
 * constrained LLM fills the same QueryPlan slots as a fallback. Nothing the LLM
 * emits is trusted - the hybrid layer is the safety boundary and re-validates
 * every plan with the QueryPlan Zod schema before returning it.
 */

/** Context passed to every planner stage (resolved time window etc.). */
export interface PlanContext {
  /** The reference "now" used to compute a default lookback window. */
  now: Date;
  /** The resolved time range applied to plans that don't specify their own. */
  timeRange: TimeRange;
}

/**
 * The LLM planner port. The default implementation talks to Anthropic, but
 * tests inject a fake so the planner runs offline with no network.
 *
 * Returns `unknown` on purpose: the hybrid layer validates the result with
 * `QueryPlan.safeParse`, so the model only fills slots - nothing unvalidated
 * ever reaches the compiler/engine.
 */
export interface LlmPlanner {
  /** Whether this planner can run (e.g. an API key is configured). */
  available(): boolean;
  /** Produce a candidate QueryPlan-shaped object from natural language. */
  plan(nl: string, ctx: PlanContext): Promise<unknown>;
}

/**
 * The result of planning. A discriminated union so callers handle the
 * rejection path explicitly - we NEVER throw raw model output.
 */
export type PlanResult =
  | { ok: true; plan: QueryPlan; source: "deterministic" | "llm" }
  | { ok: false; reason: string; supported: string[] };

/** Options for `planQuery` - all optional, with test-friendly injection points. */
export interface PlanOptions {
  /** Reference time; inject a fixed value for deterministic tests. */
  now?: Date;
  /** Explicit time window override; otherwise a default lookback is used. */
  timeRange?: TimeRange;
  /** Inject a fake LLM planner in tests; defaults to a real Anthropic client. */
  llm?: LlmPlanner;
  /** Default lookback window in days when no `timeRange` is supplied. */
  defaultLookbackDays?: number;
}

/**
 * The published supported-query catalog (docs/architecture.md §9). Returned with
 * every rejection so the UI can show the user what it *can* answer.
 */
export const SUPPORTED_QUESTIONS: readonly string[] = [
  "Average LLM latency by model over time",
  "Which tools fail the most",
  "Token usage by agent type",
  "Cost per successful run by model",
  "Top 10 slowest traces",
  "Error rate by tool name",
  "Number of runs per hour",
  "Average steps per run by outcome",
];
