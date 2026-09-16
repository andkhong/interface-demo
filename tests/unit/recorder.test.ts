import { describe, expect, it } from "vitest";
import { loadProfile } from "../../src/capability/profile";
import { fillTemplate } from "../../src/capability/template";
import { Recorder } from "../../src/recorder/recorder";
import type { ElementInfo } from "../../src/surface/types";

const element: ElementInfo = { ref: "main:1", frame: "main", frameUrl: "http://localhost/cu/subacct", role: "textbox", tag: "input",
  name: "Amount", rowLabel: "Amount", tableCell: null, rowKeys: [], css: ['input[name="amount"]'], href: null, isPassword: false,
  options: ["0", "50", "75"], text: null, path: "input" };

describe("recorder input contract", () => {
  it.each(["fill", "select"] as const)("parameterizes a short %s input so replay uses the caller's value", (tool) => {
    const recorder = new Recorder();
    recorder.add({ tool, targetName: "amount", intent: "Set amount", element, locators: [{ by: "rowLabel", role: "textbox", label: "Amount" }],
      risk: "safe", value: "50", input: { name: "opening deposit", description: "Amount", sensitivity: "none" } });
    const cap = recorder.compile({ profile: loadProfile("cu-legacy"), finish: { capabilityName: "short-input-test", title: "Set amount",
      description: "Set the supplied amount", successText: "Review" }, runId: "test", model: "scripted-test-model", startPath: "/cu/main" });
    const action = cap.steps[0]!.do;
    const template = action.action === "fill" ? action.value : action.action === "select" ? action.option : "";
    expect(template).toBe("{{inputs.openingDeposit}}");
    expect(fillTemplate(template, { inputs: { openingDeposit: "75" } })).toBe("75");
  });
});
