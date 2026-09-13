// The result contract a calling agent receives from a replay.
//
//   success           -> done; here are the outputs
//   business_outcome  -> a legitimate answer the caller must act on (e.g. MEMBER_NOT_FOUND). NOT an error.
//   failure           -> stopped; which step, what we expected, what we saw, and evidence files
//
// Small problems replay fixed by itself (maintenance notice, slow page, signed back on) are not
// results. They are listed in `recoveries` so nothing is hidden from the caller.

export type FailureCategory =
  | "invalid_input" // inputs don't match the capability's schema (checked before opening the app)
  | "not_approved" // capability is a draft, or changed since it was approved
  | "target_not_found" // a control could not be found
  | "target_ambiguous" // a locator matched more than one control; we never guess
  | "check_failed" // an action ran but the expected screen did not appear
  | "app_error" // the application showed a known error screen
  | "session_lost" // signed out and could not safely sign on and restart
  | "too_many_recoveries" // the same hiccup kept coming back
  | "policy_blocked" // the action is outside the allowlist
  | "approval_required" // an irreversible step needs a human, and escalation is off
  | "approval_rejected" // a human said no to an irreversible step
  | "nobody_responded" // help was requested but nobody answered before the deadline
  | "aborted_by_operator"
  | "bad_output" // a value was read but does not match the declared output type
  | "unexpected_error"; // a bug or an environment problem (e.g. missing secret)

export interface Recovery {
  step: string | null;
  condition: string;
  action: string;
}

export interface Warning {
  step: string;
  kind: "locator_degraded";
  detail: string;
}

export interface HumanHelp {
  requestId: string;
  reasonCode: string;
  choice: string;
  humanActions: number;
}

interface Common {
  capability: { id: string; version: string; contentHash: string };
  runId: string;
  recoveries: Recovery[];
  warnings: Warning[];
  humanHelp: HumanHelp[];
  durationMs: number;
}

export type ReplayResult =
  | (Common & { status: "success"; outputs: Record<string, string | number> })
  | (Common & { status: "business_outcome"; code: string; message: string; step: string | null })
  | (Common & {
      status: "failure";
      category: FailureCategory;
      retryable: boolean;
      message: string;
      step: { id: string; intent: string } | null;
      expected: string;
      observed: { url: string; frames: { name: string; url: string }[]; visibleText: string } | null;
      evidence: { screenshot: string | null; pages: string[] };
    });
