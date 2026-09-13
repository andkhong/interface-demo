// A readable Markdown summary of a capability, for human reviewers.

import type { Capability, Check, Locator } from "./schema";
import { approvalState } from "./store";

function locatorText(l: Locator): string {
  switch (l.by) {
    case "role":
      return `role \`${l.role}\` named "${l.name}"`;
    case "rowLabel":
      return `\`${l.role}\` in the row labelled "${l.label}"`;
    case "tableCell":
      return `cell in column "${l.column}", row "${l.row}"`;
    case "css":
      return `css \`${l.selector}\``;
  }
}

function checkText(c: Check, cap: Capability): string {
  switch (c.type) {
    case "targetVisible":
      return `"${cap.targets[c.target]?.description ?? c.target}" is visible`;
    case "textVisible":
      return `text "${c.text}" is visible`;
    case "urlContains":
      return `a frame URL contains "${c.value}"`;
    case "outputPresent":
      return `output \`${c.output}\` was read`;
  }
}

export function renderCapability(cap: Capability): string {
  const lines: string[] = [];
  lines.push(`# ${cap.title}`, "");
  lines.push(`\`${cap.id}@${cap.version}\` · status **${approvalState(cap)}** · risk **${cap.risk}** · app \`${cap.app.profile}\``, "");
  lines.push(cap.description, "");
  if (cap.approval) lines.push(`Approved by ${cap.approval.by} at ${cap.approval.at} (stability ${cap.approval.stability}).`, "");
  for (const note of cap.reviewNotes) lines.push(`> ⚠️ Review note: ${note}`, "");
  lines.push(`Created from: ${cap.createdFrom.kind}${cap.createdFrom.runId ? ` run \`${cap.createdFrom.runId}\`` : ""}${cap.createdFrom.model ? ` with \`${cap.createdFrom.model}\`` : ""}.`, "");

  lines.push("## Inputs", "", "| Name | Type | Rule | Sensitivity | Description |", "|---|---|---|---|---|");
  for (const [name, spec] of Object.entries(cap.inputs)) {
    const rule = spec.pattern ? `\`${spec.pattern}\`` : spec.values ? spec.values.map((v) => `"${v}"`).join(", ") : "";
    lines.push(`| \`${name}\` | ${spec.type} | ${rule} | ${spec.sensitivity} | ${spec.description} |`);
  }
  lines.push("", "## Outputs", "", "| Name | Type | Sensitivity | Description |", "|---|---|---|---|");
  for (const [name, spec] of Object.entries(cap.outputs)) {
    lines.push(`| \`${name}\` | ${spec.type} | ${spec.sensitivity} | ${spec.description} |`);
  }
  lines.push("", "## Business outcomes (not errors)", "");
  if (cap.outcomes.length === 0) lines.push("_none_");
  for (const o of cap.outcomes) lines.push(`- \`${o.code}\` when "${o.whenTextVisible}" is shown: ${o.description}`);

  lines.push("", "## Steps", "");
  cap.steps.forEach((step, i) => {
    const target = cap.targets[step.do.target];
    const what =
      step.do.action === "fill"
        ? ` with \`${step.do.value}\``
        : step.do.action === "select"
          ? ` option \`${step.do.option}\``
          : step.do.action === "press"
            ? ` key \`${step.do.key}\``
            : step.do.action === "extract"
              ? ` into output \`${step.do.output}\``
              : "";
    const flags = [step.risk === "irreversible" ? "⚠️ IRREVERSIBLE (needs human approval)" : "", step.by === "human" ? "👤 recorded from a human - review" : ""]
      .filter(Boolean)
      .join(" · ");
    lines.push(`${i + 1}. **${step.intent}** — ${step.do.action} "${target?.description}"${what}${flags ? ` · ${flags}` : ""}`);
    lines.push(`   - find it by: ${target?.locators.map(locatorText).join(" → ")}${target?.frame ? ` (frame \`${target.frame}\`)` : ""}`);
    if (step.then.length) lines.push(`   - then check: ${step.then.map((c) => checkText(c, cap)).join("; ")}`);
  });
  lines.push("", "## Final check", "", ...cap.finalCheck.map((c) => `- ${checkText(c, cap)}`), "");
  return lines.join("\n");
}
