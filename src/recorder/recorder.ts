// The recorder turns what the AI actually DID (executed, verified actions - not what it said)
// into a capability file.
//
// - Locators are built right before each action and each one is TESTED: it is only kept if it
//   finds exactly the element the AI chose. Positional paths are never kept.
// - Values the AI marked as coming from the goal become typed inputs, and every place the literal
//   value appears (e.g. a link named "100234") becomes {{inputs.memberId}}.
// - Each step gets a check: "the next step's control is visible" (+ "the page changed" if it did).
// - Business outcomes the app can show on the visited pages are copied from the app profile.

import type { Profile } from "../capability/profile";
import type { Capability, Check, InputSpec, Locator, OutputSpec, Step, Target } from "../capability/schema";
import { listVersions } from "../capability/store";
import type { ElementInfo, Observation, Surface } from "../surface/types";

export type RecordedTool = "click" | "fill" | "select" | "press" | "extract";

export interface RecordedAction {
  tool: RecordedTool;
  targetName: string;
  intent: string;
  element: ElementInfo;
  locators: Locator[];
  risk: "safe" | "irreversible";
  /** fill value, select option, or key */
  value?: string;
  /** Set when the value comes from the goal and should become an input. */
  input?: { name: string; description: string; sensitivity: "none" | "pii" };
  /** Set for extract actions. */
  output?: { name: string; type: "string" | "money"; description: string; sensitivity: "none" | "pii" };
}

export interface FinishInfo {
  capabilityName: string;
  title: string;
  description: string;
  successText: string;
}

const ROLE_WORDS: Record<string, string> = {
  link: "link",
  button: "button",
  textbox: "text box",
  combobox: "dropdown",
  cell: "cell",
  checkbox: "checkbox",
  radio: "radio button",
};

export function describeTarget(info: ElementInfo): string {
  const word = ROLE_WORDS[info.role ?? ""] ?? info.tag;
  if (info.role === "cell" && info.tableCell?.row && info.tableCell.column) {
    return `"${info.tableCell.column}" cell in the "${info.tableCell.row}" row`;
  }
  if (info.rowLabel && (info.role === "textbox" || info.role === "combobox" || info.role === "cell" || !info.name)) {
    return `${word} in the row labelled "${info.rowLabel}"`;
  }
  return info.name ? `${word} "${info.name}"` : word;
}

/** Candidate locators, best first. Each is kept only if it finds exactly this element right now. */
export async function buildVerifiedLocators(surface: Surface, info: ElementInfo): Promise<Locator[]> {
  const candidates: Locator[] = [];
  if (info.role && info.role !== "cell" && info.name) candidates.push({ by: "role", role: info.role, name: info.name });
  // One grid-cell candidate per identifying text in the row (e.g. "REGULAR SAVINGS", then "S00"),
  // so the value can still be found if one of them changes.
  if (info.tableCell?.column) {
    for (const row of info.rowKeys) candidates.push({ by: "tableCell", row, column: info.tableCell.column });
  }
  if (info.role && info.rowLabel) candidates.push({ by: "rowLabel", role: info.role, label: info.rowLabel });
  // Positional paths ("html > body > ... :nth-child(3)") can silently point at the wrong element
  // after a small layout change, so they are never saved.
  for (const selector of info.css) if (!selector.startsWith("html >")) candidates.push({ by: "css", selector });

  const verified: Locator[] = [];
  for (const locator of candidates) {
    const result = await surface.find({ description: "verify locator", locators: [locator] });
    if (result.status === "found" && result.element.frame === info.frame && result.element.path === info.path) {
      verified.push(locator);
    }
  }
  return verified;
}

function identifier(text: string): string {
  const words = text.replace(/[^a-zA-Z0-9]+/g, " ").trim().split(" ").filter(Boolean);
  const joined = words.map((w, i) => (i === 0 ? w[0]!.toLowerCase() + w.slice(1) : w[0]!.toUpperCase() + w.slice(1))).join("");
  return /^[a-zA-Z]/.test(joined) ? joined : `x${joined}`;
}

function pascal(text: string): string {
  return text ? text[0]!.toUpperCase() + text.slice(1) : text;
}

function kebab(text: string): string {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
}

function guessPattern(value: string): string | undefined {
  if (/^\d+$/.test(value)) return `^\\d{${value.length}}$`;
  if (/^\d+\.\d{2}$/.test(value)) return "^\\d+(\\.\\d{2})?$";
  return undefined;
}

function pathOf(url: string): string {
  try {
    return url.startsWith("http") ? new URL(url).pathname : "";
  } catch {
    return "";
  }
}

function bumpMinor(version: string): string {
  const [major, minor] = version.split(".").map(Number);
  return `${major}.${(minor ?? 0) + 1}.0`;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export class Recorder {
  private readonly actions: RecordedAction[] = [];
  private readonly visitedPaths = new Set<string>();
  private readonly notes: string[] = [];

  noteObservation(observation: Observation): void {
    for (const frame of observation.frames) {
      const path = pathOf(frame.url);
      if (path) this.visitedPaths.add(path);
    }
  }

  add(action: RecordedAction): void {
    this.actions.push(action);
  }

  addNote(note: string): void {
    this.notes.push(note);
  }

  get count(): number {
    return this.actions.length;
  }

  compile(p: { profile: Profile; finish: FinishInfo; runId: string; model: string; startPath: string }): Capability {
    // ----- inputs -----
    const inputs: Record<string, InputSpec> = {};
    const inputValues: Record<string, string> = {};
    for (const a of this.actions) {
      if (!a.input || a.value === undefined) continue;
      const name = identifier(a.input.name);
      inputValues[name] = a.value;
      inputs[name] =
        a.tool === "select"
          ? {
              type: "enum",
              description: a.input.description,
              values: (a.element.options ?? []).filter((o) => o && !/select/i.test(o)),
              sensitivity: a.input.sensitivity,
            }
          : { type: "string", description: a.input.description, pattern: guessPattern(a.value), sensitivity: a.input.sensitivity };
    }

    // Replace literal input values with placeholders (longest first, whole tokens only).
    const parameterize = (text: string): string => {
      let out = text;
      for (const [name, value] of Object.entries(inputValues).sort((x, y) => y[1].length - x[1].length)) {
        if (value.length < 3) continue;
        out = out.replace(new RegExp(`(?<![\\w])${escapeRegex(value)}(?![\\w])`, "g"), `{{inputs.${name}}}`);
      }
      return out;
    };
    const parameterizeDeep = <T>(value: T): T => {
      if (typeof value === "string") return parameterize(value) as T;
      if (Array.isArray(value)) return value.map(parameterizeDeep) as T;
      if (value && typeof value === "object") {
        return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, parameterizeDeep(v)])) as T;
      }
      return value;
    };

    // ----- targets (reused when the same control is used twice) -----
    const targets: Record<string, Target> = {};
    const targetIds = this.actions.map((a) => {
      const target: Target = parameterizeDeep({
        description: describeTarget(a.element),
        ...(a.element.frame !== "top" ? { frame: a.element.frame } : {}),
        locators: a.locators,
      });
      const base = identifier(a.targetName || "target");
      let id = base;
      for (let n = 2; targets[id] && JSON.stringify(targets[id]) !== JSON.stringify(target); n++) id = `${base}${n}`;
      targets[id] = target;
      return id;
    });

    // ----- steps and outputs -----
    const outputs: Record<string, OutputSpec> = {};
    const usedIds = new Set<string>();
    const steps: Step[] = this.actions.map((a, i) => {
      const target = targetIds[i]!;
      let id = `${a.tool}${pascal(target)}`;
      for (let n = 2; usedIds.has(id); n++) id = `${a.tool}${pascal(target)}${n}`;
      usedIds.add(id);

      let action: Step["do"];
      switch (a.tool) {
        case "click":
          action = { action: "click", target };
          break;
        case "fill":
          action = { action: "fill", target, value: parameterize(a.value ?? "") };
          break;
        case "select":
          action = { action: "select", target, option: parameterize(a.value ?? "") };
          break;
        case "press":
          action = { action: "press", target, key: a.value ?? "Enter" };
          break;
        case "extract": {
          const name = identifier(a.output!.name);
          outputs[name] = { type: a.output!.type, description: a.output!.description, sensitivity: a.output!.sensitivity };
          action = { action: "extract", target, output: name };
          break;
        }
      }
      return { id, intent: parameterize(a.intent), do: action, risk: a.risk, by: "ai", then: [], timeoutMs: 10_000 };
    });

    // ----- checks: after each action, the next control must be visible (and the page must have changed, if it did) -----
    steps.forEach((step, i) => {
      const current = this.actions[i]!;
      const next = this.actions[i + 1];
      if (!next || current.tool === "extract") return;
      const nextPath = pathOf(next.element.frameUrl);
      if (nextPath && nextPath !== pathOf(current.element.frameUrl)) {
        step.then.push({ type: "urlContains", value: parameterize(nextPath) });
      }
      step.then.push({ type: "targetVisible", target: steps[i + 1]!.do.target });
    });

    // ----- business outcomes the app can show on the pages this flow visits -----
    const visited = [...this.visitedPaths];
    const outcomes = p.profile.businessOutcomes
      .filter((o) => o.pages.some((page) => visited.some((v) => v.startsWith(page))))
      .map(({ code, description, whenTextVisible }) => ({ code, description, whenTextVisible }))
      .filter((o, i, all) => all.findIndex((x) => x.code === o.code && x.whenTextVisible === o.whenTextVisible) === i);

    const finalCheck: Check[] = [
      { type: "textVisible", text: parameterize(p.finish.successText) },
      ...Object.keys(outputs).map((output) => ({ type: "outputPresent" as const, output })),
    ];

    const id = `${p.profile.id}.${kebab(p.finish.capabilityName)}`;
    const latest = listVersions(id).at(-1);
    return {
      schemaVersion: "capability/1",
      id,
      version: latest ? bumpMinor(latest) : "1.0.0",
      title: p.finish.title,
      description: parameterize(p.finish.description),
      status: "draft",
      approval: null,
      contentHash: "",
      createdFrom: { kind: "discovery", runId: p.runId, model: p.model, createdAt: new Date().toISOString() },
      app: { profile: p.profile.id, surface: "web", startPath: p.startPath },
      risk: steps.some((s) => s.risk === "irreversible") ? "irreversible" : "read_only",
      inputs,
      outputs,
      outcomes,
      targets,
      steps,
      finalCheck,
      reviewNotes: [...this.notes],
    };
  }
}
