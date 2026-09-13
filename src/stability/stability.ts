// Stretch goal: measure how reliably a capability replays, and gate approval on it.
//
// runStability() replays the capability N times on the happy path (and optionally N times with
// inputs that should produce a known business outcome) and writes a report next to the file.
// approveCapability() only approves when that report is "stable" AND matches the current content hash.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { Capability } from "../capability/schema";
import { computeContentHash, loadCapability, saveCapability } from "../capability/store";
import { replay } from "../replay/engine";

export interface StabilityReport {
  capability: { id: string; version: string; contentHash: string };
  createdAt: string;
  runs: number;
  happyPath: { inputNames: string[]; succeeded: number; results: string[] };
  expectedOutcome: { code: string; matched: number; results: string[] } | null;
  averageDurationMs: number;
  degradedLocatorWarnings: number;
  recoveries: number;
  verdict: "stable" | "flaky" | "failing";
  runIds: string[];
}

export function stabilityReportPath(capabilityPath: string): string {
  return capabilityPath.replace(/\.json$/, ".stability.json");
}

export async function runStability(opts: {
  capability: Capability;
  capabilityPath: string;
  inputs: Record<string, string>;
  runs: number;
  baseUrl: string;
  expectOutcome?: { inputs: Record<string, string>; code: string };
  runsDir?: string;
  onProgress?: (line: string) => void;
}): Promise<{ report: StabilityReport; path: string }> {
  const happy: string[] = [];
  const outcome: string[] = [];
  const runIds: string[] = [];
  let totalMs = 0;
  let degraded = 0;
  let recoveries = 0;

  const once = async (inputs: Record<string, string>) => {
    const { result } = await replay({
      capability: opts.capability,
      inputs,
      baseUrl: opts.baseUrl,
      allowDraft: true,
      headless: true,
      quiet: true,
      runsDir: opts.runsDir,
    });
    runIds.push(result.runId);
    totalMs += result.durationMs;
    degraded += result.warnings.length;
    recoveries += result.recoveries.length;
    return result.status === "success" ? "success" : result.status === "business_outcome" ? `business_outcome:${result.code}` : `failure:${result.category}`;
  };

  for (let i = 1; i <= opts.runs; i++) {
    happy.push(await once(opts.inputs));
    opts.onProgress?.(`happy path ${i}/${opts.runs}: ${happy.at(-1)}`);
    if (opts.expectOutcome) {
      outcome.push(await once(opts.expectOutcome.inputs));
      opts.onProgress?.(`expected ${opts.expectOutcome.code} ${i}/${opts.runs}: ${outcome.at(-1)}`);
    }
  }

  const succeeded = happy.filter((r) => r === "success").length;
  const matched = opts.expectOutcome ? outcome.filter((r) => r === `business_outcome:${opts.expectOutcome!.code}`).length : 0;
  const allGood = succeeded === opts.runs && (!opts.expectOutcome || matched === opts.runs);
  const report: StabilityReport = {
    capability: { id: opts.capability.id, version: opts.capability.version, contentHash: computeContentHash(opts.capability) },
    createdAt: new Date().toISOString(),
    runs: opts.runs,
    happyPath: { inputNames: Object.keys(opts.inputs), succeeded, results: happy },
    expectedOutcome: opts.expectOutcome ? { code: opts.expectOutcome.code, matched, results: outcome } : null,
    averageDurationMs: Math.round(totalMs / runIds.length),
    degradedLocatorWarnings: degraded,
    recoveries,
    verdict: allGood ? "stable" : succeeded === 0 ? "failing" : "flaky",
    runIds,
  };
  const path = stabilityReportPath(opts.capabilityPath);
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
  return { report, path };
}

export function approveCapability(ref: string, by: string, minRuns = 10): { path: string; capability: Capability } {
  const { capability, path } = loadCapability(ref);
  const reportPath = stabilityReportPath(path);
  if (!existsSync(reportPath)) throw new Error(`no stability report at ${reportPath}; run the stability command first`);
  const report = JSON.parse(readFileSync(reportPath, "utf8")) as StabilityReport;
  const hash = computeContentHash(capability);
  if (report.capability.contentHash !== hash) {
    throw new Error("the stability report was made for different content (the capability changed since); run stability again");
  }
  if (report.runs < minRuns) throw new Error(`stability used ${report.runs} runs; at least ${minRuns} are required`);
  if (report.verdict !== "stable") {
    throw new Error(`stability verdict is "${report.verdict}" (${report.happyPath.succeeded}/${report.runs} succeeded); only stable capabilities can be approved`);
  }
  const stability =
    `${report.happyPath.succeeded}/${report.runs} succeeded` +
    (report.expectedOutcome ? `, ${report.expectedOutcome.matched}/${report.runs} returned ${report.expectedOutcome.code}` : "");
  const approved: Capability = { ...capability, status: "approved", approval: { by, at: new Date().toISOString(), contentHash: hash, stability } };
  saveCapability(approved, path);
  return { path, capability: approved };
}
