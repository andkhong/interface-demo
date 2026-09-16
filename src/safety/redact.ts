// Redaction: the one function everything passes through before it is written to disk.
//
// Two layers:
//   1. Known values  - exact strings we know are sensitive in THIS run
//                      (input values marked pii, secrets, text read from Name/SSN/... fields).
//   2. Patterns      - shapes that look sensitive anywhere (SSN, card number, dates, phone, email, account numbers).

const SECRET_KEYS = /pass(word)?|secret|token|api[-_]?key|authorization|cookie/i;

interface Pattern {
  kind: string;
  regex: RegExp;
  accept?: (match: string) => boolean;
}

const PATTERNS: Pattern[] = [
  { kind: "ssn", regex: /\b\d{3}-\d{2}-\d{4}\b/g },
  { kind: "card", regex: /\b(?:\d[ -]?){12,18}\d\b/g, accept: (m) => luhnValid(m.replace(/\D/g, "")) },
  // The top-level domain must be letters, so "capability-id@1.0.0" is not mistaken for an email.
  { kind: "email", regex: /\b[\w.+-]+@[\w-]+(?:\.[\w-]+)*\.[a-zA-Z]{2,}\b/g },
  { kind: "phone", regex: /\(\d{3}\)\s?\d{3}-\d{4}|\b\d{3}-\d{3}-\d{4}\b/g },
  { kind: "date", regex: /\b\d{2}\/\d{2}\/\d{4}\b/g },
  { kind: "account", regex: /\b\d{6,17}\b/g },
];

export function luhnValid(digits: string): boolean {
  if (digits.length < 13) return false;
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export class Redactor {
  private known = new Map<string, string>(); // value -> kind

  /** Remember a value that must never be written anywhere during this run. */
  addSensitive(value: string | undefined | null, kind = "pii"): void {
    const v = (value ?? "").trim();
    if (v.length > 0) this.known.set(v, kind);
  }

  knownValues(): string[] {
    return [...this.known.keys()];
  }

  text(input: string): string {
    let out = input;
    // Longest first, so "DELGADO, ROSA M" is replaced before "DELGADO".
    const values = [...this.known.entries()].sort((a, b) => b[0].length - a[0].length);
    for (const [value, kind] of values) {
      // Short names such as "Li" must be protected without corrupting "click".
      const pattern = value.length < 3 ? `(?<![\\p{L}\\p{N}_])${escapeRegex(value)}(?![\\p{L}\\p{N}_])` : escapeRegex(value);
      out = out.replace(new RegExp(pattern, "giu"), `[REDACTED:${kind}]`);
    }
    for (const p of PATTERNS) {
      out = out.replace(p.regex, (m) => (p.accept && !p.accept(m) ? m : `[REDACTED:${p.kind}]`));
    }
    return out;
  }

  /** Redact every string inside an object. Keys that look like secrets are blanked entirely. */
  value<T>(input: T): T {
    return this.walk(input) as T;
  }

  private walk(input: unknown, key?: string): unknown {
    if (typeof input === "string") {
      return key && SECRET_KEYS.test(key) ? "[REDACTED:secret]" : this.text(input);
    }
    if (Array.isArray(input)) return input.map((v) => this.walk(v));
    if (input && typeof input === "object") {
      return Object.fromEntries(Object.entries(input).map(([k, v]) => [k, this.walk(v, k)]));
    }
    return input;
  }
}
