// Asking a human for help.
//
// Automation calls helpDesk.request(...) and WAITS. The request carries enough context to act
// on: what was running, which step, why it stopped, where the browser is, and a masked screenshot.
// The implementation (operator-server.ts) moves control to the human and back.

export type HelpChoice =
  | "approve" // allow an irreversible step
  | "reject" // refuse an irreversible step
  | "resume" // (discovery) human fixed things; let the AI continue
  | "retry_step" // (replay) try the current step again
  | "continue_from" // (replay) human did some steps; continue from step X (checked first)
  | "mark_done" // (replay) human finished the flow; read the outputs and check success
  | "abort";

import type { HumanAction } from "../surface/types";

export type { HumanAction };

export interface HelpRequestInput {
  kind: "approval" | "stuck";
  reasonCode: string; // e.g. IRREVERSIBLE_ACTION, TARGET_NOT_FOUND, CHECK_FAILED, AGENT_REQUESTED, NO_PROGRESS
  reason: string;
  mode: "discovery" | "replay";
  subject: string; // capability id@version, or the discovery goal
  runId: string;
  step: { id: string; intent: string } | null;
  stepIds: string[];
  observed: { url: string; frames: { name: string; url: string }[] };
  screenshotFile: string;
  choices: HelpChoice[];
}

export interface HelpRequest extends HelpRequestInput {
  id: string;
  createdAt: string;
  deadline: string;
  status: "open" | "claimed" | "resolved";
  resolution?: HelpResolution;
}

export interface HelpResolution {
  choice: HelpChoice | "unavailable" | "timeout";
  note?: string;
  stepId?: string;
  humanActions: HumanAction[];
}

export interface HelpDesk {
  request(input: HelpRequestInput): Promise<HelpResolution>;
  close(): Promise<void>;
}

/** Used when escalation is turned off: nobody is available, so automation must stop. */
export const noHelpDesk: HelpDesk = {
  async request() {
    return { choice: "unavailable", humanActions: [] };
  },
  async close() {},
};
