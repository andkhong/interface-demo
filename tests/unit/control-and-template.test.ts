import { describe, expect, it } from "vitest";
import { fillTemplate, fillTemplateDeep } from "../../src/capability/template";
import { ControlLostError, ControlTurn } from "../../src/handoff/control";

describe("ControlTurn", () => {
  it("lets automation act only while it holds the current turn", () => {
    const control = new ControlTurn();
    const myTurn = control.get().turn;
    expect(() => control.assertAutomationMayAct(myTurn)).not.toThrow();

    control.handTo("human", "operator took control");
    expect(() => control.assertAutomationMayAct(myTurn)).toThrow(ControlLostError);

    // Even when control comes back to automation, the OLD turn number stays invalid.
    const newTurn = control.handTo("automation", "operator resumed");
    expect(() => control.assertAutomationMayAct(myTurn)).toThrow(ControlLostError);
    expect(() => control.assertAutomationMayAct(newTurn)).not.toThrow();
  });

  it("notifies listeners on every hand-over", () => {
    const control = new ControlTurn();
    const seen: string[] = [];
    control.onChange((s, prev) => seen.push(`${prev.controller}->${s.controller}#${s.turn}`));
    control.handTo("nobody", "waiting for operator");
    control.handTo("human", "claimed");
    expect(seen).toEqual(["automation->nobody#2", "nobody->human#3"]);
  });
});

describe("templates", () => {
  it("fills inputs and secrets", () => {
    expect(fillTemplate("m={{inputs.memberId}}", { inputs: { memberId: "100234" } })).toBe("m=100234");
    expect(fillTemplate("{{secrets.pw}}", { inputs: {}, secrets: { pw: "x" } })).toBe("x");
  });

  it("fails loudly on a missing value instead of typing a placeholder", () => {
    expect(() => fillTemplate("{{inputs.memberId}}", { inputs: {} })).toThrow(/Missing value/);
  });

  it("fills placeholders inside locators", () => {
    const locator = { by: "role", role: "link", name: "{{inputs.memberId}}" };
    expect(fillTemplateDeep(locator, { inputs: { memberId: "100587" } })).toEqual({ by: "role", role: "link", name: "100587" });
  });
});
