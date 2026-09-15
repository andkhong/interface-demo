// Human handoff on the SAME live session:
// replay gets stuck -> help request -> operator takes control -> "human" clicks in the same
// browser page -> operator hands back -> replay verifies the screen and finishes.

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startMockApp } from "../../apps/mock-cu/server";
import { replay } from "../../src/replay/engine";
import type { WebSurface } from "../../src/surface/web/browser";
import { getSavingsBalanceFixture } from "../fixtures/get-savings-balance";

process.env.CU_TELLER_ID ??= "teller01";
process.env.CU_TELLER_PASSWORD ??= "Legacy-Demo-2026!";

let app: { url: string; close: () => Promise<void> };
const runsDir = mkdtempSync(join(tmpdir(), "cua-handoff-test-"));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  app = await startMockApp(0);
});
afterAll(async () => {
  await app.close();
});

async function waitForOpenRequest(consoleUrl: string) {
  // The stuck step waits for its timeout (10s) plus one extra wait (10s) before asking for help.
  for (let i = 0; i < 600; i++) {
    const state = await (await fetch(`${consoleUrl}/api/state`)).json();
    const open = state.requests.find((r: { status: string }) => r.status === "open");
    if (open) return { state, request: open };
    await wait(100);
  }
  throw new Error("no help request appeared");
}

describe("human handoff", () => {
  it("lets a human take over the live session and hands control back", async () => {
    let surface: WebSurface | undefined;
    let consoleUrl: string | null = null;

    const running = replay({
      capability: getSavingsBalanceFixture(),
      inputs: { memberId: "100234" },
      baseUrl: app.url,
      allowDraft: true,
      escalate: true,
      operatorPort: 0,
      headless: true,
      quiet: true,
      runsDir,
      faults: ["unknown_dialog"],
      hooks: {
        onStarted: (info) => {
          surface = info.surface;
          consoleUrl = info.operatorUrl;
        },
      },
    });

    while (!consoleUrl) await wait(50);
    const { state, request } = await waitForOpenRequest(consoleUrl);
    expect(state.control.controller).toBe("nobody");
    expect(request).toMatchObject({ kind: "stuck", reasonCode: "CHECK_FAILED", step: { id: "openMember" } });

    // Operator takes control.
    await fetch(`${consoleUrl}/api/requests/${request.id}/claim`, { method: "POST" });
    const claimed = await (await fetch(`${consoleUrl}/api/state`)).json();
    expect(claimed.control.controller).toBe("human");

    // The "human" acknowledges the alert in the same browser page the automation was using.
    const main = surface!.page.frame({ name: "main" })!;
    await main.getByRole("button", { name: "Acknowledge" }).click();
    await main.getByText("MEMBER DETAIL").waitFor();

    // Hand back: continue from the step after the one that got stuck (replay checks it first).
    const resolve = await fetch(`${consoleUrl}/api/requests/${request.id}/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ choice: "continue_from", stepId: "readBalance" }),
    });
    expect(resolve.ok).toBe(true);

    const { result, runDir } = await running;
    expect(result.status).toBe("success");
    if (result.status === "success") expect(result.outputs.savingsBalance).toBe(1523.4);
    expect(result.humanHelp).toMatchObject([{ reasonCode: "CHECK_FAILED", choice: "continue_from" }]);

    const events = readFileSync(join(runDir, "events.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    const controlChanges = events.filter((e) => e.type === "control_changed").map((e) => e.to);
    expect(controlChanges).toEqual(["nobody", "human", "automation"]);
    const humanClicks = events.filter((e) => e.type === "human_action" && e.kind === "click");
    expect(humanClicks.some((e) => e.name === "Acknowledge")).toBe(true);

    // The persisted help-requests.json (what the operator console/evidence show) must carry the
    // same human actions, not just the in-memory result and events.jsonl.
    const requests = JSON.parse(readFileSync(join(runDir, "help-requests.json"), "utf8"));
    const resolved = requests.find((r: { status: string }) => r.status === "resolved");
    expect(resolved.resolution.humanActions.length).toBeGreaterThan(0);
    expect(resolved.resolution.humanActions.some((a: { name: string }) => a.name === "Acknowledge")).toBe(true);
  });

  it("an operator can reject an irreversible step", async () => {
    // Make the fixture's search button look irreversible by declaring the step irreversible.
    const cap = getSavingsBalanceFixture();
    cap.steps[2]!.risk = "irreversible";
    let consoleUrl: string | null = null;
    const running = replay({
      capability: cap,
      inputs: { memberId: "100234" },
      baseUrl: app.url,
      allowDraft: true,
      escalate: true,
      operatorPort: 0,
      headless: true,
      quiet: true,
      runsDir,
      hooks: { onStarted: (info) => (consoleUrl = info.operatorUrl) },
    });
    while (!consoleUrl) await wait(50);
    const { request } = await waitForOpenRequest(consoleUrl);
    expect(request).toMatchObject({ kind: "approval", reasonCode: "IRREVERSIBLE_ACTION", choices: ["approve", "reject"] });
    await fetch(`${consoleUrl}/api/requests/${request.id}/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ choice: "reject", note: "not today" }),
    });
    const { result } = await running;
    expect(result).toMatchObject({ status: "failure", category: "approval_rejected", step: { id: "search" } });
  });

  it("without escalation an irreversible step fails with approval_required", async () => {
    const cap = getSavingsBalanceFixture();
    cap.steps[2]!.risk = "irreversible";
    const { result } = await replay({
      capability: cap,
      inputs: { memberId: "100234" },
      baseUrl: app.url,
      allowDraft: true,
      headless: true,
      quiet: true,
      runsDir,
    });
    expect(result).toMatchObject({ status: "failure", category: "approval_required" });
  });
});
