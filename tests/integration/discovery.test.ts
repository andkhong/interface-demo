// The whole pipeline WITHOUT an API key: a scripted "model" drives the discovery loop,
// the recorder saves a capability, and that capability replays for a DIFFERENT member.

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startMockApp } from "../../apps/mock-cu/server";
import { refFor, ScriptedDecisionModel } from "../../src/agent/llm";
import { discover } from "../../src/agent/loop";
import { replay } from "../../src/replay/engine";

process.env.CU_TELLER_ID ??= "teller01";
process.env.CU_TELLER_PASSWORD ??= "Legacy-Demo-2026!";

let app: { url: string; close: () => Promise<void> };
const runsDir = mkdtempSync(join(tmpdir(), "cua-discovery-test-"));
const capabilitiesDir = mkdtempSync(join(tmpdir(), "cua-capabilities-test-"));

beforeAll(async () => {
  app = await startMockApp(0);
});
afterAll(async () => {
  await app.close();
});

describe("discovery loop + recorder", () => {
  it("records a capability that replays for another member", async () => {
    const model = new ScriptedDecisionModel([
      (obs) => ({ tool: "click", input: { ref: refFor(obs, /^link "Member Inquiry"$/), target_name: "memberInquiryLink", intent: "Open Member Inquiry", risk: "safe" } }),
      (obs) => ({
        tool: "fill",
        input: {
          ref: refFor(obs, /row label "Member #"/),
          target_name: "memberNumberBox",
          intent: "Type member number 100587",
          value: "100587",
          value_source: "goal_input",
          input_name: "memberId",
          input_description: "6-digit member number",
          sensitivity: "pii",
        },
      }),
      (obs) => ({ tool: "click", input: { ref: refFor(obs, /^button "Inquire"$/), target_name: "inquireButton", intent: "Run the inquiry", risk: "safe" } }),
      (obs) => ({ tool: "click", input: { ref: refFor(obs, /^link "100587"$/), target_name: "memberLink", intent: "Open member 100587", risk: "safe" } }),
      (obs) => ({
        tool: "extract",
        input: {
          ref: refFor(obs, /^8,210\.95$/),
          target_name: "savingsBalanceCell",
          intent: "Read the regular savings balance",
          output_name: "savingsBalance",
          output_type: "money",
          output_description: "Current balance of regular savings",
          sensitivity: "none",
        },
      }),
      () => ({
        tool: "finish",
        input: {
          capability_name: "get-savings-balance-scripted",
          title: "Get savings balance",
          description: "Look up a member and return their regular savings balance.",
          success_text: "MEMBER DETAIL",
          summary: "done",
        },
      }),
    ]);

    const result = await discover({
      goal: "Look up member 100587 and read their current savings balance",
      profileId: "cu-legacy",
      baseUrl: app.url,
      startPath: "/cu/main",
      model,
      escalate: false,
      headless: true,
      quiet: true,
      runsDir,
      capabilitiesDir,
    });
    expect(result.status, result.status === "stopped" ? result.reason : "").toBe("saved");
    if (result.status !== "saved") return;

    const cap = result.capability;
    expect(cap.inputs.memberId).toMatchObject({ type: "string", pattern: "^\\d{6}$", sensitivity: "pii" });
    expect(cap.outputs.savingsBalance).toMatchObject({ type: "money" });
    expect(cap.steps.map((s) => s.do.action)).toEqual(["click", "fill", "click", "click", "extract"]);
    expect(cap.targets.memberLink!.locators[0]).toEqual({ by: "role", role: "link", name: "{{inputs.memberId}}" });
    expect(cap.targets.savingsBalanceCell!.locators[0]).toEqual({ by: "tableCell", row: "REGULAR SAVINGS", column: "Current Bal" });
    expect(cap.outcomes.map((o) => o.code)).toContain("MEMBER_NOT_FOUND");
    expect(JSON.stringify(cap)).not.toContain("100587");

    // Evidence of the discovery run must not contain the member number or the password.
    const transcript = readFileSync(join(result.runDir, "transcript.jsonl"), "utf8");
    expect(transcript).not.toContain("100587");
    expect(transcript).not.toContain("PARK, JONATHAN");
    expect(transcript).not.toContain("Legacy-Demo-2026!");

    const replayed = await replay({ capability: cap, inputs: { memberId: "100234" }, baseUrl: app.url, allowDraft: true, headless: true, quiet: true, runsDir });
    expect(replayed.result.status).toBe("success");
    if (replayed.result.status === "success") expect(replayed.result.outputs.savingsBalance).toBe(1523.4);
  });
});
