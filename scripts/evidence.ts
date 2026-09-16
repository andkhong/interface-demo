// Regenerates the evidence/ folder.
//
//   npm run evidence                 replay, recovery, failure, handoff, stability + approval scenarios (no API key)
//   npm run evidence -- --with-ai    ALSO runs the two real Claude discovery runs first
//
// Where a scenario needs a human operator, THIS SCRIPT plays the operator: it uses the operator
// console's HTTP API and clicks in the same live browser page. Every such decision carries a note
// saying "scripted operator". README.md explains how to do the same steps by hand.

import "dotenv/config";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { startMockApp } from "../apps/mock-cu/server";
import { ClaudeDecisionModel } from "../src/agent/llm";
import { discover } from "../src/agent/loop";
import type { Capability } from "../src/capability/schema";
import { renderCapability } from "../src/capability/show";
import { listVersions, loadCapability } from "../src/capability/store";
import type { HelpRequest } from "../src/handoff/helpdesk";
import { replay } from "../src/replay/engine";
import type { ReplayResult } from "../src/replay/result";
import { approveCapability, runStability, stabilityReportPath } from "../src/stability/stability";
import type { WebSurface } from "../src/surface/web/browser";

process.env.CU_TELLER_ID ||= "teller01";
process.env.CU_TELLER_PASSWORD ||= "Legacy-Demo-2026!";

const WITH_AI = process.argv.includes("--with-ai");
const OUT = "evidence";
const GOAL_A = "Look up member 100234 and read their current savings balance";
const GOAL_B =
  "Open a new HOLIDAY CLUB sub-account for member 100587 with an opening deposit of 250.00 funded from REGULAR SAVINGS, and read the confirmation number";
const ID_A = "cu-legacy.get-savings-balance";

const scratch = mkdtempSync(join(tmpdir(), "cua-evidence-"));
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
// Keep the historical real-discovery entries when regenerating only the offline scenarios.
const previousIndex = !WITH_AI && existsSync(join(OUT, "runs-index.json"))
  ? JSON.parse(readFileSync(join(OUT, "runs-index.json"), "utf8")) as { scenarios: { folder: string; shows: string; outcome: string }[] }
  : { scenarios: [] };
const index = previousIndex.scenarios.filter((s) => /^(01|10)-discovery/.test(s.folder));

function keep(runDir: string, folder: string, shows: string, outcome: string, extraFiles: string[] = []): string {
  const target = join(OUT, folder);
  rmSync(target, { recursive: true, force: true });
  cpSync(runDir, target, { recursive: true });
  for (const file of extraFiles) cpSync(file, join(target, file.split("/").pop()!));
  index.push({ folder, shows, outcome });
  console.log(`  ✓ ${folder}: ${outcome}`);
  return target;
}

function summarize(result: ReplayResult, cap: Capability): string {
  if (result.status === "success") {
    const outputs = Object.entries(result.outputs)
      .map(([k, v]) => `${k}=${cap.outputs[k]?.sensitivity === "none" ? v : "[not logged]"}`)
      .join(", ");
    const recoveries = result.recoveries.map((r) => r.condition).join(", ");
    return `success (${outputs})${recoveries ? `; recovered: ${recoveries}` : ""}${result.humanHelp.length ? `; human help: ${result.humanHelp.map((h) => h.choice).join(", ")}` : ""}`;
  }
  if (result.status === "business_outcome") return `business_outcome ${result.code} at step ${result.step}`;
  return `failure ${result.category}${result.step ? ` at step ${result.step.id}` : ""}: ${result.message}`;
}

async function post(url: string, body: unknown = {}) {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`${url}: ${await res.text()}`);
}

async function openRequests(consoleUrl: string): Promise<HelpRequest[]> {
  const state = await (await fetch(`${consoleUrl}/api/state`)).json();
  return state.requests.filter((r: HelpRequest) => r.status === "open");
}

async function screenshotConsole(consoleUrl: string, path: string) {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
    await page.goto(consoleUrl);
    await page.waitForSelector(".card", { timeout: 5000 });
    await page.screenshot({ path, fullPage: true });
  } finally {
    await browser.close();
  }
}

/** Pick demo values for capability B's inputs, whatever names the model gave them. */
function inputsForSubAccount(cap: Capability): Record<string, string> {
  return Object.fromEntries(
    Object.entries(cap.inputs).map(([name, spec]) => {
      if (spec.type === "enum") {
        const values = spec.values ?? [];
        const wanted = /fund|source|from/i.test(name) ? /S00|SAVINGS/ : /HOLIDAY/;
        return [name, values.find((v) => wanted.test(v)) ?? values[0] ?? ""];
      }
      if (/member|account/i.test(name) || spec.pattern === "^\\d{6}$") return [name, "100587"];
      if (/amount|deposit/i.test(name)) return [name, "250.00"];
      return [name, "250.00"];
    }),
  );
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const app = await startMockApp(0);
  console.log(`fake app at ${app.url}; scratch runs in ${scratch}`);

  try {
    // ---------- 1. real discovery (Claude) ----------
    if (WITH_AI) {
      const result = await discover({
        goal: GOAL_A,
        capabilityName: "get-savings-balance",
        profileId: "cu-legacy",
        baseUrl: app.url,
        startPath: "/cu/main",
        model: new ClaudeDecisionModel(),
        escalate: false,
        headless: true,
        runsDir: scratch,
      });
      if (result.status !== "saved") throw new Error(`discovery A stopped: ${result.reason}`);
      keep(result.runDir, "01-discovery-get-savings-balance", "Real Claude discovery run: goal -> saved capability", `saved ${result.capability.id}@${result.capability.version} in ${result.turns} turns`);
    }

    const { capability: capA, path: pathA } = loadCapability(ID_A);
    const inputName = Object.keys(capA.inputs)[0]!;
    const member = (value: string) => ({ [inputName]: value });
    const run = (options: Partial<Parameters<typeof replay>[0]>) =>
      replay({ capability: capA, inputs: member("100234"), baseUrl: app.url, allowDraft: true, headless: true, quiet: true, runsDir: scratch, ...options });

    // ---------- 2-7. replays ----------
    let r = await run({ inputs: member("100587") });
    keep(r.runDir, "02-replay-success", "Replay without the model, for a different member than the one used in discovery", summarize(r.result, capA));

    r = await run({ inputs: member("999999") });
    keep(r.runDir, "03-replay-business-outcome-not-found", "'No such member' is a business outcome, not a crash", summarize(r.result, capA));

    r = await run({ inputs: member("12AB") });
    keep(r.runDir, "04-replay-invalid-input", "Inputs are validated against the schema before the app is touched", summarize(r.result, capA));

    r = await run({ faults: ["interstitial", "session_timeout", "slow"] });
    keep(r.runDir, "05-replay-recovered-runtime-conditions", "Maintenance notice dismissed, session timeout -> sign on + restart, slow page -> extra wait", summarize(r.result, capA));

    r = await run({ faults: ["app_error"] });
    keep(r.runDir, "06-replay-app-error", "Hard failure with step, expected/observed, masked screenshot and redacted HTML", summarize(r.result, capA));

    r = await run({ capability: { ...capA, status: "draft", approval: null }, allowDraft: false });
    keep(r.runDir, "07-replay-refused-draft", "An unapproved (draft) capability is refused for unattended replay", summarize(r.result, capA));

    // ---------- 8. stability + approval ----------
    const { report } = await runStability({
      capability: capA,
      capabilityPath: pathA,
      inputs: member("100234"),
      runs: 10,
      baseUrl: app.url,
      expectOutcome: { inputs: member("999999"), code: "MEMBER_NOT_FOUND" },
      runsDir: scratch,
    });
    const approved = approveCapability(pathA, "Demo Reviewer (evidence script)").capability;
    r = await replay({ capability: approved, inputs: member("100234"), baseUrl: app.url, headless: true, quiet: true, runsDir: scratch });
    keep(
      r.runDir,
      "08-stability-then-approved-replay",
      "10+10 replays -> stable -> approved (bound to content hash) -> replay runs without --allow-draft",
      `stability ${report.verdict} (${report.happyPath.succeeded}/10 success, ${report.expectedOutcome?.matched}/10 MEMBER_NOT_FOUND); approved replay: ${summarize(r.result, approved)}`,
      [stabilityReportPath(pathA)],
    );

    // ---------- 9. human handoff on the live session ----------
    {
      let surface: WebSurface | undefined;
      let consoleUrl: string | null = null;
      const running = replay({
        capability: approved,
        inputs: member("100234"),
        baseUrl: app.url,
        escalate: true,
        operatorPort: 0,
        headless: true,
        quiet: true,
        runsDir: scratch,
        faults: ["unknown_dialog"],
        hooks: { onStarted: (info) => ((surface = info.surface), (consoleUrl = info.operatorUrl)) },
      });
      while (!consoleUrl) await wait(50);
      let request: HelpRequest | undefined;
      while (!request) {
        request = (await openRequests(consoleUrl))[0];
        await wait(200);
      }
      const shot1 = join(scratch, "operator-console-1-help-requested.png");
      const shot2 = join(scratch, "operator-console-2-human-in-control.png");
      await screenshotConsole(consoleUrl, shot1);
      await post(`${consoleUrl}/api/requests/${request.id}/claim`);
      // The (scripted) operator acts in the SAME browser page the automation was using.
      const main = surface!.page.frame({ name: "main" })!;
      await main.getByRole("button", { name: "Acknowledge" }).click();
      await main.getByText("MEMBER DETAIL").waitFor();
      await screenshotConsole(consoleUrl, shot2);
      const stuckIndex = approved.steps.findIndex((s) => s.id === request!.step?.id);
      await post(`${consoleUrl}/api/requests/${request.id}/resolve`, {
        choice: "continue_from",
        stepId: approved.steps[stuckIndex + 1]!.id,
        note: "scripted operator acknowledged the member alert",
      });
      const done = await running;
      keep(
        done.runDir,
        "09-replay-human-handoff",
        "Unknown screen -> help request -> operator takes control of the same session -> hands back -> replay verifies and finishes",
        summarize(done.result, approved),
        [shot1, shot2],
      );
    }

    // ---------- 10-12. irreversible flow ----------
    if (WITH_AI) {
      let consoleUrl: string | null = null;
      const shot = join(scratch, "operator-console-approval-request.png");
      const operator = { stop: false, screenshot: false };
      const operatorLoop = (async () => {
        while (!operator.stop) {
          try {
            for (const request of consoleUrl ? await openRequests(consoleUrl) : []) {
              if (!operator.screenshot) {
                await screenshotConsole(consoleUrl!, shot);
                operator.screenshot = true;
              }
              const choice = request.kind === "approval" ? "approve" : "abort";
              await post(`${consoleUrl}/api/requests/${request.id}/resolve`, { choice, note: `scripted operator (evidence): ${choice}` });
            }
          } catch {
            // console not up yet, or already closed
          }
          await wait(300);
        }
      })();
      const result = await discover({
        goal: GOAL_B,
        capabilityName: "open-sub-account",
        profileId: "cu-legacy",
        baseUrl: app.url,
        startPath: "/cu/main",
        model: new ClaudeDecisionModel(),
        escalate: true,
        operatorPort: 0,
        headless: true,
        runsDir: scratch,
        hooks: { onStarted: (info) => (consoleUrl = info.operatorUrl) },
      });
      operator.stop = true;
      await operatorLoop;
      if (result.status !== "saved") throw new Error(`discovery B stopped: ${result.reason}`);
      keep(result.runDir, "10-discovery-open-sub-account-with-approval", "Real Claude discovery of an irreversible flow; the Confirm click waited for operator approval", `saved ${result.capability.id}@${result.capability.version} in ${result.turns} turns`, operator.screenshot ? [shot] : []);

    }

    // Both write-flow replays work offline using the saved artifact.
    {
      const capB = loadCapability("cu-legacy.open-sub-account").capability;
      const inputsB = inputsForSubAccount(capB);
      r = await replay({ capability: capB, inputs: inputsB, baseUrl: app.url, allowDraft: true, headless: true, quiet: true, runsDir: scratch });
      keep(r.runDir, "11-replay-irreversible-without-operator", "Irreversible step with nobody to approve -> stops before clicking", summarize(r.result, capB));

      let consoleB: string | null = null;
      const approver = { stop: false };
      const approverLoop = (async () => {
        while (!approver.stop) {
          try {
            for (const request of consoleB ? await openRequests(consoleB) : []) {
              await post(`${consoleB}/api/requests/${request.id}/resolve`, { choice: request.kind === "approval" ? "approve" : "abort", note: "scripted operator (evidence)" });
            }
          } catch {
            // ignore
          }
          await wait(300);
        }
      })();
      r = await replay({ capability: capB, inputs: inputsB, baseUrl: app.url, allowDraft: true, escalate: true, operatorPort: 0, headless: true, quiet: true, runsDir: scratch, hooks: { onStarted: (info) => (consoleB = info.operatorUrl) } });
      approver.stop = true;
      await approverLoop;
      keep(r.runDir, "12-replay-irreversible-approved", "Same replay with an operator: approval requested, approved, confirmation read", summarize(r.result, capB));
    }

    // ---------- capability files ----------
    mkdirSync(join(OUT, "capabilities"), { recursive: true });
    for (const id of [ID_A, "cu-legacy.open-sub-account"]) {
      const version = listVersions(id).at(-1);
      if (!version) continue;
      const { capability, path } = loadCapability(`${id}@${version}`);
      cpSync(path, join(OUT, "capabilities", `${id}@${version}.json`));
      writeFileSync(join(OUT, "capabilities", `${id}@${version}.md`), renderCapability(capability));
    }
  } finally {
    await app.close();
  }

  index.sort((a, b) => a.folder.localeCompare(b.folder));
  writeFileSync(
    join(OUT, "runs-index.json"),
    `${JSON.stringify({ generatedAt: new Date().toISOString(), withAi: WITH_AI, scenarios: index }, null, 2)}\n`,
  );
  console.log(`\nwrote ${index.length} scenarios to ${OUT}/ (index: ${OUT}/runs-index.json)`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
