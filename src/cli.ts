// Command line entry point: npm run cua -- <command> [options]

import "dotenv/config";
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { startMockApp } from "../apps/mock-cu/server";
import { ClaudeDecisionModel } from "./agent/llm";
import { discover } from "./agent/loop";
import { renderCapability } from "./capability/show";
import { listCapabilities, loadCapability } from "./capability/store";
import { replay } from "./replay/engine";
import { approveCapability, runStability } from "./stability/stability";

const USAGE = `Usage: npm run cua -- <command> [options]

  discover --goal "<goal>"         Let Claude work out the goal on the live app and save a capability
           [--name get-savings-balance] [--app cu-legacy] [--start-path /cu/main] [--max-steps 30]
           [--headless] [--no-escalate]

  replay <capability> --input name=value [--input ...]
           [--allow-draft] [--escalate] [--fault interstitial,slow,...] [--headed] [--json]

  show <capability> [--write]      Print a readable summary (--write saves it next to the JSON)
  list                             List saved capabilities
  stability <capability> --input name=value [--runs 10] [--expect-outcome name=value:CODE]
  approve <capability> --by "Your Name"
  app                              Run the fake CU*LEGACY app

  <capability> is an id (latest version), id@version, or a path to a .json file.
  Common: [--base-url http://localhost:4000]   (the fake app is started automatically if needed)
`;

// Demo credentials for the local fake app (override in .env). Used by sign-on only; never shown to the AI or logged.
process.env.CU_TELLER_ID ||= "teller01";
process.env.CU_TELLER_PASSWORD ||= "Legacy-Demo-2026!";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    goal: { type: "string" },
    name: { type: "string" },
    app: { type: "string", default: "cu-legacy" },
    "start-path": { type: "string", default: "/cu/main" },
    "base-url": { type: "string", default: process.env.CU_BASE_URL ?? `http://localhost:${process.env.MOCK_BANK_APP_PORT ?? 4000}` },
    "max-steps": { type: "string", default: "30" },
    headless: { type: "boolean", default: false },
    headed: { type: "boolean", default: false },
    "no-escalate": { type: "boolean", default: false },
    escalate: { type: "boolean", default: false },
    input: { type: "string", multiple: true, default: [] },
    "allow-draft": { type: "boolean", default: false },
    fault: { type: "string" },
    json: { type: "boolean", default: false },
    write: { type: "boolean", default: false },
    runs: { type: "string", default: "10" },
    "expect-outcome": { type: "string" },
    by: { type: "string" },
    help: { type: "boolean", default: false },
  },
});

function parseInputs(list: string[]): Record<string, string> {
  return Object.fromEntries(
    list.map((pair) => {
      const i = pair.indexOf("=");
      if (i <= 0) throw new Error(`--input must look like name=value (got "${pair}")`);
      return [pair.slice(0, i), pair.slice(i + 1)];
    }),
  );
}

/** Start the fake app in this process if nothing is listening at the base URL. */
async function ensureApp(baseUrl: string): Promise<() => Promise<void>> {
  try {
    await fetch(`${baseUrl}/cu/signon`);
    return async () => {};
  } catch {
    const url = new URL(baseUrl);
    if (!["localhost", "127.0.0.1"].includes(url.hostname)) throw new Error(`${baseUrl} is not reachable`);
    const app = await startMockApp(Number(url.port || 80));
    console.log(`(started the fake CU*LEGACY app at ${app.url})`);
    return app.close;
  }
}

function requireCapabilityArg(): string {
  const ref = positionals[1];
  if (!ref) throw new Error(`missing <capability>\n\n${USAGE}`);
  return ref;
}

async function main(): Promise<number> {
  const command = positionals[0];
  const baseUrl = values["base-url"]!;
  const autoConfirmRisky = process.env.AUTO_CONFIRM_RISKY === "true";
  const operatorPort = Number(process.env.OPERATOR_PORT ?? 4100);

  if (!command || values.help) {
    console.log(USAGE);
    return 0;
  }

  if (command === "app") {
    const port = Number(new URL(baseUrl).port || 4000);
    const app = await startMockApp(port);
    console.log(`CU*LEGACY fake app running at ${app.url} (teller ${process.env.CU_TELLER_ID}). Ctrl+C to stop.`);
    await new Promise(() => {});
  }

  if (command === "list") {
    for (const c of listCapabilities()) console.log(`${c.id}@${c.version}  [${c.status}]  ${c.title}`);
    return 0;
  }

  if (command === "show") {
    const { capability, path } = loadCapability(requireCapabilityArg());
    const markdown = renderCapability(capability);
    if (values.write) {
      writeFileSync(path.replace(/\.json$/, ".md"), markdown);
      console.log(`wrote ${path.replace(/\.json$/, ".md")}`);
    } else {
      console.log(markdown);
    }
    return 0;
  }

  if (command === "approve") {
    if (!values.by) throw new Error('approve needs --by "Your Name"');
    const { path, capability } = approveCapability(requireCapabilityArg(), values.by);
    console.log(`approved ${capability.id}@${capability.version} (${capability.approval?.stability}) -> ${path}`);
    return 0;
  }

  const closeApp = await ensureApp(baseUrl);
  try {
    if (command === "discover") {
      if (!values.goal) throw new Error('discover needs --goal "..."');
      if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
        throw new Error("discover needs ANTHROPIC_API_KEY (copy .env.example to .env). Replay, tests and the demo artifacts work without it.");
      }
      const model = new ClaudeDecisionModel();
      console.log(`Discovery with ${model.name}\nGoal: ${values.goal}\n`);
      const result = await discover({
        goal: values.goal,
        profileId: values.app!,
        baseUrl,
        startPath: values["start-path"]!,
        model,
        capabilityName: values.name,
        maxSteps: Number(values["max-steps"]),
        escalate: !values["no-escalate"],
        operatorPort,
        headless: values.headless,
        autoConfirmRisky,
      });
      console.log("");
      if (result.status === "saved") {
        console.log(`Saved capability ${result.capability.id}@${result.capability.version} -> ${result.capabilityPath}`);
        console.log(`Evidence: ${result.runDir}`);
        const inputs = Object.keys(result.capability.inputs).map((n) => `--input ${n}=...`).join(" ");
        console.log(`\nReview it:  npm run cua -- show ${result.capability.id}`);
        console.log(`Replay it:  npm run cua -- replay ${result.capability.id} ${inputs} --allow-draft`);
        return 0;
      }
      console.log(`Discovery stopped: ${result.reason}\nEvidence: ${result.runDir}`);
      return 1;
    }

    if (command === "replay") {
      const { capability } = loadCapability(requireCapabilityArg());
      const { result, runDir } = await replay({
        capability,
        inputs: parseInputs(values.input as string[]),
        baseUrl,
        allowDraft: values["allow-draft"],
        escalate: values.escalate,
        operatorPort,
        faults: values.fault ? values.fault.split(",").map((f) => f.trim()) : undefined,
        headless: values.escalate || values.headed ? false : true,
        autoConfirmRisky,
      });
      console.log(`\n== ${result.status.toUpperCase()}${result.status === "failure" ? `: ${result.category}` : result.status === "business_outcome" ? `: ${result.code}` : ""} ==`);
      console.log(JSON.stringify(result, null, 2));
      console.log(`\nEvidence: ${runDir}`);
      return result.status === "failure" ? 1 : 0;
    }

    if (command === "stability") {
      const { capability, path } = loadCapability(requireCapabilityArg());
      let expectOutcome: { inputs: Record<string, string>; code: string } | undefined;
      if (values["expect-outcome"]) {
        const [pairs, code] = values["expect-outcome"].split(":");
        if (!pairs || !code) throw new Error("--expect-outcome must look like name=value:CODE");
        expectOutcome = { inputs: parseInputs(pairs.split(",")), code };
      }
      const { report, path: reportPath } = await runStability({
        capability,
        capabilityPath: path,
        inputs: parseInputs(values.input as string[]),
        runs: Number(values.runs),
        baseUrl,
        expectOutcome,
        onProgress: (line) => console.log(`  ${line}`),
      });
      console.log(`\nverdict: ${report.verdict} (${report.happyPath.succeeded}/${report.runs} succeeded${report.expectedOutcome ? `, ${report.expectedOutcome.matched}/${report.runs} ${report.expectedOutcome.code}` : ""}; avg ${report.averageDurationMs} ms)`);
      console.log(`report: ${reportPath}`);
      return report.verdict === "stable" ? 0 : 1;
    }

    console.log(USAGE);
    return 1;
  } finally {
    await closeApp();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(`error: ${(error as Error).message}`);
    process.exit(1);
  });
