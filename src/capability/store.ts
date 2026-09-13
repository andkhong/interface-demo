// Saving and loading capability files: capabilities/<id>/<version>.json

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Capability, validateReferences } from "./schema";

const ROOT = "capabilities";

/** JSON with sorted keys, so the same content always gives the same hash. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : 1));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Fingerprint of what the capability DOES. Status and approval are excluded. */
export function computeContentHash(cap: Capability): string {
  const { status: _status, approval: _approval, contentHash: _hash, ...content } = cap;
  return `sha256:${createHash("sha256").update(canonicalJson(content)).digest("hex")}`;
}

export function capabilityPath(id: string, version: string): string {
  return join(ROOT, id, `${version}.json`);
}

export function saveCapability(cap: Capability, path = capabilityPath(cap.id, cap.version)): string {
  const withHash: Capability = { ...cap, contentHash: computeContentHash(cap) };
  Capability.parse(withHash);
  const problems = validateReferences(withHash);
  if (problems.length > 0) throw new Error(`capability is inconsistent:\n  - ${problems.join("\n  - ")}`);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(withHash, null, 2)}\n`);
  return path;
}

function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i]! - pb[i]!;
  return 0;
}

export function listVersions(id: string): string[] {
  const dir = join(ROOT, id);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((f) => f.match(/^(\d+\.\d+\.\d+)\.json$/)?.[1])
    .filter((v): v is string => !!v)
    .sort(compareVersions);
}

/** Load by file path, or by id (latest version) or id@version. */
export function loadCapability(ref: string): { capability: Capability; path: string } {
  let path = ref;
  if (!ref.endsWith(".json")) {
    const [id, version] = ref.split("@") as [string, string | undefined];
    const chosen = version ?? listVersions(id).at(-1);
    if (!chosen) throw new Error(`no capability named "${id}" in ${ROOT}/`);
    path = capabilityPath(id, chosen);
  }
  const capability = Capability.parse(JSON.parse(readFileSync(path, "utf8")));
  const problems = validateReferences(capability);
  if (problems.length > 0) throw new Error(`capability ${path} is inconsistent:\n  - ${problems.join("\n  - ")}`);
  return { capability, path };
}

export function listCapabilities(): { id: string; version: string; status: string; title: string }[] {
  if (!existsSync(ROOT)) return [];
  return readdirSync(ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .flatMap((d) => {
      const latest = listVersions(d.name).at(-1);
      if (!latest) return [];
      const { capability } = loadCapability(`${d.name}@${latest}`);
      return [{ id: capability.id, version: capability.version, status: approvalState(capability), title: capability.title }];
    });
}

export type ApprovalState = "approved" | "draft" | "changed_since_approval";

/** Approval only counts if the content has not changed since someone approved it. */
export function approvalState(cap: Capability): ApprovalState {
  if (cap.status !== "approved" || !cap.approval) return "draft";
  const hash = computeContentHash(cap);
  return cap.approval.contentHash === hash ? "approved" : "changed_since_approval";
}
