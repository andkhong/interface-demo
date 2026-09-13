// The actions the discovery AI can take. One tool call = one action on the screen.
// Every field is required so the recorder always gets what it needs. (The API's strict mode
// rejects this many schemas as "too complex", so the loop checks required fields itself.)

import type { BetaTool } from "@anthropic-ai/sdk/resources/beta/messages/messages";

const ref = { type: "string", description: 'The [ref] of the element on the CURRENT screen, e.g. "main:12".' };
const targetName = {
  type: "string",
  description: "Short camelCase name for the control, e.g. memberNumberBox, inquireButton, savingsBalanceCell.",
};
const intent = {
  type: "string",
  description: "One short plain-English sentence saying what this step does, e.g. 'Open Member Inquiry from the menu'.",
};
const valueSource = {
  type: "string",
  enum: ["goal_input", "fixed"],
  description: "goal_input if the value comes from the goal and would change between runs (member number, amount, product); fixed if it is always the same.",
};
const inputName = { type: "string", description: 'camelCase input name when value_source is goal_input (e.g. "memberId"); empty string when fixed.' };
const inputDescription = { type: "string", description: "What the input means, for the caller; empty string when fixed." };
const sensitivity = {
  type: "string",
  enum: ["none", "pii"],
  description: "pii for names, SSNs, birth dates, addresses, phone numbers, member/account numbers; none for amounts, statuses, codes, confirmation numbers.",
};

export const TOOLS: BetaTool[] = [
  {
    name: "click",
    description: "Click a link or button.",
    input_schema: {
      type: "object",
      properties: {
        ref,
        target_name: targetName,
        intent,
        risk: {
          type: "string",
          enum: ["safe", "irreversible"],
          description: "irreversible if this click submits, confirms, posts or transfers something that cannot be undone.",
        },
      },
      required: ["ref", "target_name", "intent", "risk"],
      additionalProperties: false,
    },
  },
  {
    name: "fill",
    description: "Type a value into a text box (replaces what is there).",
    input_schema: {
      type: "object",
      properties: {
        ref,
        target_name: targetName,
        intent,
        value: { type: "string" },
        value_source: valueSource,
        input_name: inputName,
        input_description: inputDescription,
        sensitivity,
      },
      required: ["ref", "target_name", "intent", "value", "value_source", "input_name", "input_description", "sensitivity"],
      additionalProperties: false,
    },
  },
  {
    name: "select",
    description: "Choose an option in a dropdown, by its visible text exactly as listed in options=[...].",
    input_schema: {
      type: "object",
      properties: {
        ref,
        target_name: targetName,
        intent,
        option: { type: "string" },
        value_source: valueSource,
        input_name: inputName,
        input_description: inputDescription,
        sensitivity,
      },
      required: ["ref", "target_name", "intent", "option", "value_source", "input_name", "input_description", "sensitivity"],
      additionalProperties: false,
    },
  },
  {
    name: "press",
    description: "Press a key (e.g. Enter) while an element is focused.",
    input_schema: {
      type: "object",
      properties: { ref, target_name: targetName, intent, key: { type: "string" } },
      required: ["ref", "target_name", "intent", "key"],
      additionalProperties: false,
    },
  },
  {
    name: "extract",
    description: "Read a value the goal asks for, from the table cell that holds the value itself (not its label).",
    input_schema: {
      type: "object",
      properties: {
        ref,
        target_name: targetName,
        intent,
        output_name: { type: "string", description: 'camelCase name of the value returned to the caller, e.g. "savingsBalance".' },
        output_type: { type: "string", enum: ["string", "money"] },
        output_description: { type: "string" },
        sensitivity,
      },
      required: ["ref", "target_name", "intent", "output_name", "output_type", "output_description", "sensitivity"],
      additionalProperties: false,
    },
  },
  {
    name: "finish",
    description: "Call when the goal is complete and every requested value has been extracted.",
    input_schema: {
      type: "object",
      properties: {
        capability_name: { type: "string", description: 'kebab-case name for this reusable capability, e.g. "get-savings-balance".' },
        title: { type: "string", description: "Short title, without any member-specific data." },
        description: { type: "string", description: "One or two sentences for a calling agent: what it does, inputs, outputs. No member-specific data." },
        success_text: {
          type: "string",
          description: "Text visible on the CURRENT screen that proves the goal was reached (e.g. a panel title). Not member-specific data.",
        },
        summary: { type: "string" },
      },
      required: ["capability_name", "title", "description", "success_text", "summary"],
      additionalProperties: false,
    },
  },
  {
    name: "request_human",
    description: "Ask a human operator for help when you are stuck, blocked, or the goal cannot be completed (e.g. the record does not exist).",
    input_schema: {
      type: "object",
      properties: { reason: { type: "string" } },
      required: ["reason"],
      additionalProperties: false,
    },
  },
];

/** Required fields the model left out of a tool call (empty if none, or if the tool is unknown). */
export function missingFields(toolName: string, input: Record<string, unknown>): string[] {
  const tool = TOOLS.find((t) => t.name === toolName);
  const required = (tool?.input_schema.required as string[] | undefined) ?? [];
  return required.filter((field) => input[field] === undefined || input[field] === null);
}
