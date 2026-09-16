import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { loadProfile } from "../../src/capability/profile";
import { RunLogger } from "../../src/evidence/logger";
import { ControlTurn } from "../../src/handoff/control";
import { noHelpDesk } from "../../src/handoff/helpdesk";
import { loadPolicy } from "../../src/safety/policy";
import { Redactor } from "../../src/safety/redact";
import { Session } from "../../src/session";
import type { Surface } from "../../src/surface/types";

function setup(allowExtract = true) {
  const control = new ControlTurn();
  const readText = vi.fn(async () => "1,523.40");
  const elementInfo = vi.fn(async () => ({ role: "cell", name: "Current Bal", href: null }));
  const surface = { onHumanAction: vi.fn(), readText, elementInfo } as unknown as Surface;
  const policy = loadPolicy("cu-legacy", "http://localhost:4000");
  if (!allowExtract) policy.allowedActions = policy.allowedActions.filter((a) => a !== "extract");
  const log = new RunLogger("replay", new Redactor(), { rootDir: mkdtempSync(join(tmpdir(), "cua-session-test-")), quiet: true });
  const session = new Session({ surface, policy, profile: loadProfile("cu-legacy"), control, log, helpDesk: noHelpDesk,
    secrets: {}, autoConfirmRisky: false, subject: "test", mode: "replay" });
  return { session, control, readText, elementInfo };
}

const request = { element: { frame: "main", frameUrl: "http://localhost:4000/cu/member", path: "td" }, label: "balance", step: null };

describe("Session extraction", () => {
  it("blocks a forbidden extraction before reading the UI", async () => {
    const { session, readText } = setup(false);
    expect(await session.read(request)).toMatchObject({ ok: false, category: "policy_blocked" });
    expect(readText).not.toHaveBeenCalled();
  });

  it("returns allowed data to the caller", async () => {
    const { session, readText } = setup();
    expect(await session.read(request)).toEqual({ ok: true, text: "1,523.40" });
    expect(readText).toHaveBeenCalledOnce();
  });

  it("rechecks control after asynchronous policy preparation", async () => {
    const { session, control, readText, elementInfo } = setup();
    elementInfo.mockImplementation(async () => {
      control.handTo("human", "takeover during inspection");
      return { role: "cell", name: "Current Bal", href: null };
    });
    await expect(session.read(request)).rejects.toThrow(/lost control/);
    expect(readText).not.toHaveBeenCalled();
  });
});
