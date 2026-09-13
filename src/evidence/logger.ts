// Run evidence: one folder per run under runs/<runId>/.
//
//   events.jsonl   one JSON line per thing that happened (observed, decided, acted, recovered, ...)
//   result.json    the final result
//   screenshots/   masked screenshots
//   pages/         redacted HTML snapshots (on failure / handoff)
//
// Every write goes through the run's Redactor. There is no other way to write evidence.

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Redactor } from "../safety/redact";

export type RunKind = "discovery" | "replay" | "stability";

function newRunId(kind: RunKind): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
  const letters = Array.from({ length: 4 }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join("");
  return `${kind}_${stamp}_${letters}`;
}

export class RunLogger {
  readonly runId: string;
  readonly dir: string;
  private seq = 0;

  constructor(
    readonly kind: RunKind,
    readonly redactor: Redactor,
    options: { rootDir?: string; quiet?: boolean } = {},
  ) {
    this.runId = newRunId(kind);
    this.dir = resolve(options.rootDir ?? "runs", this.runId);
    mkdirSync(join(this.dir, "screenshots"), { recursive: true });
    mkdirSync(join(this.dir, "pages"), { recursive: true });
    this.quiet = options.quiet ?? false;
  }

  private readonly quiet: boolean;

  event(type: string, data: Record<string, unknown> = {}): void {
    const { type: _reserved, ...safe } = this.redactor.value(data);
    const line = { seq: ++this.seq, at: new Date().toISOString(), type, ...safe };
    appendFileSync(join(this.dir, "events.jsonl"), `${JSON.stringify(line)}\n`);
    if (!this.quiet) {
      const summary = typeof safe["summary"] === "string" ? safe["summary"] : "";
      console.log(`  [${String(line.seq).padStart(3, "0")}] ${type}${summary ? ` - ${summary}` : ""}`);
    }
  }

  writeJson(name: string, value: unknown): string {
    const path = join(this.dir, name);
    writeFileSync(path, `${JSON.stringify(this.redactor.value(value), null, 2)}\n`);
    return path;
  }

  /** Append one redacted JSON line to a file in the run folder (e.g. the AI transcript). */
  append(name: string, value: unknown): void {
    appendFileSync(join(this.dir, name), `${JSON.stringify(this.redactor.value(value))}\n`);
  }

  /** Images are masked before they get here (see Surface.screenshot / observe). */
  writeBinary(name: string, data: Buffer): string {
    const path = join(this.dir, name);
    writeFileSync(path, data);
    return path;
  }

  writeText(name: string, text: string): string {
    const path = join(this.dir, name);
    writeFileSync(path, this.redactor.text(text));
    return path;
  }

  /** Absolute path for a file inside the run folder (e.g. a screenshot). */
  path(name: string): string {
    return join(this.dir, name);
  }
}
