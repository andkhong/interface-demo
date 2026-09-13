// Discovery: the AI works out how to reach a goal on the live app, and the recorder turns
// the successful run into a capability file.
//
//   observe (screen text + masked screenshot)
//     -> decide (one tool call from the model)
//     -> act (through the Session: control turn, policy, approval for irreversible clicks)
//     -> record (verified locators) -> repeat
//
// Stops on: finish, request_human without an operator, max turns, no progress, repeated failures.

import { join } from "node:path";
import { lintCapability } from "../capability/lint";
import { loadProfile, loadSecrets, type Profile } from "../capability/profile";
import type { Capability } from "../capability/schema";
import { renderCapability } from "../capability/show";
import { loadCapability, saveCapability } from "../capability/store";
import { RunLogger } from "../evidence/logger";
import { ControlTurn } from "../handoff/control";
import { noHelpDesk, type HelpDesk, type HelpResolution } from "../handoff/helpdesk";
import { OperatorConsole } from "../handoff/operator-server";
import { buildVerifiedLocators, describeTarget, Recorder, type RecordedTool } from "../recorder/recorder";
import { loadPolicy } from "../safety/policy";
import { Redactor } from "../safety/redact";
import { delay, Session } from "../session";
import { WebSurface } from "../surface/web/browser";
import type { DecisionModel } from "./llm";
import { missingFields } from "./tools";

export interface DiscoverOptions {
  goal: string;
  profileId: string;
  baseUrl: string;
  startPath: string;
  model: DecisionModel;
  maxSteps?: number;
  /** Ask a human through the operator console when stuck or approval is needed (default true). */
  escalate?: boolean;
  operatorPort?: number;
  helpDeadlineMs?: number;
  headless?: boolean;
  autoConfirmRisky?: boolean;
  quiet?: boolean;
  runsDir?: string;
  /** Where to save the capability (default: capabilities/). */
  capabilitiesDir?: string;
  /** Name for the saved capability, e.g. "get-savings-balance" (default: the model's suggestion). */
  capabilityName?: string;
  hooks?: { onStarted?: (info: { surface: WebSurface; operatorUrl: string | null }) => void };
}

export type DiscoverResult =
  | { status: "saved"; capability: Capability; capabilityPath: string; runDir: string; runId: string; turns: number }
  | { status: "stopped"; reason: string; runDir: string; runId: string; turns: number };

const ACTION_TOOLS: RecordedTool[] = ["click", "fill", "select", "press", "extract"];

function humanNote(resolution: HelpResolution): string {
  const actions = resolution.humanActions
    .filter((a) => a.type !== "page")
    .map((a) => `${a.type} ${a.role ?? ""} "${a.name}"${a.detail ? ` (${a.detail})` : ""}`);
  return `A human operator took control and did: ${actions.join("; ") || "nothing that was recorded"}.${resolution.note ? ` Operator note: ${resolution.note}.` : ""} Continue from the current screen.`;
}

export async function discover(opts: DiscoverOptions): Promise<DiscoverResult> {
  const maxSteps = opts.maxSteps ?? 30;
  const redactor = new Redactor();
  const log = new RunLogger("discovery", redactor, { rootDir: opts.runsDir, quiet: opts.quiet });
  let turns = 0;

  const stop = (reason: string): DiscoverResult => {
    log.writeJson("result.json", { status: "stopped", reason, turns });
    log.event("run_finished", { summary: `stopped: ${reason}`, status: "stopped", reason });
    return { status: "stopped", reason, runDir: log.dir, runId: log.runId, turns };
  };

  log.event("run_started", { summary: `discovery with ${opts.model.name}`, goal: opts.goal, model: opts.model.name, profile: opts.profileId, maxSteps });

  let profile: Profile;
  let secrets: Record<string, string>;
  let policy;
  try {
    profile = loadProfile(opts.profileId);
    secrets = loadSecrets(profile);
    policy = loadPolicy(opts.profileId, opts.baseUrl);
  } catch (error) {
    return stop((error as Error).message);
  }
  for (const value of Object.values(secrets)) redactor.addSensitive(value, "secret");

  const surface = await WebSurface.launch({
    headless: opts.headless ?? false,
    policy,
    onBlocked: (url, reason) => log.event("navigation_blocked", { summary: reason, url }),
  });
  const control = new ControlTurn();
  const helpDesk: HelpDesk =
    opts.escalate === false
      ? noHelpDesk
      : await OperatorConsole.start({ port: opts.operatorPort ?? 4100, control, log, deadlineMs: opts.helpDeadlineMs });
  const session = new Session({
    surface,
    policy,
    profile,
    control,
    log,
    helpDesk,
    secrets,
    autoConfirmRisky: !!opts.autoConfirmRisky,
    subject: `discovery: ${opts.goal}`,
    mode: "discovery",
  });
  opts.hooks?.onStarted?.({ surface, operatorUrl: helpDesk instanceof OperatorConsole ? helpDesk.url : null });

  const recorder = new Recorder();
  const history: string[] = [];

  try {
    await surface.open(opts.baseUrl + opts.startPath);
    await session.waitForTarget({ description: "page", locators: [{ by: "css", selector: "body" }] }, 5000);
    if (await surface.findText(profile.signOn.whenTextVisible)) await session.signOn();
    await delay(500);

    let lastStateKey = "";
    let unchangedTurns = 0;
    let failuresInRow = 0;
    let lastWasRead = false;

    while (turns < maxSteps) {
      turns++;
      await session.learnSensitiveValues();
      const observation = await surface.observe({ screenshot: true, sensitiveFields: profile.sensitiveFields });
      recorder.noteObservation(observation);
      unchangedTurns = observation.stateKey === lastStateKey && !lastWasRead ? unchangedTurns + 1 : 0;
      lastStateKey = observation.stateKey;
      if (observation.screenshotBase64) {
        log.writeBinary(`screenshots/turn-${String(turns).padStart(2, "0")}.jpg`, Buffer.from(observation.screenshotBase64, "base64"));
      }
      log.event("observed", {
        summary: `turn ${turns}: ${observation.frames.map((f) => `${f.name}=${f.url.replace(opts.baseUrl, "")}`).join(" ")}`,
        turn: turns,
        stateKey: observation.stateKey,
        frames: observation.frames,
      });

      // ----- stuck? -----
      if (unchangedTurns >= 3 || failuresInRow >= 3) {
        const reasonCode = unchangedTurns >= 3 ? "NO_PROGRESS" : "REPEATED_FAILURES";
        const resolution = await session.askHuman({
          kind: "stuck",
          reasonCode,
          reason: reasonCode === "NO_PROGRESS" ? "the screen has not changed for 3 turns" : "3 actions in a row failed",
          step: null,
          stepIds: [],
          choices: ["resume", "abort"],
        });
        if (resolution.choice !== "resume") return stop(`stuck (${reasonCode}); operator decision: ${resolution.choice}`);
        history.push(`${turns}. (stuck: ${reasonCode}) ${humanNote(resolution)}`);
        recorder.addNote(`A human operator helped at turn ${turns} (${reasonCode}). Their actions are not steps in this capability.`);
        unchangedTurns = 0;
        failuresInRow = 0;
        continue;
      }

      // ----- decide -----
      const started = Date.now();
      const decision = await opts.model.decide({ goal: opts.goal, history, observation });
      const input = decision.input;
      log.event("ai_decided", {
        summary: `${decision.tool}: ${String(input.intent ?? input.reason ?? input.summary ?? "")}`,
        turn: turns,
        tool: decision.tool,
        input,
        text: decision.text,
        model: decision.model,
        usage: decision.usage,
        ms: Date.now() - started,
      });
      log.append("transcript.jsonl", {
        turn: turns,
        prompt: { goal: opts.goal, history: [...history], screen: observation.text },
        response: { tool: decision.tool, input, text: decision.text, model: decision.model, usage: decision.usage },
      });
      lastWasRead = decision.tool === "extract";
      const missing = missingFields(decision.tool, input);
      if (missing.length > 0) {
        history.push(`${turns}. ${decision.tool} REJECTED: missing required field(s): ${missing.join(", ")}`);
        failuresInRow++;
        continue;
      }

      // ----- finish -----
      if (decision.tool === "finish") {
        const successText = String(input.success_text ?? "");
        if (!successText || !(await surface.findText(successText))) {
          history.push(`${turns}. finish REJECTED: success_text "${successText}" is not visible on the current screen`);
          failuresInRow++;
          continue;
        }
        if (recorder.count === 0) {
          history.push(`${turns}. finish REJECTED: no actions have been recorded yet`);
          failuresInRow++;
          continue;
        }
        const capability = recorder.compile({
          profile,
          finish: {
            capabilityName: opts.capabilityName ?? String(input.capability_name ?? "capability"),
            title: String(input.title ?? ""),
            description: String(input.description ?? ""),
            successText,
          },
          runId: log.runId,
          model: decision.model,
          startPath: opts.startPath,
        });
        const problems = lintCapability(capability, redactor.knownValues());
        if (problems.length > 0) {
          log.event("lint_failed", { summary: `capability NOT saved: ${problems.length} sensitive-data problem(s)`, problems });
          return stop("the recorded capability still contained sensitive data, so it was not saved (see lint_failed)");
        }
        const path = saveCapability(
          capability,
          opts.capabilitiesDir ? join(opts.capabilitiesDir, capability.id, `${capability.version}.json`) : undefined,
        );
        const saved = loadCapability(path).capability;
        log.writeJson("capability.json", saved);
        log.writeText("capability.md", renderCapability(saved));
        log.event("capability_saved", { summary: `${saved.id}@${saved.version} -> ${path}`, id: saved.id, version: saved.version, path, steps: saved.steps.length });
        log.writeJson("result.json", { status: "saved", capability: `${saved.id}@${saved.version}`, path, turns });
        log.event("run_finished", { summary: `saved ${saved.id}@${saved.version}`, status: "saved" });
        return { status: "saved", capability: saved, capabilityPath: path, runDir: log.dir, runId: log.runId, turns };
      }

      // ----- ask a human -----
      if (decision.tool === "request_human") {
        const reason = String(input.reason ?? "");
        const resolution = await session.askHuman({ kind: "stuck", reasonCode: "AGENT_REQUESTED", reason, step: null, stepIds: [], choices: ["resume", "abort"] });
        if (resolution.choice !== "resume") return stop(`the agent asked for help ("${reason}"); operator decision: ${resolution.choice}`);
        history.push(`${turns}. asked for help: ${reason}. ${humanNote(resolution)}`);
        recorder.addNote(`A human operator helped at turn ${turns} ("${reason}"). Their actions are not steps in this capability.`);
        continue;
      }

      // ----- act -----
      const tool = decision.tool as RecordedTool;
      if (!ACTION_TOOLS.includes(tool)) {
        history.push(`${turns}. unknown tool "${decision.tool}"`);
        failuresInRow++;
        continue;
      }
      const ref = String(input.ref ?? "");
      const targetName = String(input.target_name ?? "target");
      const intent = String(input.intent ?? tool);
      const info = await surface.describeRef(ref);
      if (!info) {
        history.push(`${turns}. ${tool} [${ref}] FAILED: there is no element [${ref}] on the current screen`);
        failuresInRow++;
        continue;
      }
      const locators = await buildVerifiedLocators(surface, info);
      if (locators.length === 0) {
        history.push(`${turns}. ${tool} [${ref}] FAILED: no stable way to identify this element (no name, row label, column header or attribute); choose another element`);
        failuresInRow++;
        continue;
      }
      const element = { frame: info.frame, frameUrl: info.frameUrl, path: info.path };
      const sensitivity = input.sensitivity === "pii" ? "pii" : "none";

      if (tool === "extract") {
        const text = await surface.readText(element);
        const type = input.output_type === "money" ? "money" : "string";
        if (sensitivity === "pii") redactor.addSensitive(text);
        if (type === "money" && !/^-?\$?[\d,]+(\.\d{1,2})?$/.test(text)) {
          history.push(`${turns}. extract FAILED: "${text}" is not a money value; point at the cell holding the amount`);
          failuresInRow++;
          continue;
        }
        const outputName = String(input.output_name ?? "value");
        recorder.add({
          tool,
          targetName,
          intent,
          element: info,
          locators,
          risk: "safe",
          output: { name: outputName, type, description: String(input.output_description ?? ""), sensitivity },
        });
        log.event("extracted", {
          summary: `read ${outputName} (${type}) using ${locators.map((l) => l.by).join(", ")}`,
          turn: turns,
          output: outputName,
          value: sensitivity === "none" ? text : "[not logged]",
          locators,
        });
        history.push(`${turns}. extract ${outputName} from ${targetName} - done (value "${text}")`);
        failuresInRow = 0;
        continue;
      }

      const value = tool === "fill" ? String(input.value ?? "") : tool === "select" ? String(input.option ?? "") : tool === "press" ? String(input.key ?? "Enter") : undefined;
      const fromGoal = (tool === "fill" || tool === "select") && input.value_source === "goal_input" && String(input.input_name ?? "") !== "";
      if (fromGoal && sensitivity === "pii" && value) redactor.addSensitive(value);

      let result;
      try {
        result = await session.act({
          action: tool,
          element,
          value,
          declaredRisk: tool === "click" && input.risk === "irreversible" ? "irreversible" : "safe",
          label: `${targetName} (${describeTarget(info)})`,
          step: { id: `turn${turns}`, intent },
        });
      } catch (error) {
        history.push(`${turns}. ${tool} ${targetName} FAILED: ${(error as Error).message.split("\n")[0]}`);
        failuresInRow++;
        continue;
      }
      if (!result.ok) {
        history.push(`${turns}. ${tool} ${targetName} NOT DONE - ${result.category}: ${result.message}`);
        if (result.category !== "policy_blocked") return stop(result.message);
        failuresInRow++;
        continue;
      }
      recorder.add({
        tool,
        targetName,
        intent,
        element: info,
        locators,
        risk: result.risk,
        value,
        input: fromGoal ? { name: String(input.input_name), description: String(input.input_description ?? ""), sensitivity } : undefined,
      });
      log.event("recorded", { summary: `${tool} ${targetName} with locators: ${locators.map((l) => l.by).join(", ")}`, turn: turns, locators });
      history.push(`${turns}. ${tool} ${targetName}${value !== undefined ? ` = "${value}"` : ""} - done`);
      failuresInRow = 0;
      await delay(600);
    }
    return stop(`reached the maximum of ${maxSteps} turns`);
  } catch (error) {
    return stop(`unexpected error: ${(error as Error).message}`);
  } finally {
    await helpDesk.close();
    await surface.close();
  }
}
