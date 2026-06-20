/**
 * Distribution profiles for the simulated world: agents, users, models, tools.
 *
 * These are the knobs that make generated traces "realistic": each model has a
 * distinct latency/token/cost profile, each tool a distinct latency + failure
 * rate, agents prefer different models/tools. Everything is data - the generator
 * (generator.ts) draws from these via the seeded RNG so the output varies by
 * index but is reproducible.
 */

export interface ModelProfile {
  name: string;
  /** Relative likelihood of an agent reaching for this model. */
  weight: number;
  /** Per-call latency window (ms). */
  latencyMs: [min: number, max: number];
  /** Prompt-token window. */
  inputTokens: [min: number, max: number];
  /** Completion-token window. */
  outputTokens: [min: number, max: number];
  /** USD cost per 1K input / output tokens. */
  costPer1kInput: number;
  costPer1kOutput: number;
  /** Probability a single LLM call fails (rate-limit / overload / etc). */
  failureRate: number;
}

export interface ToolProfile {
  name: string;
  weight: number;
  latencyMs: [min: number, max: number];
  /** Probability a single tool call fails. */
  failureRate: number;
  /** Optional per-call cost (most tools are free). */
  costUsd?: number;
}

export interface AgentProfile {
  name: string;
  weight: number;
  /** Tools this agent tends to use (names must exist in TOOLS). */
  preferredTools: readonly string[];
  /** Typical number of LLM+tool steps in a run. */
  stepRange: [min: number, max: number];
  /** Probability the whole run ultimately fails. */
  runFailureRate: number;
}

/**
 * Frontier and small models with deliberately different cost/latency/quality
 * profiles, so "avg latency by model" / "cost per run by model" have real
 * spread. Names match the task's required set.
 */
export const MODELS: readonly ModelProfile[] = [
  {
    name: "gpt-5.2",
    weight: 3,
    latencyMs: [600, 4200],
    inputTokens: [400, 6000],
    outputTokens: [120, 1800],
    costPer1kInput: 0.005,
    costPer1kOutput: 0.015,
    failureRate: 0.04,
  },
  {
    name: "claude-4.5",
    weight: 3,
    latencyMs: [550, 3800],
    inputTokens: [400, 6500],
    outputTokens: [150, 2000],
    costPer1kInput: 0.003,
    costPer1kOutput: 0.015,
    failureRate: 0.035,
  },
  {
    name: "gpt-4.1-mini",
    weight: 2,
    latencyMs: [200, 1400],
    inputTokens: [200, 3000],
    outputTokens: [80, 800],
    costPer1kInput: 0.0004,
    costPer1kOutput: 0.0016,
    failureRate: 0.02,
  },
  {
    name: "claude-haiku-4.5",
    weight: 2,
    latencyMs: [180, 1200],
    inputTokens: [200, 3200],
    outputTokens: [80, 900],
    costPer1kInput: 0.0008,
    costPer1kOutput: 0.004,
    failureRate: 0.02,
  },
];

export const TOOLS: readonly ToolProfile[] = [
  { name: "web_search", weight: 4, latencyMs: [300, 2500], failureRate: 0.06 },
  { name: "web_fetch", weight: 3, latencyMs: [200, 4000], failureRate: 0.09 },
  { name: "code_exec", weight: 2, latencyMs: [100, 3000], failureRate: 0.12 },
  { name: "sql_query", weight: 2, latencyMs: [50, 1800], failureRate: 0.07 },
  { name: "calculator", weight: 1, latencyMs: [5, 80], failureRate: 0.01 },
];

export const AGENTS: readonly AgentProfile[] = [
  {
    name: "research-agent",
    weight: 4,
    preferredTools: ["web_search", "web_fetch", "calculator"],
    stepRange: [3, 9],
    runFailureRate: 0.12,
  },
  {
    name: "coder-agent",
    weight: 3,
    preferredTools: ["code_exec", "web_search", "web_fetch"],
    stepRange: [2, 8],
    runFailureRate: 0.18,
  },
  {
    name: "support-agent",
    weight: 3,
    preferredTools: ["web_search", "calculator"],
    stepRange: [1, 5],
    runFailureRate: 0.08,
  },
  {
    name: "data-agent",
    weight: 2,
    preferredTools: ["sql_query", "code_exec", "calculator"],
    stepRange: [2, 7],
    runFailureRate: 0.14,
  },
];

/** A pool of synthetic users. Index in deterministically by run number. */
export const USER_COUNT = 200;
export function userId(index: number): string {
  return `user_${String(index % USER_COUNT).padStart(4, "0")}`;
}

/** Error types we attach to failed LLM/tool calls and run failures. */
export const ERROR_TYPES = [
  "rate_limit",
  "timeout",
  "tool_error",
  "context_overflow",
  "invalid_output",
  "provider_overloaded",
] as const;

/** Sample inputs/outputs so traces look like real agent work in the explorer. */
export const SAMPLE_INPUTS: readonly string[] = [
  "Find pricing for sandbox providers",
  "Summarize the latest changes in the auth module",
  "What is the error rate of the checkout service this week?",
  "Refactor the payment handler to use the new SDK",
  "Compare three vector databases for our workload",
  "Draft a reply to the customer about the refund delay",
  "Compute the quarter-over-quarter revenue growth",
  "Investigate why the nightly job is timing out",
];
