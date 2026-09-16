// The whole pipeline WITHOUT an API key: a scripted "model" drives the discovery loop,
// the recorder saves a capability, and that capability replays for a DIFFERENT member.

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startMockApp } from "../../apps/mock-cu/server";
import { refFor, ScriptedDecisionModel } from "../../src/agent/llm";
import { discover } from "../../src/agent/loop";
import { replay } from "../../src/replay/engine";
import * as policyModule from "../../src/safety/policy";

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

function balanceModel() {
  return new ScriptedDecisionModel([
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
}

describe("discovery loop + recorder", () => {
  const defaults = () => ({ goal: "Look up member 100587 and read savings balance", profileId: "cu-legacy", baseUrl: app.url,
    startPath: "/cu/main", escalate: false, headless: true, quiet: true, runsDir, capabilitiesDir });

  it("does not persist the free-form goal even when discovery stops immediately", async () => {
    const result = await discover({ ...defaults(), goal: "Look up Alice Example", model: new ScriptedDecisionModel([]), maxSteps: 0 });
    const events = readFileSync(join(result.runDir, "events.jsonl"), "utf8");
    expect(events).not.toContain("Alice Example");
    expect(events).toContain("[not logged: free-form goal]");
  });

  it("redacts first-turn model echoes of declared goal PII before seeing it on screen", async () => {
    const result = await discover({ ...defaults(), goal: "Look up Alice Example", sensitiveValues: ["Alice Example"],
      model: new ScriptedDecisionModel([() => ({ tool: "request_human", input: { reason: "Cannot find Alice Example" } })]) });
    expect(result.status).toBe("stopped");
    if (result.status === "stopped") expect(result.reason).not.toContain("Alice Example");
    for (const file of ["events.jsonl", "transcript.jsonl", "result.json"]) {
      expect(readFileSync(join(result.runDir, file), "utf8")).not.toContain("Alice Example");
    }
  });

  it("registers model-declared PII before logging its decision", async () => {
    const result = await discover({ ...defaults(), maxSteps: 1,
      model: new ScriptedDecisionModel([() => ({ tool: "fill", input: { ref: "main:missing", target_name: "nameBox", intent: "Find Alice Example",
        value: "Alice Example", value_source: "goal_input", input_name: "name", sensitivity: "pii" } })]) });
    for (const file of ["events.jsonl", "transcript.jsonl"]) {
      const text = readFileSync(join(result.runDir, file), "utf8");
      expect(text).not.toContain("Alice Example");
      expect(text).toContain("[REDACTED:pii]");
    }
  });

  it("does not record a policy-forbidden extraction during discovery", async () => {
    const load = policyModule.loadPolicy;
    const policy = vi.spyOn(policyModule, "loadPolicy").mockImplementation((id, baseUrl) => {
      const p = load(id, baseUrl);
      return { ...p, allowedActions: p.allowedActions.filter((a) => a !== "extract") };
    });
    try {
      const result = await discover({ ...defaults(), model: balanceModel(), maxSteps: 5 });
      expect(result.status).toBe("stopped");
      const events = readFileSync(join(result.runDir, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
      expect(events.some((e) => e.type === "policy_checked" && e.action === "extract" && !e.decision.allowed)).toBe(true);
      expect(events.some((e) => e.type === "extracted")).toBe(false);
    } finally {
      policy.mockRestore();
    }
  });

  it("records a capability that replays for another member", async () => {
    const model = balanceModel();

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
