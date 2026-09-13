// The capability file format ("capability/1").
//
// A capability is a recorded flow turned into a contract an AI agent can call:
//   inputs   -> what the caller must provide (typed)
//   outputs  -> what the caller gets back (typed)
//   outcomes -> legitimate business answers that are NOT errors (e.g. MEMBER_NOT_FOUND)
//   targets  -> how to find each control, several ways, best first
//   steps    -> what to do, in order, each with a check that it worked
//
// Zod gives us both the TypeScript types and runtime validation when a file is loaded.

import { z } from "zod";

export const Sensitivity = z.enum(["none", "pii", "secret"]);

/** One way to find a control on screen. A target lists several, best first. */
export const Locator = z.discriminatedUnion("by", [
  // Accessible role + name, e.g. button "Inquire". Same idea as screen readers and desktop UI Automation.
  z.object({ by: z.literal("role"), role: z.string(), name: z.string() }),
  // A control in the table row whose label cell says `label`, e.g. textbox in row "Member #".
  // Legacy apps put labels in the neighbouring <td> instead of using <label>.
  z.object({ by: z.literal("rowLabel"), role: z.string(), label: z.string() }),
  // A grid cell: the column headed `column`, in the row that contains the text `row`.
  z.object({ by: z.literal("tableCell"), row: z.string(), column: z.string() }),
  // Technical CSS selector. Last resort: generated names and page structure change most.
  z.object({ by: z.literal("css"), selector: z.string() }),
]);
export type Locator = z.infer<typeof Locator>;

export const Target = z.object({
  description: z.string(),
  /** Frame name hint (e.g. "main"). If omitted, every frame is searched. */
  frame: z.string().optional(),
  locators: z.array(Locator).min(1),
});
export type Target = z.infer<typeof Target>;

/** Something we can verify on screen instead of assuming an action worked. */
export const Check = z.discriminatedUnion("type", [
  z.object({ type: z.literal("targetVisible"), target: z.string() }),
  z.object({ type: z.literal("textVisible"), text: z.string() }),
  z.object({ type: z.literal("urlContains"), value: z.string() }),
  z.object({ type: z.literal("outputPresent"), output: z.string() }),
]);
export type Check = z.infer<typeof Check>;

/** Values may contain {{inputs.name}} or {{secrets.name}} placeholders. */
export const Action = z.discriminatedUnion("action", [
  z.object({ action: z.literal("click"), target: z.string() }),
  z.object({ action: z.literal("fill"), target: z.string(), value: z.string() }),
  z.object({ action: z.literal("select"), target: z.string(), option: z.string() }),
  z.object({ action: z.literal("press"), target: z.string(), key: z.string() }),
  z.object({ action: z.literal("extract"), target: z.string(), output: z.string() }),
]);
export type Action = z.infer<typeof Action>;

export const Step = z.object({
  id: z.string(),
  intent: z.string(),
  do: Action,
  /** "irreversible" steps (e.g. Confirm) need human approval and are never retried automatically. */
  risk: z.enum(["safe", "irreversible"]),
  /** Who performed this step when it was recorded. Human steps should get extra review. */
  by: z.enum(["ai", "human", "author"]),
  /** All checks must pass before moving on. */
  then: z.array(Check),
  timeoutMs: z.number().int().positive(),
});
export type Step = z.infer<typeof Step>;

export const InputSpec = z.object({
  type: z.enum(["string", "enum"]),
  description: z.string(),
  pattern: z.string().optional(),
  values: z.array(z.string()).optional(),
  sensitivity: Sensitivity,
});
export type InputSpec = z.infer<typeof InputSpec>;

export const OutputSpec = z.object({
  type: z.enum(["string", "money"]),
  description: z.string(),
  sensitivity: Sensitivity,
});
export type OutputSpec = z.infer<typeof OutputSpec>;

export const Outcome = z.object({
  code: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
  description: z.string(),
  whenTextVisible: z.string(),
});
export type Outcome = z.infer<typeof Outcome>;

export const Approval = z.object({
  by: z.string(),
  at: z.string(),
  contentHash: z.string(),
  stability: z.string(),
});

export const Capability = z.object({
  schemaVersion: z.literal("capability/1"),
  id: z.string().regex(/^[a-z0-9-]+(\.[a-z0-9-]+)+$/),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  title: z.string(),
  description: z.string(),
  status: z.enum(["draft", "approved"]),
  approval: Approval.nullable(),
  /** sha256 of everything except status/approval/contentHash. Approval is tied to this. */
  contentHash: z.string(),
  createdFrom: z.object({
    kind: z.enum(["discovery", "hand-written"]),
    runId: z.string().optional(),
    model: z.string().optional(),
    createdAt: z.string(),
  }),
  app: z.object({
    profile: z.string(),
    surface: z.literal("web"),
    /** Relative to the institution's base URL, so the same file works on another host. */
    startPath: z.string(),
  }),
  risk: z.enum(["read_only", "irreversible"]),
  inputs: z.record(z.string(), InputSpec),
  outputs: z.record(z.string(), OutputSpec),
  outcomes: z.array(Outcome),
  targets: z.record(z.string(), Target),
  steps: z.array(Step).min(1),
  finalCheck: z.array(Check),
  /** Things a human reviewer should look at before approving (e.g. a human helped during discovery). */
  reviewNotes: z.array(z.string()),
});
export type Capability = z.infer<typeof Capability>;

/** Cross-reference checks Zod can't express: every referenced target/output/input must exist. */
export function validateReferences(cap: Capability): string[] {
  const problems: string[] = [];
  const outputsWritten = new Set<string>();
  const checkRefs = (checks: Check[], where: string) => {
    for (const c of checks) {
      if (c.type === "targetVisible" && !cap.targets[c.target]) problems.push(`${where}: unknown target "${c.target}"`);
      if (c.type === "outputPresent" && !cap.outputs[c.output]) problems.push(`${where}: unknown output "${c.output}"`);
    }
  };
  for (const step of cap.steps) {
    if (!cap.targets[step.do.target]) problems.push(`step ${step.id}: unknown target "${step.do.target}"`);
    if (step.do.action === "extract") {
      if (!cap.outputs[step.do.output]) problems.push(`step ${step.id}: unknown output "${step.do.output}"`);
      outputsWritten.add(step.do.output);
    }
    const text = JSON.stringify(step.do);
    for (const m of text.matchAll(/\{\{inputs\.([a-zA-Z0-9_]+)\}\}/g)) {
      if (!cap.inputs[m[1]!]) problems.push(`step ${step.id}: unknown input "${m[1]}"`);
    }
    checkRefs(step.then, `step ${step.id}`);
  }
  checkRefs(cap.finalCheck, "finalCheck");
  for (const name of Object.keys(cap.outputs)) {
    if (!outputsWritten.has(name)) problems.push(`output "${name}" is never extracted`);
  }
  const ids = cap.steps.map((s) => s.id);
  if (new Set(ids).size !== ids.length) problems.push("step ids must be unique");
  return problems;
}
