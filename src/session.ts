// A Session = the surface (eyes & hands) + the rules.
//
// Every automated action (including extraction) goes through act() or read(), which always:
//   1. checks automation still holds the control turn (a human may have taken over)
//   2. checks the policy (allowlist + irreversible detection)
//   3. asks a human to approve irreversible actions
//   4. fills in secrets at the last moment (they are never logged)
//   5. performs the action and logs it

import type { Profile } from "./capability/profile";
import { fillTemplate, usesSecret } from "./capability/template";
import type { RunLogger } from "./evidence/logger";
import type { ControlTurn } from "./handoff/control";
import type { HelpDesk, HelpRequestInput, HelpResolution, HumanAction } from "./handoff/helpdesk";
import { checkAction, type ActionType, type Policy } from "./safety/policy";
import type { ElementRef, FindResult, Surface } from "./surface/types";
import type { Target } from "./capability/schema";

export type ActFailureCategory = "policy_blocked" | "approval_required" | "approval_rejected" | "nobody_responded";

export type ActResult =
  | { ok: true; risk: "safe" | "irreversible" }
  | { ok: false; category: ActFailureCategory; message: string };

export interface ActRequest {
  action: Exclude<ActionType, "extract">;
  element: ElementRef;
  /** For fill/select/press. May contain {{secrets.x}}, which is filled in here. */
  value?: string;
  declaredRisk?: "safe" | "irreversible";
  /** Human-readable name of the target, for logs and approval requests. */
  label: string;
  step: { id: string; intent: string } | null;
}

export interface SessionDeps {
  surface: Surface;
  policy: Policy;
  profile: Profile;
  control: ControlTurn;
  log: RunLogger;
  helpDesk: HelpDesk;
  secrets: Record<string, string>;
  autoConfirmRisky: boolean;
  subject: string;
  mode: "discovery" | "replay";
}

export const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class Session {
  /** The control turn automation currently holds. */
  private turn: number;
  private helpCount = 0;
  private readonly humanActions: HumanAction[] = [];

  constructor(private readonly d: SessionDeps) {
    this.turn = d.control.get().turn;
    d.control.onChange((state, previous) => {
      d.log.event("control_changed", {
        summary: `${previous.controller} -> ${state.controller} (turn ${state.turn}): ${state.reason}`,
        from: previous.controller,
        to: state.controller,
        turn: state.turn,
        reason: state.reason,
      });
    });
    d.surface.onHumanAction((action) => {
      // Automation's own clicks fire the same page events; only keep what happens under human control.
      if (d.control.get().controller !== "human") return;
      this.humanActions.push(action);
      const { type: kind, ...rest } = action;
      d.log.event("human_action", {
        summary: `${kind} ${action.role ?? ""} "${action.name}"${action.detail ? ` (${action.detail})` : ""}`,
        kind,
        ...rest,
      });
    });
  }

  get surface(): Surface {
    return this.d.surface;
  }

  get recordedHumanActions(): readonly HumanAction[] {
    return this.humanActions;
  }

  private async authorize(req: Omit<ActRequest, "action"> & { action: ActionType }): Promise<ActResult> {
    const { surface, policy, control, log } = this.d;
    control.assertAutomationMayAct(this.turn);

    const info = await surface.elementInfo(req.element);
    const decision = checkAction(policy, {
      action: req.action,
      pageUrl: req.element.frameUrl,
      targetName: info?.name ?? req.label,
      linkUrl: info?.href,
      declaredRisk: req.declaredRisk,
    });
    log.event("policy_checked", {
      summary: decision.allowed
        ? `${req.action} "${req.label}" allowed (${decision.risk})`
        : `${req.action} "${req.label}" BLOCKED: ${decision.reason}`,
      step: req.step?.id ?? null,
      action: req.action,
      target: req.label,
      decision,
    });
    if (!decision.allowed) return { ok: false, category: "policy_blocked", message: decision.reason };

    if (decision.risk === "irreversible") {
      if (this.d.autoConfirmRisky) {
        log.event("irreversible_auto_confirmed", {
          summary: `WARNING: AUTO_CONFIRM_RISKY=true - "${req.label}" runs WITHOUT human approval (local demo setting)`,
          step: req.step?.id ?? null,
        });
      } else {
        const resolution = await this.askHuman({
          kind: "approval",
          reasonCode: "IRREVERSIBLE_ACTION",
          reason: `Approve: ${req.action} "${info?.name ?? req.label}". Why this needs a person: ${decision.reasons.join("; ")}`,
          step: req.step,
          stepIds: [],
          choices: ["approve", "reject"],
        });
        if (resolution.choice === "unavailable") {
          return { ok: false, category: "approval_required", message: `"${req.label}" is irreversible and needs human approval, but escalation is off` };
        }
        if (resolution.choice === "timeout") {
          return { ok: false, category: "nobody_responded", message: "nobody approved the irreversible step before the deadline" };
        }
        if (resolution.choice !== "approve") {
          return { ok: false, category: "approval_rejected", message: `operator rejected "${req.label}"${resolution.note ? `: ${resolution.note}` : ""}` };
        }
        control.assertAutomationMayAct(this.turn);
      }
    }

    return { ok: true, risk: decision.risk };
  }

  /** Extraction obeys the same action allowlist and control fence as writes. */
  async read(req: Omit<ActRequest, "action" | "value">): Promise<{ ok: true; text: string } | Extract<ActResult, { ok: false }>> {
    const result = await this.authorize({ ...req, action: "extract" });
    if (!result.ok) return result;
    this.d.control.assertAutomationMayAct(this.turn);
    return { ok: true, text: await this.d.surface.readText(req.element) };
  }

  async act(req: ActRequest): Promise<ActResult> {
    const result = await this.authorize(req);
    if (!result.ok) return result;
    const { surface, control, log } = this.d;
    control.assertAutomationMayAct(this.turn);
    const value = req.value === undefined ? undefined : fillTemplate(req.value, { inputs: {}, secrets: this.d.secrets });
    switch (req.action) {
      case "click":
        await surface.click(req.element);
        break;
      case "fill":
        await surface.fill(req.element, value ?? "");
        break;
      case "select":
        await surface.select(req.element, value ?? "");
        break;
      case "press":
        await surface.press(req.element, value ?? "Enter");
        break;
    }
    const shownValue = req.value === undefined ? undefined : usesSecret(req.value) ? "[secret]" : req.value;
    log.event("acted", {
      summary: `${req.action} "${req.label}"${shownValue !== undefined ? ` = ${shownValue}` : ""}`,
      step: req.step?.id ?? null,
      action: req.action,
      target: req.label,
      value: shownValue,
      risk: result.risk,
    });
    return result;
  }

  /** Wait (briefly) for a target to appear. Used for sign-on and simple waits. */
  async waitForTarget(target: Target, timeoutMs: number): Promise<Extract<FindResult, { status: "found" }> | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const result = await this.d.surface.find(target);
      if (result.status === "found") return result;
      await delay(250);
    }
    return null;
  }

  /** Sign on using the app profile's steps and stored secrets. The AI never sees these values. */
  async signOn(): Promise<void> {
    const { surface, profile, log } = this.d;
    for (const step of profile.signOn.steps) {
      const found = await this.waitForTarget(step.target, 10_000);
      if (!found) throw new Error(`sign-on: could not find ${step.target.description}`);
      const result = await this.act({
        action: step.action,
        element: found.element,
        value: step.action === "fill" ? step.value : undefined,
        label: step.target.description,
        step: null,
      });
      if (!result.ok) throw new Error(`sign-on was blocked: ${result.message}`);
    }
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (await surface.findText(profile.signOn.doneWhenTextVisible)) {
        log.event("signed_on", { summary: "signed on with stored teller credentials" });
        return;
      }
      await delay(250);
    }
    throw new Error("sign-on did not complete (wrong credentials?)");
  }

  /** Remember sensitive values currently on screen so they are redacted from all evidence. */
  async learnSensitiveValues(): Promise<void> {
    for (const value of await this.d.surface.sensitiveValues(this.d.profile.sensitiveFields)) {
      this.d.log.redactor.addSensitive(value);
    }
  }

  /** Pause, ask a human, and wait. Takes a masked screenshot for context. */
  async askHuman(
    input: Pick<HelpRequestInput, "kind" | "reasonCode" | "reason" | "step" | "stepIds" | "choices">,
  ): Promise<HelpResolution> {
    const { surface, profile, log, helpDesk, control } = this.d;
    await this.learnSensitiveValues();
    const screenshot = `screenshots/help-${++this.helpCount}.png`;
    await surface.screenshot(log.path(screenshot), profile.sensitiveFields);
    const observed = await surface.location();
    const humanActionsBefore = this.humanActions.length;

    log.event("help_requested", { summary: `${input.reasonCode}: ${input.reason}`, ...input, observed, screenshot });
    // Help requests are persisted and shown on the console, so they are redacted like all evidence.
    // The operator still sees full detail in the live browser window they take over.
    const resolution = await helpDesk.request({
      ...input,
      reason: log.redactor.text(input.reason),
      mode: this.d.mode,
      subject: log.redactor.text(this.d.subject),
      runId: log.runId,
      observed: log.redactor.value(observed),
      screenshotFile: log.path(screenshot),
    });
    resolution.humanActions = this.humanActions.slice(humanActionsBefore);
    helpDesk.recordHumanActions(resolution);
    log.event("help_resolved", {
      summary: `operator chose "${resolution.choice}"${resolution.note ? `: ${resolution.note}` : ""} (${resolution.humanActions.length} human actions)`,
      choice: resolution.choice,
      note: resolution.note,
      stepId: resolution.stepId,
      humanActions: resolution.humanActions.length,
    });

    const state = control.get();
    if (state.controller === "automation") this.turn = state.turn;
    return resolution;
  }
}
