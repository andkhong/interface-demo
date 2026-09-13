// Policy: what automation is allowed to do, and which actions count as irreversible.
//
// Every action (AI-driven, replayed, or the sign-on steps) goes through checkAction()
// before it touches the app. A browser-level network guard (see surface/web/browser.ts)
// uses checkUrl() as a second layer for anything a click might navigate to.

import { readFileSync } from "node:fs";
import { z } from "zod";

export const ActionType = z.enum(["click", "fill", "select", "press", "extract"]);
export type ActionType = z.infer<typeof ActionType>;

export const Policy = z.object({
  description: z.string().optional(),
  allowedOrigins: z.array(z.string()),
  allowedPathPrefixes: z.array(z.string()),
  blockedPathPrefixes: z.array(z.string()),
  allowedActions: z.array(ActionType),
  irreversible: z.object({
    targetNamePattern: z.string(),
    pagePathPrefixes: z.array(z.string()),
  }),
});
export type Policy = z.infer<typeof Policy>;

export function loadPolicy(id: string, baseUrl: string): Policy {
  const text = readFileSync(`policies/${id}.json`, "utf8").replaceAll("{{baseUrl}}", new URL(baseUrl).origin);
  return Policy.parse(JSON.parse(text));
}

export type UrlDecision = { allowed: true } | { allowed: false; reason: string };

export function checkUrl(policy: Policy, url: string): UrlDecision {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { allowed: false, reason: `not a valid URL: ${url}` };
  }
  if (!policy.allowedOrigins.includes(parsed.origin)) {
    return { allowed: false, reason: `origin ${parsed.origin} is not on the allowlist` };
  }
  const blocked = policy.blockedPathPrefixes.find((p) => parsed.pathname.startsWith(p));
  if (blocked) return { allowed: false, reason: `path ${parsed.pathname} is blocked (${blocked})` };
  if (!policy.allowedPathPrefixes.some((p) => parsed.pathname.startsWith(p))) {
    return { allowed: false, reason: `path ${parsed.pathname} is not on the allowlist` };
  }
  return { allowed: true };
}

export interface ActionContext {
  action: ActionType;
  /** URL of the frame the target is in. */
  pageUrl: string;
  /** Accessible name of the target, e.g. "Confirm". */
  targetName: string;
  /** Where a link points, if the target is a link. */
  linkUrl?: string | null;
  /** Risk the AI (or the capability file) declared. It can raise risk, never lower it. */
  declaredRisk?: "safe" | "irreversible";
}

export type ActionDecision =
  | { allowed: true; risk: "safe" | "irreversible"; reasons: string[] }
  | { allowed: false; reason: string };

export function checkAction(policy: Policy, ctx: ActionContext): ActionDecision {
  if (!policy.allowedActions.includes(ctx.action)) {
    return { allowed: false, reason: `action "${ctx.action}" is not allowed` };
  }
  const page = checkUrl(policy, ctx.pageUrl);
  if (!page.allowed) return { allowed: false, reason: `page not allowed: ${page.reason}` };
  if (ctx.linkUrl) {
    const link = checkUrl(policy, ctx.linkUrl);
    if (!link.allowed) return { allowed: false, reason: `link destination not allowed: ${link.reason}` };
  }

  // Only clicks and key presses submit things; typing into a box is not irreversible by itself.
  const reasons: string[] = [];
  if (ctx.action === "click" || ctx.action === "press") {
    if (new RegExp(policy.irreversible.targetNamePattern, "i").test(ctx.targetName)) {
      reasons.push(`target name "${ctx.targetName}" matches the irreversible pattern`);
    }
    const path = new URL(ctx.pageUrl).pathname;
    const page = policy.irreversible.pagePathPrefixes.find((p) => path.startsWith(p));
    if (page) reasons.push(`page ${path} is marked irreversible (${page})`);
  }
  if (ctx.declaredRisk === "irreversible") reasons.push("declared irreversible");

  return { allowed: true, risk: reasons.length > 0 ? "irreversible" : "safe", reasons };
}
