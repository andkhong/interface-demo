// Replay against the real fake app in a real (headless) browser, for every error case.
// No AI and no API key are needed.

import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startMockApp } from "../../apps/mock-cu/server";
import { replay, type ReplayOptions } from "../../src/replay/engine";
import { getSavingsBalanceFixture } from "../fixtures/get-savings-balance";
import * as policyModule from "../../src/safety/policy";
import { loadCapability } from "../../src/capability/store";

process.env.CU_TELLER_ID ??= "teller01";
process.env.CU_TELLER_PASSWORD ??= "Legacy-Demo-2026!";

let app: { url: string; close: () => Promise<void> };
const runsDir = mkdtempSync(join(tmpdir(), "cua-replay-test-"));

beforeAll(async () => {
  app = await startMockApp(0);
});
afterAll(async () => {
  await app.close();
});

function run(overrides: Partial<ReplayOptions> = {}) {
  return replay({
    capability: getSavingsBalanceFixture(),
    inputs: { memberId: "100234" },
    baseUrl: app.url,
    allowDraft: true,
    headless: true,
    quiet: true,
    runsDir,
    ...overrides,
  });
}

function allFilesText(dir: string): string {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .map((f) => join(dir, f))
    .filter((p) => statSync(p).isFile() && !p.endsWith(".png"))
    .map((p) => readFileSync(p, "utf8"))
    .join("\n");
}

describe("replay", () => {
  it("enforces the extraction allowlist on the actual saved capability", async () => {
    const load = policyModule.loadPolicy;
    const policy = vi.spyOn(policyModule, "loadPolicy").mockImplementation((id, baseUrl) => {
      const p = load(id, baseUrl);
      return { ...p, allowedActions: p.allowedActions.filter((a) => a !== "extract") };
    });
    try {
      const { result, runDir } = await run({ capability: loadCapability("cu-legacy.get-savings-balance@1.0.0").capability, inputs: { memberNumber: "100234" } });
      expect(result).toMatchObject({ status: "failure", category: "policy_blocked", step: { id: "extractSavingsCurrentBalCell" } });
      expect(allFilesText(runDir)).not.toContain('"type":"extracted"');
    } finally {
      policy.mockRestore();
    }
  });

  it("succeeds and returns the declared output", async () => {
    const { result } = await run();
    expect(result.status).toBe("success");
    if (result.status === "success") expect(result.outputs.savingsBalance).toBe(1523.4);
    expect(result.recoveries).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it("reports 'member not found' as a business outcome, not a failure", async () => {
    const { result } = await run({ inputs: { memberId: "999999" } });
    expect(result).toMatchObject({ status: "business_outcome", code: "MEMBER_NOT_FOUND", step: "search" });
  });

  it("rejects bad input before opening the app", async () => {
    const { result } = await run({ inputs: { memberId: "12ab" } });
    expect(result).toMatchObject({ status: "failure", category: "invalid_input", observed: null });
  });

  it("refuses to run a draft unless allowed", async () => {
    const { result } = await run({ allowDraft: false });
    expect(result).toMatchObject({ status: "failure", category: "not_approved" });
  });

  it("recovers from a maintenance notice, a session timeout and a slow page", async () => {
    const { result } = await run({ faults: ["interstitial", "session_timeout", "slow"] });
    expect(result.status).toBe("success");
    const conditions = result.recoveries.map((r) => r.condition);
    expect(conditions).toContain("maintenance_notice");
    expect(conditions).toContain("session_expired");
    expect(conditions).toContain("slow_response");
  });

  it("stops on an application error with a screenshot and page snapshots", async () => {
    const { result, runDir } = await run({ faults: ["app_error"] });
    expect(result).toMatchObject({ status: "failure", category: "app_error", retryable: true, step: { id: "openMember" } });
    if (result.status !== "failure") return;
    expect(result.evidence.screenshot).toBe("screenshots/failure.png");
    expect(result.evidence.pages.length).toBeGreaterThan(0);
    expect(result.observed?.visibleText).toContain("SYSTEM ERROR");
    expect(statSync(join(runDir, "screenshots/failure.png")).size).toBeGreaterThan(1000);
  });

  it("fails clearly on an unknown screen when escalation is off", async () => {
    const { result } = await run({ faults: ["unknown_dialog"] });
    expect(result).toMatchObject({ status: "failure", category: "check_failed", step: { id: "openMember" } });
    if (result.status === "failure") expect(result.observed?.visibleText).toContain("MEMBER ALERT");
  });

  it("never guesses when a locator matches more than one control", async () => {
    const cap = getSavingsBalanceFixture();
    cap.targets.savingsBalanceCell!.locators = [{ by: "css", selector: "td" }];
    const { result } = await run({ capability: cap });
    expect(result).toMatchObject({ status: "failure", category: "target_ambiguous" });
  });

  it("uses a fallback locator but reports it as degraded", async () => {
    const cap = getSavingsBalanceFixture();
    cap.targets.memberInquiryLink!.locators.unshift({ by: "role", role: "link", name: "Member Lookup (renamed)" });
    const { result } = await run({ capability: cap });
    expect(result.status, JSON.stringify(result)).toBe("success");
    expect(result.warnings).toMatchObject([{ step: "openInquiry", kind: "locator_degraded" }]);
  });

  it("blocks actions outside the policy allowlist", async () => {
    const cap = getSavingsBalanceFixture();
    cap.targets.memberInquiryLink!.locators = [{ by: "role", role: "link", name: "System Admin" }];
    const { result } = await run({ capability: cap });
    expect(result).toMatchObject({ status: "failure", category: "policy_blocked", step: { id: "openInquiry" } });
  });

  it("does not write sensitive data into evidence", async () => {
    const { runDir } = await run({ faults: ["app_error"] });
    const { runDir: okDir } = await run();
    for (const dir of [runDir, okDir]) {
      const text = allFilesText(dir);
      for (const secret of ["900-55-1234", "DELGADO", "04/17/1968", "100234", "Legacy-Demo-2026!", "555-0142"]) {
        expect(text, `${secret} leaked into ${dir}`).not.toContain(secret);
      }
    }
  });
});
