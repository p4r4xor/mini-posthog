import Anthropic from "@anthropic-ai/sdk";
import type { LlmPlanner, PlanContext } from "./types.js";
import {
  EMIT_TOOL_NAME,
  DEFAULT_MODEL,
  buildSystemPrompt,
  buildInputSchema,
} from "./prompt.js";

/**
 * Default LLM planner (docs/architecture.md §10, step 2).
 *
 * Uses the Anthropic SDK with FORCED structured output via tool-use: the model
 * is required to call `emit_query_plan`, and we return the raw tool input as
 * `unknown`. The hybrid layer validates it with `QueryPlan.safeParse` — this
 * class never trusts the model and never produces SQL.
 *
 * If no API key is configured, `available()` returns false so the hybrid layer
 * degrades gracefully to a clean "unsupported" rejection instead of throwing.
 */

export interface AnthropicLlmPlannerConfig {
  apiKey?: string;
  model?: string;
  maxTokens?: number;
}

export class AnthropicLlmPlanner implements LlmPlanner {
  private readonly client: Anthropic | null;
  private readonly model: string;
  private readonly maxTokens: number;

  constructor(config: AnthropicLlmPlannerConfig = {}) {
    const apiKey = config.apiKey ?? process.env.ANTHROPIC_API_KEY;
    this.client = apiKey ? new Anthropic({ apiKey }) : null;
    this.model = config.model ?? DEFAULT_MODEL;
    this.maxTokens = config.maxTokens ?? 1024;
  }

  available(): boolean {
    return this.client !== null;
  }

  async plan(nl: string, _ctx: PlanContext): Promise<unknown> {
    if (!this.client) {
      throw new Error("AnthropicLlmPlanner is unavailable: no ANTHROPIC_API_KEY");
    }

    const msg = await this.client.messages.create({
      model: this.model,
      max_tokens: this.maxTokens,
      system: buildSystemPrompt(),
      tools: [
        {
          name: EMIT_TOOL_NAME,
          description:
            "Emit a single typed QueryPlan describing what to compute. " +
            "All values must come from the whitelists in the system prompt.",
          input_schema: buildInputSchema() as Anthropic.Tool.InputSchema,
        },
      ],
      tool_choice: { type: "tool", name: EMIT_TOOL_NAME },
      messages: [{ role: "user", content: nl }],
    });

    const toolUse = msg.content.find(
      (block): block is Anthropic.ToolUseBlock =>
        block.type === "tool_use" && block.name === EMIT_TOOL_NAME,
    );
    if (!toolUse) {
      throw new Error("LLM did not emit a query plan via the tool");
    }
    return toolUse.input as unknown;
  }
}

/** Build the default LLM planner from the environment. */
export function defaultLlmPlanner(): LlmPlanner {
  return new AnthropicLlmPlanner();
}
