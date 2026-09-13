import { describe, expect, it } from "vitest";
import { checkAction, checkUrl, loadPolicy } from "../../src/safety/policy";

const policy = loadPolicy("cu-legacy", "http://localhost:4000");

describe("policy", () => {
  it("allows the app's own pages and blocks everything else", () => {
    expect(checkUrl(policy, "http://localhost:4000/cu/inquiry").allowed).toBe(true);
    expect(checkUrl(policy, "https://evil.example.com/cu/inquiry").allowed).toBe(false);
    expect(checkUrl(policy, "http://localhost:4000/cu/admin").allowed).toBe(false);
    expect(checkUrl(policy, "http://localhost:4000/__faults?set=slow").allowed).toBe(false);
    expect(checkUrl(policy, "http://localhost:4000/other").allowed).toBe(false);
  });

  it("blocks action types that are not allowed", () => {
    const d = checkAction(policy, { action: "navigate" as never, pageUrl: "http://localhost:4000/cu/inquiry", targetName: "x" });
    expect(d.allowed).toBe(false);
  });

  it("blocks clicking a link that leads to a blocked page", () => {
    const d = checkAction(policy, {
      action: "click",
      pageUrl: "http://localhost:4000/cu/menu",
      targetName: "System Admin",
      linkUrl: "http://localhost:4000/cu/admin",
    });
    expect(d.allowed).toBe(false);
  });

  it("marks Confirm-like buttons and review pages as irreversible", () => {
    const byName = checkAction(policy, { action: "click", pageUrl: "http://localhost:4000/cu/inquiry", targetName: "Confirm" });
    expect(byName).toMatchObject({ allowed: true, risk: "irreversible" });
    const byPage = checkAction(policy, { action: "click", pageUrl: "http://localhost:4000/cu/subacct/review", targetName: "OK" });
    expect(byPage).toMatchObject({ allowed: true, risk: "irreversible" });
  });

  it("lets a declared risk raise, but never lower, the risk", () => {
    const raised = checkAction(policy, {
      action: "click",
      pageUrl: "http://localhost:4000/cu/inquiry",
      targetName: "Inquire",
      declaredRisk: "irreversible",
    });
    expect(raised).toMatchObject({ risk: "irreversible" });
    const notLowered = checkAction(policy, {
      action: "click",
      pageUrl: "http://localhost:4000/cu/inquiry",
      targetName: "Confirm",
      declaredRisk: "safe",
    });
    expect(notLowered).toMatchObject({ risk: "irreversible" });
  });

  it("does not treat typing as irreversible", () => {
    const d = checkAction(policy, { action: "fill", pageUrl: "http://localhost:4000/cu/subacct/review", targetName: "Confirm" });
    expect(d).toMatchObject({ allowed: true, risk: "safe" });
  });
});
