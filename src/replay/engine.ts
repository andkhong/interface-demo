// Deterministic replay: follow a capability file step by step. No AI is involved.
//
// For every step:
//   1. watch for known screens (profile) and business outcomes (capability) while waiting
//   2. find the target (exactly one match; fallback locators allowed but reported)
//   3. act through the Session (control turn + policy + approval for irreversible steps)
//   4. wait until the step's checks pass
//
// Recoveries (maintenance notice, slow page, signed out) are handled here and reported.
// Restarting after a sign-out is only allowed BEFORE any irreversible step has run.

import { loadProfile, loadSecrets, type Profile } from "../capability/profile";
import type { Capability, Check, Step } from "../capability/schema";
import { approvalState } from "../capability/store";
import { fillInputsOnly, fillTemplateDeep } from "../capability/template";
import { RunLogger } from "../evidence/logger";
import { ControlLostError, ControlTurn } from "../handoff/control";
import { noHelpDesk, type HelpDesk } from "../handoff/helpdesk";
import { OperatorConsole } from "../handoff/operator-server";
import { loadPolicy } from "../safety/policy";
import { Redactor } from "../safety/redact";
import { delay, Session } from "../session";
import { WebSurface } from "../surface/web/browser";
import type { FailureCategory, HumanHelp, Recovery, ReplayResult, Warning } from "./result";

export interface ReplayOptions {
  capability: Capability;
  inputs: Record<string, string>;
  /** The institution's app address, e.g. http://localhost:4000 */
  baseUrl: string;
  allowDraft?: boolean;
  /** Ask a human (operator console) instead of failing when stuck. */
  escalate?: boolean;
  operatorPort?: number;
  helpDeadlineMs?: number;
  /** Test hook for the fake app: arm faults such as "interstitial" or "app_error". */
  faults?: string[];
  headless?: boolean;
  autoConfirmRisky?: boolean;
  quiet?: boolean;
  runsDir?: string;
  /** Lets tests reach the live session and console, the way a human operator would. */
  hooks?: { onStarted?: (info: { surface: WebSurface; operatorUrl: string | null }) => void };
}

const MAX_RECOVERIES_PER_CONDITION = 2;

/** Thrown when a business outcome screen appears (e.g. "NO RECORDS MATCH"). */
class OutcomeFound {
  constructor(
    readonly code: string,
    readonly message: string,
  ) {}
}

/** Thrown when we signed out and need to sign on and start the capability again. */
class RestartNeeded {
  constructor(readonly reason: string) {}
}

/** Thrown when a step cannot continue. */
class StepFailed {
  constructor(
    readonly category: FailureCategory,
    readonly message: string,
    readonly expected: string,
    readonly options: { retryable?: boolean; humanCanHelp?: boolean } = {},
  ) {}
}

export function validateInputs(cap: Capability, inputs: Record<string, string>): string[] {
  const problems: string[] = [];
  for (const [name, spec] of Object.entries(cap.inputs)) {
    const value = inputs[name];
    if (value === undefined || value === "") {
      problems.push(`missing input "${name}"`);
      continue;
    }
    if (spec.pattern && !new RegExp(spec.pattern).test(value)) problems.push(`input "${name}" does not match ${spec.pattern}`);
    if (spec.type === "enum" && !spec.values?.includes(value)) problems.push(`input "${name}" must be one of: ${spec.values?.join(", ")}`);
  }
  for (const name of Object.keys(inputs)) {
    if (!cap.inputs[name]) problems.push(`unknown input "${name}"`);
  }
  return problems;
}

function parseOutput(type: "string" | "money", text: string): string | number | null {
  if (type === "money") {
    const cleaned = text.replace(/[$,\s]/g, "");
    return /^-?\d+(\.\d{1,2})?$/.test(cleaned) ? Number(cleaned) : null;
  }
  return text.length > 0 ? text : null;
}

function describeChecks(checks: Check[]): string {
  return checks
    .map((c) =>
      c.type === "targetVisible"
        ? `target "${c.target}" visible`
        : c.type === "textVisible"
          ? `text "${c.text}" visible`
          : c.type === "urlContains"
            ? `a frame URL containing "${c.value}"`
            : `output "${c.output}" read`,
    )
    .join(" AND ");
}

/** The result as written to evidence: sensitive output values are replaced. */
function resultForEvidence(result: ReplayResult, cap: Capability): ReplayResult {
  if (result.status !== "success") return result;
  const outputs = Object.fromEntries(
    Object.entries(result.outputs).map(([k, v]) => [k, cap.outputs[k]?.sensitivity === "none" ? v : "[not logged]"]),
  );
  return { ...result, outputs };
}

export async function replay(opts: ReplayOptions): Promise<{ result: ReplayResult; runDir: string }> {
  const cap = opts.capability;
  const started = Date.now();
  const redactor = new Redactor();
  for (const [name, spec] of Object.entries(cap.inputs)) {
    if (spec.sensitivity !== "none") redactor.addSensitive(opts.inputs[name], spec.sensitivity);
  }
  const log = new RunLogger("replay", redactor, { rootDir: opts.runsDir, quiet: opts.quiet });

  const recoveries: Recovery[] = [];
  const warnings: Warning[] = [];
  const humanHelp: HumanHelp[] = [];
  const outputs: Record<string, string | number> = {};
  const common = () => ({
    capability: { id: cap.id, version: cap.version, contentHash: cap.contentHash },
    runId: log.runId,
    recoveries,
    warnings,
    humanHelp,
    durationMs: Date.now() - started,
  });
  const done = (result: ReplayResult) => {
    log.writeJson("result.json", resultForEvidence(result, cap));
    log.event("run_finished", {
      summary: result.status === "failure" ? `failure: ${result.category}` : result.status === "business_outcome" ? `business outcome: ${result.code}` : "success",
      status: result.status,
    });
    return { result, runDir: log.dir };
  };
  const failNoBrowser = (category: FailureCategory, message: string, expected: string): ReplayResult => ({
    status: "failure",
    ...common(),
    category,
    retryable: false,
    message,
    step: null,
    expected,
    observed: null,
    evidence: { screenshot: null, pages: [] },
  });

  log.event("run_started", {
    summary: `replay ${cap.id}@${cap.version}`,
    capability: { id: cap.id, version: cap.version, contentHash: cap.contentHash, approval: approvalState(cap) },
    inputs: opts.inputs,
    faults: opts.faults ?? [],
    escalate: !!opts.escalate,
  });

  // ---------- pre-flight: nothing touches the app until these pass ----------
  const inputProblems = validateInputs(cap, opts.inputs);
  if (inputProblems.length > 0) {
    return done(failNoBrowser("invalid_input", inputProblems.join("; "), "inputs matching the capability's input schema"));
  }
  if (approvalState(cap) !== "approved" && !opts.allowDraft) {
    return done(
      failNoBrowser("not_approved", `capability is "${approvalState(cap)}"; run stability + approve first, or pass --allow-draft`, "an approved capability"),
    );
  }
  let profile: Profile;
  let secrets: Record<string, string>;
  let policy;
  try {
    profile = loadProfile(cap.app.profile);
    secrets = loadSecrets(profile);
    policy = loadPolicy(cap.app.profile, opts.baseUrl);
  } catch (error) {
    return done(failNoBrowser("unexpected_error", (error as Error).message, "profile, policy and secrets to load"));
  }
  for (const value of Object.values(secrets)) redactor.addSensitive(value, "secret");

  // ---------- live session ----------
  const surface = await WebSurface.launch({
    headless: opts.headless ?? !opts.escalate,
    policy,
    onBlocked: (url, reason) => log.event("navigation_blocked", { summary: reason, url }),
  });
  if (opts.faults?.length) {
    await surface.context.addCookies([{ name: "cu_fault", value: opts.faults.join("."), url: opts.baseUrl }]);
  }
  const control = new ControlTurn();
  const helpDesk: HelpDesk = opts.escalate
    ? await OperatorConsole.start({ port: opts.operatorPort ?? 4100, control, log, deadlineMs: opts.helpDeadlineMs })
    : noHelpDesk;
  const session = new Session({
    surface,
    policy,
    profile,
    control,
    log,
    helpDesk,
    secrets,
    autoConfirmRisky: !!opts.autoConfirmRisky,
    subject: `${cap.id}@${cap.version}`,
    mode: "replay",
  });
  opts.hooks?.onStarted?.({ surface, operatorUrl: helpDesk instanceof OperatorConsole ? helpDesk.url : null });

  // (Cast so TypeScript doesn't assume it stays null: it is set inside runStep.)
  let current = null as Step | null;
  let irreversibleDone = false;
  const recoveryCounts = new Map<string, number>();

  const noteRecovery = (condition: string, action: string) => {
    const count = (recoveryCounts.get(condition) ?? 0) + 1;
    recoveryCounts.set(condition, count);
    if (count > MAX_RECOVERIES_PER_CONDITION) {
      throw new StepFailed("too_many_recoveries", `"${condition}" happened ${count} times`, `"${condition}" to be resolved after ${MAX_RECOVERIES_PER_CONDITION} recoveries`);
    }
    recoveries.push({ step: current?.id ?? null, condition, action });
    log.event("recovered", { summary: `${condition}: ${action}`, step: current?.id ?? null, condition, action });
  };

  // Looks at the whole screen and reacts to anything the profile or capability knows about.
  const watchScreens = async (): Promise<void> => {
    const text = await surface.visibleText();
    for (const screen of profile.knownScreens) {
      if (screen.handle === "fail" && text.includes(screen.whenTextVisible)) {
        throw new StepFailed(screen.category, `the app showed "${screen.whenTextVisible}" (${screen.id})`, "the app to respond normally", {
          retryable: screen.retryable && !irreversibleDone,
        });
      }
    }
    for (const outcome of cap.outcomes) {
      if (text.includes(outcome.whenTextVisible)) throw new OutcomeFound(outcome.code, outcome.description);
    }
    for (const screen of profile.knownScreens) {
      if (!text.includes(screen.whenTextVisible)) continue;
      if (screen.handle === "click") {
        const found = await surface.find(screen.target);
        if (found.status !== "found") continue;
        noteRecovery(screen.id, `clicked "${screen.target.description}"`);
        const result = await session.act({ action: "click", element: found.element, label: screen.target.description, step: null });
        if (!result.ok) throw new StepFailed(result.category, result.message, `permission to dismiss ${screen.id}`);
        await delay(300);
        return;
      }
      if (screen.handle === "sign_on_and_restart") {
        noteRecovery(screen.id, "sign on again and restart from the first step");
        throw new RestartNeeded(screen.id);
      }
    }
    if (text.includes(profile.signOn.whenTextVisible)) {
      noteRecovery("signed_out", "sign on again and restart from the first step");
      throw new RestartNeeded("signed_out");
    }
  };

  /** Poll until `attempt` returns something, watching screens meanwhile. One extra wait for slow pages. */
  const waitUntil = async <T>(label: string, attempt: () => Promise<T | null>, timeoutMs: number): Promise<T | null> => {
    let deadline = Date.now() + timeoutMs;
    let extended = false;
    for (;;) {
      await watchScreens();
      const value = await attempt();
      if (value) return value;
      if (Date.now() >= deadline) {
        if (extended) return null;
        extended = true;
        deadline = Date.now() + timeoutMs;
        noteRecovery("slow_response", `waited an extra ${timeoutMs / 1000}s for ${label}`);
      }
      await delay(250);
    }
  };

  const checkPasses = async (check: Check): Promise<boolean> => {
    switch (check.type) {
      case "targetVisible": {
        const target = fillTemplateDeep(cap.targets[check.target]!, { inputs: opts.inputs });
        const result = await surface.find(target);
        if (result.status === "ambiguous") {
          throw new StepFailed("target_ambiguous", `locator ${JSON.stringify(result.locator)} matched ${result.count} controls`, `exactly one "${target.description}"`, {
            humanCanHelp: true,
          });
        }
        return result.status === "found";
      }
      case "textVisible":
        return !!(await surface.findText(fillInputsOnly(check.text, opts.inputs)));
      case "urlContains": {
        const value = fillInputsOnly(check.value, opts.inputs);
        return (await surface.location()).frames.some((f) => f.url.includes(value));
      }
      case "outputPresent":
        return outputs[check.output] !== undefined;
    }
  };
  const checksPass = async (checks: Check[]) => {
    for (const check of checks) if (!(await checkPasses(check))) return false;
    return true;
  };

  const runStep = async (step: Step, onlyRead = false): Promise<void> => {
    current = step;
    if (onlyRead && step.do.action !== "extract") return;
    log.event("step_started", { summary: `${step.id}: ${step.intent}`, step: step.id, action: step.do.action });
    const target = fillTemplateDeep(cap.targets[step.do.target]!, { inputs: opts.inputs });

    const found = await waitUntil(
      `"${target.description}"`,
      async () => {
        const result = await surface.find(target);
        if (result.status === "ambiguous") {
          throw new StepFailed("target_ambiguous", `locator ${JSON.stringify(result.locator)} matched ${result.count} controls`, `exactly one "${target.description}"`, {
            humanCanHelp: true,
          });
        }
        return result.status === "found" ? result : null;
      },
      step.timeoutMs,
    );
    if (!found) {
      throw new StepFailed("target_not_found", `could not find "${target.description}"`, `"${target.description}" visible (tried ${target.locators.map((l) => l.by).join(", ")})`, {
        humanCanHelp: true,
        retryable: !irreversibleDone,
      });
    }
    if (found.locatorIndex > 0) {
      const detail = `"${target.description}" found with fallback locator #${found.locatorIndex + 1} (${found.locator.by}); the preferred locators no longer match`;
      warnings.push({ step: step.id, kind: "locator_degraded", detail });
      log.event("locator_degraded", { summary: detail, step: step.id });
    }
    log.event("target_found", { summary: `"${target.description}" via ${found.locator.by}`, step: step.id, locator: found.locator.by, locatorIndex: found.locatorIndex });

    const action = step.do;
    if (action.action === "extract") {
      const read = await session.read({ element: found.element, label: target.description, step: { id: step.id, intent: step.intent } });
      if (!read.ok) throw new StepFailed(read.category, read.message, `permission to extract "${target.description}"`);
      const text = read.text;
      const spec = cap.outputs[action.output]!;
      if (spec.sensitivity !== "none") redactor.addSensitive(text, spec.sensitivity);
      const value = parseOutput(spec.type, text);
      if (value === null) {
        throw new StepFailed("bad_output", `read "${text}" for "${action.output}", which is not a valid ${spec.type}`, `a ${spec.type} value`);
      }
      outputs[action.output] = value;
      log.event("extracted", { summary: `read ${action.output} (${spec.type})`, step: step.id, output: action.output, value: spec.sensitivity === "none" ? value : "[not logged]" });
    } else {
      const value =
        action.action === "fill"
          ? fillInputsOnly(action.value, opts.inputs)
          : action.action === "select"
            ? fillInputsOnly(action.option, opts.inputs)
            : action.action === "press"
              ? action.key
              : undefined;
      const result = await session.act({
        action: action.action,
        element: found.element,
        value,
        declaredRisk: step.risk,
        label: target.description,
        step: { id: step.id, intent: step.intent },
      });
      if (!result.ok) throw new StepFailed(result.category, result.message, `permission to ${action.action} "${target.description}"`);
      if (result.risk === "irreversible") irreversibleDone = true;
    }

    if (step.then.length > 0) {
      const ok = await waitUntil("the step's checks", async () => ((await checksPass(step.then)) ? true : null), step.timeoutMs);
      if (!ok) {
        throw new StepFailed("check_failed", `after "${step.intent}" the expected screen did not appear`, describeChecks(step.then), {
          humanCanHelp: true,
          retryable: !irreversibleDone,
        });
      }
    }
    await session.learnSensitiveValues();
    log.event("step_passed", { summary: step.id, step: step.id });
  };

  /** Ask the operator what to do about a stuck step. Returns the index of the next step to run. */
  const getHelp = async (index: number, problem: StepFailed): Promise<{ next: number; onlyRead: boolean }> => {
    const step = cap.steps[index]!;
    const resolution = await session.askHuman({
      kind: "stuck",
      reasonCode: problem.category.toUpperCase(),
      reason: `${problem.message}. Expected: ${problem.expected}`,
      step: { id: step.id, intent: step.intent },
      stepIds: cap.steps.map((s) => s.id),
      choices: ["retry_step", "continue_from", "mark_done", "abort"],
    });
    humanHelp.push({ requestId: `help-${humanHelp.length + 1}`, reasonCode: problem.category.toUpperCase(), choice: resolution.choice, humanActions: resolution.humanActions.length });
    // A human may have done anything, including irreversible things: never auto-restart after this.
    if (cap.risk === "irreversible") irreversibleDone = true;

    switch (resolution.choice) {
      case "retry_step":
        return { next: index, onlyRead: false };
      case "continue_from": {
        const next = cap.steps.findIndex((s) => s.id === resolution.stepId);
        const previous = cap.steps[next - 1];
        // Trust but verify: the step before the chosen one must look finished.
        if (previous && previous.then.length > 0 && !(await checksPass(previous.then))) {
          throw new StepFailed("check_failed", `operator chose to continue from "${resolution.stepId}", but step "${previous.id}" does not look finished`, describeChecks(previous.then));
        }
        return { next, onlyRead: false };
      }
      case "mark_done":
        return { next: index, onlyRead: true };
      case "timeout":
        throw new StepFailed("nobody_responded", "nobody answered the help request before the deadline", "an operator decision");
      default:
        throw new StepFailed("aborted_by_operator", resolution.note ?? "the operator aborted the run", "the run to continue");
    }
  };

  const failureWithEvidence = async (problem: StepFailed): Promise<ReplayResult> => {
    let screenshot: string | null = null;
    const pages: string[] = [];
    let observed: { url: string; frames: { name: string; url: string }[]; visibleText: string } | null = null;
    try {
      await session.learnSensitiveValues();
      screenshot = "screenshots/failure.png";
      await surface.screenshot(log.path(screenshot), profile.sensitiveFields);
      for (const page of await surface.pageSnapshots()) {
        const name = `pages/failure-${page.frame}.html`;
        log.writeText(name, page.html);
        pages.push(name);
      }
      const location = await surface.location();
      observed = { ...location, visibleText: redactor.text((await surface.visibleText()).slice(0, 2000)) };
    } catch {
      // The browser may already be gone; the failure itself still gets reported.
    }
    log.event("failed", { summary: `${problem.category}: ${problem.message}`, step: current?.id ?? null, category: problem.category, expected: problem.expected });
    return {
      status: "failure",
      ...common(),
      category: problem.category,
      retryable: problem.options.retryable ?? false,
      message: problem.message,
      step: current ? { id: current.id, intent: current.intent } : null,
      expected: problem.expected,
      observed,
      evidence: { screenshot, pages },
    };
  };

  // ---------- the run ----------
  try {
    for (;;) {
      try {
        await surface.open(opts.baseUrl + cap.app.startPath);
        if (await session.waitForTarget({ description: "sign-on screen or app", locators: [{ by: "css", selector: "body" }] }, 5000)) {
          if (await surface.findText(profile.signOn.whenTextVisible)) await session.signOn();
        }

        let index = 0;
        let onlyRead = false;
        while (index < cap.steps.length) {
          try {
            await runStep(cap.steps[index]!, onlyRead);
            index++;
          } catch (error) {
            if (!(error instanceof StepFailed) || !error.options.humanCanHelp || !opts.escalate) throw error;
            ({ next: index, onlyRead } = await getHelp(index, error));
          }
        }

        const finalOk = await waitUntil("the final check", async () => ((await checksPass(cap.finalCheck)) ? true : null), 10_000);
        if (!finalOk) throw new StepFailed("check_failed", "the final check did not pass", describeChecks(cap.finalCheck));
        const missing = Object.keys(cap.outputs).filter((name) => outputs[name] === undefined);
        if (missing.length > 0) throw new StepFailed("bad_output", `outputs not read: ${missing.join(", ")}`, "every declared output");

        log.event("final_check_passed", { summary: describeChecks(cap.finalCheck) });
        return done({ status: "success", ...common(), outputs });
      } catch (error) {
        if (error instanceof RestartNeeded) {
          if (irreversibleDone) {
            return done(
              await failureWithEvidence(
                new StepFailed("session_lost", `${error.reason} after an irreversible step; not restarting, to avoid doing it twice`, "the session to stay signed on"),
              ),
            );
          }
          log.event("restarting", { summary: `restarting from the first step after ${error.reason}` });
          for (const name of Object.keys(outputs)) delete outputs[name];
          continue;
        }
        if (error instanceof OutcomeFound) {
          log.event("business_outcome", { summary: `${error.code}: ${error.message}`, step: current?.id ?? null, code: error.code });
          return done({ status: "business_outcome", ...common(), code: error.code, message: error.message, step: current?.id ?? null });
        }
        if (error instanceof StepFailed) return done(await failureWithEvidence(error));
        if (error instanceof ControlLostError) return done(await failureWithEvidence(new StepFailed("unexpected_error", error.message, "automation to hold control")));
        return done(await failureWithEvidence(new StepFailed("unexpected_error", (error as Error).message ?? String(error), "no internal errors")));
      }
    }
  } finally {
    await helpDesk.close();
    await surface.close();
  }
}
