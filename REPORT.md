# REPORT — Computer-Use Automation System

A model discovers a UI flow; a recorder turns it into a typed capability; replay executes it without model decisions. A human can take over the same browser when automation cannot proceed. The target is a local, synthetic credit-union app with framesets, layout tables, neighbouring-cell labels, and no test IDs. [Evidence](evidence/README.md) includes two recorded Claude discovery runs and deterministic replays.

## 1. Architecture

```text
goal → discovery (observe / decide / act) → recorder → capability JSON
                                                        ↓
                                            replay ← id + inputs
                                                ↓
                       Session: control / policy / approval / secrets
                                                ↓
                       Surface: perception + actions ← human takeover
```

TypeScript and Zod share static types and runtime validation. A CLI and one Node process keep the vertical slice easy to run. Playwright implements the browser surface; flow logic uses the `Surface` vocabulary, while entry points construct `WebSurface`. `Session.act()` and `Session.read()` enforce policy and the control turn.

Claude receives screen text with element references and a masked screenshot. Each turn makes a fresh request containing the goal and action history, selects one tool, then observes again. The checked-in discovery used `claude-opus-5` with adaptive thinking. One action per turn gives a clear boundary for recording and intervention; it costs additional round trips. Tests use a scripted model, while the discovery evidence comes from actual API calls.

The intentionally hostile local app exercises legacy targeting and injected runtime errors without real financial data or a third-party service dependency.

## 2. Artifact schema

A capability is a contract plus an executable recipe, separate from the transcript. `src/capability/schema.ts` defines:

| Field | Purpose |
|---|---|
| `id`, `version`, `createdFrom` | Identity, semantic version, discovery provenance |
| `inputs`, `outputs`, `outcomes` | Typed invocation arguments, returned data, legitimate business results |
| `targets` | Named controls with ordered locator alternatives and optional frame hints |
| `steps`, `finalCheck` | Ordered actions, intermediate checks, completion conditions |
| `risk`, `status`, `approval`, `contentHash` | Risk classification and approval bound to content |

For example, savings lookup takes a six-digit member number and returns a numeric savings balance. A missing member returns `MEMBER_NOT_FOUND`. References and input patterns are validated; money outputs are parsed and every declared output must be present before success.

The recorder records executed actions and verifies each saved locator identifies exactly the chosen element. It prefers role/name, table row plus column, row labels, then attribute CSS; positional CSS paths are discarded. Targets are separate from steps for reuse and review. Goal-derived fill/select values always become `{{inputs.name}}`, including short values such as `50`. Longer literal values are also generalized in locators and descriptions. Secret placeholders belong to the sign-on profile, not the discovered flow.

Discovery saves drafts, bumps versions, and rejects artifacts containing known or pattern-detected sensitive values. `show` renders a readable summary. Approval is invalidated when capability content changes; it is a local review mechanism, not a cryptographic authorization service.

## 3. Determinism & error handling

Replay makes no LLM calls. It follows the artifact, checks typed inputs before launching the browser, verifies targets and checkpoints, and parses outputs. A locator must match exactly one visible element. Multiple matches stop with `target_ambiguous`; a fallback match emits `locator_degraded`. Each frame's locator ladder is evaluated in one document snapshot so navigation does not manufacture a fallback match.

Bounded polling checks failure screens first, then business outcomes, recoverable screens, and the requested checkpoint. Recoveries include dismissing a known notice, signing on again and restarting, and one extra wait for a slow load. Recovery counts are capped per condition. Automatic restarts stop after an irreversible action to avoid duplicate submission.

| Result | Meaning and context |
|---|---|
| `success` | Declared outputs, recoveries, locator warnings, human help |
| `business_outcome` | Expected code/message and step, such as no member or insufficient funds |
| `failure` | Category, retryability, step, expected/observed state, masked screenshot and redacted HTML when available |

Unknown dialogs become a failed checkpoint and can trigger handoff. Validation, permission denial, session expiry and application errors are treated explicitly. Diagnostics remain available in each run folder. Integration tests use the real fake app and Chromium, including discovery-to-replay, error handling, policy denial and handoff.

## 4. Heterogeneity & multi-tenant

`Surface` separates observing, finding, reading and acting from the recorded flow. The web implementation searches frames and understands table labels. A desktop implementation would map windows and accessibility roles to this vocabulary, add an `automationId` locator, and extend schema validation and surface construction. Pixel-only environments would need OCR/coordinates and more conservative verification. Neither desktop nor OCR support is built.

For shared vendor products, the proposed model combines a vendor/version profile, a base capability, and a tenant overlay keyed by target or step ID. Relative paths and input placeholders already support different hosts and invocation data. Overlay merging, fingerprinting and per-tenant approvals are design work, not implemented features.

The merged artifact would receive its own hash and tenant-specific approval. Screen fingerprints, degraded-locator/error rates and stability canaries would detect drift. Discovery would propose a reviewed overlay diff for an affected tenant, avoiding a full re-recording for every installation.

## 5. Escalation & handoff

Discovery requests help explicitly or after three unchanged turns or repeated action failures. Replay escalates unresolved target/check failures when enabled. Irreversible actions request approval. Requests carry a run/capability identifier, step, reason, frame locations, masked screenshot, choices and deadline. Raw discovery goals are omitted from persisted context.

`ControlTurn` holds a controller and increasing turn number. A request transfers control from automation to nobody; **Take control** transfers it to human; resolution returns it to automation. Session operations check this fencing token before acting or extracting. The operator uses the same visible Chromium window, preserving cookies and page state. Frame scripts record clicks and changes only during human control; they do not capture typed values.

Replay supports retrying, continuing from a chosen step after checking the previous checkpoint, verifying completion, or aborting. Discovery can resume with a human-action summary; manual actions are logged and flagged for review, not compiled into replay steps. Missed deadlines stop the run.

The local console has one operator, no authentication and an in-process wait. Evidence uses a clearly labelled scripted operator through the same HTTP/control/session mechanism. A production design needs remote session streaming, authenticated operators, durable leases, tenant routing and asynchronous intervention results.

## 6. Safety

Configurable policies allow origins, paths and action types. Both writes and extraction pass through Session authorization; a browser request guard adds network enforcement. Risk is raised by policy or the recorded action, never lowered by the model. Irreversible actions require approval, or stop if no operator is available. The demo-only `AUTO_CONFIRM_RISKY` override logs a warning.

Credentials are loaded from environment variables and injected at sign-on, outside the model loop. A shared redactor sanitizes persisted text, using known values and patterns for identifiers, dates, phone numbers and email. Sensitive outputs are withheld from evidence; screenshots mask profile-declared fields and password boxes. Traces are disabled.

Free-form goals are not logged or echoed by the CLI. Callers must declare names, addresses and other non-pattern goal PII using `sensitiveValues` or repeatable `--sensitive-value` flags before discovery. Model-declared sensitive fill/select values are registered before decision logging. Screen fields supply additional known values.

Limits are explicit: undeclared free-text PII cannot be reliably recognized; screenshot masking depends on the profile; discovery sends page text to the model provider; shell history is outside application logging. Production needs stronger data classification and provider retention controls. Policies do not inspect POST bodies, and the console is local and unauthenticated.

## 7. Cuts

Built stretch goals are multi-run stability and approval: at least ten successful runs, optionally paired with expected business outcomes, produce a report bound to the capability hash. Unattended replay rejects drafts.

Tenant overlays, desktop/OCR adapters, remote operator identity, queues, durable session recovery, automatic compilation of human steps, generated code and AI repair were deliberately omitted. Write-flow stability needs a controlled data-reset strategy. These cuts preserve a working discovery → artifact → deterministic replay → live handoff thread.

Next priorities are tenant overlays and drift measurement, a session broker with asynchronous handoff, authenticated remote operators, and one desktop accessibility prototype. Deployment-scale infrastructure should follow those validated seams.
