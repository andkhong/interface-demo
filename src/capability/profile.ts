// An app profile describes things that are true for the whole application,
// not for one capability:
//   - how to sign on (using secrets the AI never sees)
//   - screens that can appear at any time (session expired, maintenance notice, system error)
//   - business messages the app shows (e.g. "NO RECORDS MATCH") and what they mean
//   - which fields hold sensitive data (masked in screenshots, redacted in logs)
//
// Writing these once per app means every capability for that app gets them for free.

import { readFileSync } from "node:fs";
import { z } from "zod";
import { Target } from "./schema";

const LoginStep = z.discriminatedUnion("action", [
  z.object({ action: z.literal("fill"), target: Target, value: z.string() }),
  z.object({ action: z.literal("click"), target: Target }),
]);

export const KnownScreen = z.discriminatedUnion("handle", [
  // Recoverable: sign on again, then restart the capability from the first step.
  z.object({ id: z.string(), whenTextVisible: z.string(), handle: z.literal("sign_on_and_restart") }),
  // Recoverable: click something to get past the screen (e.g. a Continue link).
  z.object({ id: z.string(), whenTextVisible: z.string(), handle: z.literal("click"), target: Target }),
  // Failure: stop with this category.
  z.object({
    id: z.string(),
    whenTextVisible: z.string(),
    handle: z.literal("fail"),
    category: z.enum(["app_error"]),
    retryable: z.boolean(),
  }),
]);
export type KnownScreen = z.infer<typeof KnownScreen>;

export const Profile = z.object({
  id: z.string(),
  description: z.string(),
  sensitiveFields: z.array(z.string()),
  signOn: z.object({
    whenTextVisible: z.string(),
    steps: z.array(LoginStep).min(1),
    doneWhenTextVisible: z.string(),
  }),
  knownScreens: z.array(KnownScreen),
  businessOutcomes: z.array(
    z.object({
      code: z.string(),
      description: z.string(),
      whenTextVisible: z.string(),
      /** Copied into a capability if the recorded flow visits a page whose path starts with one of these. */
      pages: z.array(z.string()),
    }),
  ),
  secrets: z.record(z.string(), z.string()), // secret name -> environment variable name
});
export type Profile = z.infer<typeof Profile>;

export function loadProfile(id: string): Profile {
  const raw = JSON.parse(readFileSync(`profiles/${id}.json`, "utf8"));
  return Profile.parse(raw);
}

/** Read the secrets a profile needs from the environment. Values stay in memory only. */
export function loadSecrets(profile: Profile): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, envVar] of Object.entries(profile.secrets)) {
    const value = process.env[envVar];
    if (!value) throw new Error(`Secret "${name}" needs environment variable ${envVar}`);
    out[name] = value;
  }
  return out;
}
