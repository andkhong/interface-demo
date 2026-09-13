// Safety check before a capability is saved: it must not contain anything that looks like
// personal data or a secret. Real values should have become {{inputs.x}} placeholders.

import { Redactor } from "../safety/redact";
import type { Capability } from "./schema";

export function lintCapability(cap: Capability, knownSensitiveValues: string[] = []): string[] {
  const { contentHash: _hash, createdFrom: _from, ...content } = cap;
  const redactor = new Redactor();
  for (const value of knownSensitiveValues) redactor.addSensitive(value);

  const problems: string[] = [];
  const visit = (value: unknown, path: string) => {
    if (typeof value === "string") {
      if (redactor.text(value) !== value) {
        problems.push(`${path} looks like it contains sensitive data: ${redactor.text(value)}`);
      }
      return;
    }
    if (Array.isArray(value)) value.forEach((v, i) => visit(v, `${path}[${i}]`));
    else if (value && typeof value === "object") {
      for (const [k, v] of Object.entries(value)) visit(v, path ? `${path}.${k}` : k);
    }
  };
  visit(content, "");
  return problems;
}
