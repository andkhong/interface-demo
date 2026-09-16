import { describe, expect, it } from "vitest";
import { luhnValid, Redactor } from "../../src/safety/redact";

describe("Redactor", () => {
  it("redacts common sensitive patterns", () => {
    const r = new Redactor();
    const out = r.text("SSN 900-55-1234, born 04/17/1968, call (217) 555-0142 or rosa@example.com, member 100234");
    expect(out).not.toMatch(/900-55-1234|04\/17\/1968|555-0142|rosa@example\.com|100234/);
    expect(out).toContain("[REDACTED:ssn]");
    expect(out).toContain("[REDACTED:account]");
  });

  it("redacts card numbers only when they pass the Luhn check", () => {
    const r = new Redactor();
    expect(r.text("card 4111 1111 1111 1111")).toBe("card [REDACTED:card]");
    expect(luhnValid("4111111111111112")).toBe(false);
  });

  it("does not touch money amounts, ISO timestamps or capability versions", () => {
    const r = new Redactor();
    expect(r.text("balance 1,523.40 at 2026-09-12T21:05:00.000Z")).toBe("balance 1,523.40 at 2026-09-12T21:05:00.000Z");
    expect(r.text("saved cu-legacy.get-savings-balance@1.0.0")).toBe("saved cu-legacy.get-savings-balance@1.0.0");
  });

  it("redacts known values from this run, longest first", () => {
    const r = new Redactor();
    r.addSensitive("DELGADO");
    r.addSensitive("DELGADO, ROSA M");
    expect(r.text("Open member DELGADO, ROSA M")).toBe("Open member [REDACTED:pii]");
  });

  it("walks objects and blanks secret-looking keys", () => {
    const r = new Redactor();
    const out = r.value({ password: "hunter2", nested: [{ note: "ssn 900-71-8842" }], count: 3 });
    expect(out).toEqual({ password: "[REDACTED:secret]", nested: [{ note: "ssn [REDACTED:ssn]" }], count: 3 });
  });

  it("protects declared short names without matching inside unrelated words", () => {
    const r = new Redactor();
    r.addSensitive("Li");
    expect(r.text("click Li's link")).toBe("click [REDACTED:pii]'s link");
  });
});
