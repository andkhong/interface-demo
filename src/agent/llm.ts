// The "decide" part of observe -> decide -> act.
//
// DecisionModel is an interface so the loop can run with Claude (real discovery) or with a
// scripted model (tests, no API key).

import Anthropic from "@anthropic-ai/sdk";
import type { BetaContentBlockParam } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { Observation } from "../surface/types";
import { renderTurn, SYSTEM_PROMPT, type Turn } from "./prompt";
import { TOOLS } from "./tools";

export interface Decision {
  tool: string;
  input: Record<string, unknown>;
  /** Any short text the model wrote next to its tool call. */
  text: string;
  model: string;
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number } | null;
}

export interface DecisionModel {
  readonly name: string;
  decide(turn: Turn): Promise<Decision>;
}

export class ClaudeDecisionModel implements DecisionModel {
  // Keys that are not scoped to a workspace must name one with this header.
  private readonly client = new Anthropic(
    process.env.ANTHROPIC_WORKSPACE_ID ? { defaultHeaders: { "anthropic-workspace-id": process.env.ANTHROPIC_WORKSPACE_ID } } : {},
  );

  constructor(readonly name: string = process.env.ANTHROPIC_MODEL || "claude-opus-5") {}

  async decide(turn: Turn): Promise<Decision> {
    const content: BetaContentBlockParam[] = [{ type: "text", text: renderTurn(turn) }];
    if (turn.observation.screenshotBase64) {
      content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: turn.observation.screenshotBase64 } });
    }
    // Server-side refusal fallback is available for the Opus 5 / Fable 5.1 tier.
    const fallback = /^claude-(opus-5|fable-5-1)/.test(this.name)
      ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const }
      : {};

    for (let attempt = 1; attempt <= 2; attempt++) {
      if (attempt === 2) content.push({ type: "text", text: "You must respond by calling exactly one tool." });
      const response = await this.client.beta.messages.create({
        model: this.name,
        max_tokens: 16_000,
        thinking: { type: "adaptive" },
        output_config: { effort: (process.env.ANTHROPIC_EFFORT as "low" | "medium" | "high" | undefined) ?? "medium" },
        system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
        tools: TOOLS,
        tool_choice: { type: "auto", disable_parallel_tool_use: true },
        messages: [{ role: "user", content }],
        ...fallback,
      });
      if (response.stop_reason === "refusal") throw new Error("the model declined this request");

      const text = response.content
        .map((block) => (block.type === "text" ? block.text : ""))
        .join(" ")
        .trim();
      const call = response.content.find((block) => block.type === "tool_use");
      if (call && call.type === "tool_use") {
        return {
          tool: call.name,
          input: call.input as Record<string, unknown>,
          text,
          model: response.model,
          usage: {
            inputTokens: response.usage.input_tokens,
            outputTokens: response.usage.output_tokens,
            cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
          },
        };
      }
    }
    throw new Error("the model did not choose an action");
  }
}

/** A pre-written sequence of decisions, for tests. Each entry looks at the screen to find refs. */
export class ScriptedDecisionModel implements DecisionModel {
  readonly name = "scripted-test-model";
  private index = 0;

  constructor(private readonly script: ((observation: Observation) => { tool: string; input: Record<string, unknown> })[]) {}

  async decide(turn: Turn): Promise<Decision> {
    const next = this.script[this.index++];
    const decision = next ? next(turn.observation) : { tool: "request_human", input: { reason: "script ended" } };
    return { ...decision, text: "", model: this.name, usage: null };
  }
}

/** Find the [ref] of the first element whose description matches. */
export function refFor(observation: Observation, pattern: RegExp): string {
  for (const match of observation.text.matchAll(/\[([\w-]+:\d+)\] ([^[|\n]*)/g)) {
    if (pattern.test(match[2]!.trim())) return match[1]!;
  }
  throw new Error(`no element matching ${pattern} on screen`);
}
