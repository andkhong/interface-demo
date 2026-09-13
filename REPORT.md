# REPORT — Computer-Use Automation System

**The model discovers → the recorder turns the run into a capability file → the replay engine runs it with no model in the loop → a human can take over the same live session → everything is checked against policy and redacted before it touches disk.**

Everything described here runs against a deliberately legacy fake credit-union app (`apps/mock-cu`: framesets, layout tables, labels in neighbouring cells, generated field names, no ids). The app can inject runtime faults on demand. Evidence for every claim is in [`evidence/`](evidence/README.md), and 31 tests cover it without an API key.

## 1. Architecture

```
  goal ──▶ Discovery agent ──(recorder + lint)──▶ capability file ──▶ Replay engine ◀── capability id + inputs
           observe → decide → act                 (JSON, versioned)   steps · checks · recoveries
                     │                                                        │
                     └───────────────┬────────────────────────────────────────┘
                                     ▼
          Session = Surface + rules: control turn · policy · approvals · secrets · evidence log
                                     │
                     Surface (web: Playwright + page script per frame)  ◀── same live browser ──  Operator console
```

| Decision | Choice | Why | Trade-off |
|---|---|---|---|
| Runtime | TypeScript, one Node process, CLI | Zod types are shared by the recorder, replay and tests; Playwright is first-class in Node | The browser lives inside the runner. Production would split the two (see §5) |
| Target | Local fake app built to be hostile, with a fault switch | Real runtime errors on demand; no terms-of-service or PII risk | I built both sides. To avoid tailoring, locators use only generic strategies (role, row label, column header) |
| Perception | Page text of every frame with **role, name, row label and column header**, plus a masked screenshot | Works without a clean DOM or test ids. Uses the same vocabulary a screen reader or OS accessibility API exposes | Pixel-only surfaces need a different Surface implementation (§4) |
| Agent loop | One tool call per turn. Each turn is a fresh request: goal + history of results + current screen. Strict tool schemas | Each action can be policy-checked, recorded, paused. Tokens stay bounded; the stable system prompt is cached | The model sees its own step history, not its earlier reasoning |
| Model | `claude-opus-5` (override with `ANTHROPIC_MODEL`), adaptive thinking, effort `medium` | Discovery happens once per flow, so reliability matters more than cost; replay has no model cost | Slower turns (seconds each) |
| Recording | Built from **executed** actions. Every locator is **tested at record time** and kept only if it finds exactly that element | The artifact is decoupled from the transcript and replays for real | Needs one extra lookup per locator during discovery |
| Build order | Replay first, against a hand-written capability; AI second | Proves the production path independently of the model | — |

The seam that matters is `src/surface/types.ts`. Nothing above it imports Playwright. `Session` (`src/session.ts`) is the single choke point every action goes through.

## 2. Artifact schema

A capability is a **contract plus a recipe** (`src/capability/schema.ts`, `capability/1`). This excerpt is trimmed from the discovered artifact in `evidence/`:

```jsonc
{
  "schemaVersion": "capability/1", "id": "cu-legacy.get-savings-balance", "version": "1.0.0",
  "status": "approved", "contentHash": "sha256:05c6…",
  "approval": { "by": "…", "contentHash": "sha256:05c6…", "stability": "10/10 succeeded, 10/10 returned MEMBER_NOT_FOUND" },
  "createdFrom": { "kind": "discovery", "runId": "discovery_…", "model": "claude-opus-5" },
  "app": { "profile": "cu-legacy", "surface": "web", "startPath": "/cu/main" },   // relative: tenant supplies base URL
  "risk": "read_only",
  "inputs":  { "memberNumber": { "type": "string", "pattern": "^\\d{6}$", "sensitivity": "pii" } },
  "outputs": { "savingsBalance": { "type": "money", "sensitivity": "none" } },
  "outcomes": [ { "code": "MEMBER_NOT_FOUND", "whenTextVisible": "NO RECORDS MATCH" },
                { "code": "VALIDATION_REJECTED", "whenTextVisible": "INVALID MEMBER # FORMAT" } ],
  "targets": {
    "memberNumberLink": { "frame": "main", "locators": [
        { "by": "role", "role": "link", "name": "{{inputs.memberNumber}}" },
        { "by": "css", "selector": "a[href=\"/cu/member?m={{inputs.memberNumber}}\"]" } ] },
    "savingsCurrentBalCell": { "frame": "main", "locators": [
        { "by": "tableCell", "row": "REGULAR SAVINGS", "column": "Current Bal" },
        { "by": "tableCell", "row": "S00", "column": "Current Bal" } ] }
  },
  "steps": [ /* … */ { "id": "clickMemberNumberLink", "intent": "Open the member's account detail from the results list",
               "do": { "action": "click", "target": "memberNumberLink" }, "risk": "safe", "by": "ai",
               "then": [ { "type": "urlContains", "value": "/cu/member" },
                         { "type": "targetVisible", "target": "savingsCurrentBalCell" } ], "timeoutMs": 10000 } /* … */ ],
  "finalCheck": [ { "type": "textVisible", "text": "SHARE / LOAN SUFFIXES" }, { "type": "outputPresent", "output": "savingsBalance" } ],
  "reviewNotes": []
}
```

Why it is shaped this way:

- **Contract first.** Calling agents need `inputs`, `outputs` and `outcomes` and nothing else.
  - Typed inputs are validated **before** the app is touched.
  - `outcomes` names the legitimate business answers, so "no such member" is part of the contract, not an exception.
  - `sensitivity` on every field drives redaction.
- **Targets are separate from steps.**
  - A reviewer can see how each control is found, in words ("`Current Bal` column of the `REGULAR SAVINGS` row").
  - A control used twice is described once.
  - Targets are the natural override point for another tenant (§4).
- **Locator ladder, best first:** `role`+name → `tableCell` (row text + column header) → `rowLabel` (label in the same row) → attribute `css`.
  - These are what an operator sees, so they are the things that change least.
  - Positional paths (`tr:nth-child(3)`) are **never saved**: after a layout change they silently point at a different row, and a wrong balance is worse than a failure.
- **Parameterized, not literal.**
  - Values the model marked as goal inputs become `{{inputs.x}}` everywhere they appear, including in locators (the member link above).
  - Credentials are `{{secrets.x}}` and live only in the app profile.
- **Every step has a check.** "The next step's control is visible", plus "the page changed" when it did. The final check is visible success text plus every output read.
- **Versioned and reviewable.**
  - `version` is semver: changing the contract means a major bump.
  - `contentHash` is sha256 of the canonical content, excluding status and approval.
  - `status` is draft or approved, and approval is only valid while the hash matches.
  - `npm run cua -- show <id>` renders the file as Markdown for review.
  - `lint` refuses to save any artifact containing something that looks like PII.

App-wide knowledge lives in an **app profile** (`profiles/cu-legacy.json`), not in each capability:
- sign-on steps
- known screens (session expired, maintenance notice, system error)
- business messages
- which fields are sensitive

When a flow is recorded, the business outcomes for the pages it visited are copied into the capability, so the contract is self-contained.

## 3. Determinism & error handling

**Determinism.** Replay (`src/replay/engine.ts`) runs the same steps with the same locators and no model. Every wait is a poll with a timeout. A locator must match **exactly one** visible control:
- **Zero matches:** try the next locator.
- **Two or more:** `target_ambiguous`. Replay never guesses.
- **Match via a fallback locator:** allowed, but reported as a `locator_degraded` warning. This is the drift signal.

**While waiting for anything**, the engine looks at the whole screen, in priority order:

1. **Failure screens** from the profile, e.g. `SYSTEM ERROR` → `failure: app_error`.
2. **Business outcomes** from the capability, e.g. `NO RECORDS MATCH` → `business_outcome: MEMBER_NOT_FOUND`.
3. **Recoverable screens** from the profile, which it handles and records in `recoveries[]`:
   - maintenance notice → click Continue
   - session expired / signed out → sign on and restart from step 1
   - slow response → one extra wait period

   Each recovery is capped at 2 per run. **Sign on and restart is only allowed before any irreversible step**; after one, the run stops with `session_lost` rather than risk doing it twice.
4. The step's own check.

**Result contract** (`src/replay/result.ts`):

| Status | Meaning | Examples |
|---|---|---|
| `success` | outputs + `recoveries[]` + `warnings[]` | balance read after dismissing a maintenance notice |
| `business_outcome` | a real answer the caller must act on | `MEMBER_NOT_FOUND`, `VALIDATION_REJECTED`, `INSUFFICIENT_FUNDS`, `PERMISSION_DENIED` |
| `failure` | `category`, `retryable`, `step`, `expected`, `observed` (URL, frames, redacted visible text), evidence (masked screenshot + redacted HTML per frame) | `invalid_input` (before opening the browser), `not_approved`, `target_not_found`, `target_ambiguous`, `check_failed`, `app_error`, `session_lost`, `policy_blocked`, `approval_required`/`approval_rejected`, `nobody_responded`, `bad_output` |

Demonstrated in `evidence/` (folders 02–12):
- success for a different member than the one discovered
- member not found
- invalid input
- maintenance notice + session timeout + slow page recovered in one run
- application error with evidence
- draft refused
- unknown screen handed to a human
- irreversible step refused without an operator, and approved with one

Integration tests also cover an ambiguous locator, a degraded locator, a policy block, and an operator rejecting an irreversible step.

**Drift (secondary).** Because the UI is stable, drift shows up first as `locator_degraded` warnings and in stability reports (§7 stretch). A broken or ambiguous locator fails loudly with the step, what was expected and what was seen. It never falls back to guessing.

## 4. Heterogeneity & multi-tenant

**Surface seam.** `Surface` is a small interface: observe, find(target), click/fill/select/press, readText, findText, screenshot, page snapshot. The capability's vocabulary is **role, name, row label, column header and visible text**, which is not web-specific. Only the `css` locator is web-only, and it is always the last fallback.

- **Legacy web:** what is built. Framesets are handled by searching every frame, with a frame-name hint; table layouts by `rowLabel` and `tableCell`.
- **Desktop apps:** a `UiaSurface` over Windows UI Automation (or macOS AX), which exposes the same ControlType/Name tree.
  - `find` walks that tree; the window title plays the role of the frame.
  - Add an `automationId` locator kind as a desktop-only fallback.
  - The recorder, replay engine, Session, policy and handoff do not change.
- **Pixel-only (Citrix, 3270/5250 green screens):** an OCR surface that turns the screen into text with positions.
  - `rowLabel` becomes "the field to the right of this label".
  - Green screens get a `screenField(row, col)` locator, which is stable there because the layout is a fixed grid.
  - This is the weakest surface, so expect more escalations.

**Multi-tenant reuse (designed, not built).** An effective capability is built from three layers:

1. **Vendor app profile per product version:** known screens, sign-on, business messages, sensitive fields.
2. **Base capability:** recorded once on a reference tenant. It already uses a relative `startPath` and parameterized values.
3. **Tenant overlay:** a small JSON merge-patch keyed by target and step ids. Examples:
   - `targets.memberNumberBox.locators[0].label = "Account Number"`
   - an extra known screen
   - a different base URL and policy

The replay result would record the hash of the effective (merged) artifact.

**Managing drift per tenant:**
- Detect the vendor version from a banner or about-screen fingerprint, and use that to pick the profile.
- Track `locator_degraded`, `target_not_found` and `check_failed` rates per (capability, tenant, version).
- Run stability canaries on test members.
- Make approval per tenant and per effective hash, so a drifting tenant drops back to draft without affecting the others.
- Fix drift by re-running discovery **on that tenant** and proposing an overlay *diff* for review, not a new capability.

## 5. Escalation & handoff

**Detecting "stuck":**
- **Discovery:**
  - the agent calls `request_human`
  - the screen is unchanged for 3 turns
  - 3 actions fail in a row
  - an irreversible click needs approval
- **Replay:**
  - `target_not_found`, `target_ambiguous` or `check_failed`, after the timeout plus one extra wait
  - an irreversible step needs approval

**Routing.** A `HelpRequest` contains:
- id and kind (`stuck` / `approval`)
- `reasonCode` and reason
- the capability@version or goal
- the current step and the list of step ids
- the frame URLs
- a masked screenshot
- the allowed choices
- a deadline

It is saved to `help-requests.json` in the run folder and shown on the operator console (http://127.0.0.1:4100).

**Control-transfer model** (`src/handoff/control.ts`). There is one `ControlTurn`: `{controller: automation | human | nobody, turn}`.

1. Raising a request hands control to `nobody`, which pauses automation.
2. *Take control* hands it to `human`.
3. A decision hands it back to `automation`, and the turn number goes up each time.

Automation holds a turn number, and `Session.act` checks it **before every action**. That is a fencing token: a runner holding an old turn physically cannot act after a human took over, even once control has come back. Every transition is logged as `control_changed`.

**Same live session.** Automation runs a visible Chromium. The operator works **in that window**, with the same cookies, frames and page state. A capture script injected into every frame reports clicks and changes, described by role, name and row label. They are logged as `human_action` only while `controller = human`. Typed text is never captured, only its length.

**Handing back — trust but verify.** Replay offers four choices:
- `retry_step`
- `continue_from <step>`: the engine first re-checks the previous step's checks, and fails if the screen doesn't match
- `mark_done`: the engine reads the outputs and runs the final check
- `abort`

A missed deadline gives `nobody_responded`. After any human help on an irreversible capability, automatic restarts are disabled. Discovery offers `resume` (the model is told what the human did, and the capability gets a review note) or `abort`.

**Mocked, and what production needs:**
- **Built here:** a local polling page, one operator on the same machine, no auth. `replay --escalate` waits in-process for the operator's decision.
- **Production needs:**
  - browsers in isolated containers, streamed to a remote console (CDP screencast or noVNC) with input forwarding
  - a per-tenant request queue with routing, paging and SLAs
  - the control turn stored as a lease in a database
  - operator identity on every human action
  - an async result, `needs_human` + request id, so callers don't block

## 6. Safety

- **Allowlist** (`policies/cu-legacy.json`): allowed origins (the tenant's base URL), allowed and blocked path prefixes (`/cu/admin`), and allowed action types.
  - It is checked in `Session.act` for **every** action: AI, replay, sign-on and recovery clicks. For links, the destination is checked too.
  - A browser network guard aborts any request to a disallowed URL as a second layer. Tests cover both layers with the "System Admin" menu link.
- **Risky actions.** An action is irreversible if any of these say so:
  - the name pattern (confirm, submit, post, transfer, …)
  - a page rule (the review page)
  - the declared risk: the model or capability can **raise** risk, never lower it

  Irreversible actions **need human approval**. With no operator available, they fail with `approval_required`.
  - Why approval rather than the alternatives: blocking outright would make write capabilities useless, and flagging after the fact is too late for money movement.
  - Irreversible steps are never retried or restarted automatically.
  - `AUTO_CONFIRM_RISKY=true` exists only for local demos and emits a warning event.
- **Secrets.** `{{secrets.tellerPassword}}` is filled in inside `act()` from the environment. Claude never sees it, capabilities never contain it, and logs show `[secret]`.
- **Redaction.** One `Redactor` per run sits at the evidence sink: events, transcript, result, HTML snapshots and help requests. It covers:
  - (a) known values: pii inputs and outputs, secrets, and text read from sensitive fields (Member #, Name, SSN, Birth Date, Address, Phone)
  - (b) patterns: SSN, Luhn-valid card numbers, dates, phone numbers, emails, 6–17 digit account numbers

  Screenshots mask sensitive fields and password boxes. Outputs marked `pii` are returned to the caller but never logged. Playwright traces are off because they capture raw DOM. Tests search the evidence for the seeded SSN, name, member number and password.
- **Limits:**
  - During discovery the model sees page text, including PII, on screen. Production needs zero-retention or private deployment, or text masking with synthetic values.
  - Name redaction only works for names the run has seen in sensitive fields.
  - The policy works at path level: it does not inspect POST bodies.
  - The operator console has no authentication.
  - The fault cookie is a test hook that exists only in the fake app.

## 7. Cuts

**Cut on purpose:**
- **Multi-tenant overlays** and a second tenant variant of the app (design in §4).
- **Desktop and OCR surfaces:** only the seam exists.
- **Coordinate clicks** in discovery: they can't be replayed safely.
- **Async `needs_human` results:** escalation blocks in-process.
- **A remote, authenticated operator console.**
- **Turning human actions from discovery into steps:** they are logged and flagged instead.
- **Stability runs for irreversible capabilities:** that needs a data reset between runs.
- **Code generation, an MCP/tool catalog, and AI-assisted repair.**

**Stretch goal done:** stability + approval. `stability` replays N times, happy path plus an expected business outcome, and writes a report bound to the content hash. `approve` refuses unless that report is stable and matches the current hash. Replay refuses drafts unless run with `--allow-draft`.

**Next, in order:**
1. Tenant overlays plus drift metrics per tenant and version.
2. The `needs_human` async API with a session broker that owns browsers.
3. A remote operator console.
4. A UI Automation surface spike on a real desktop app.
5. An OCR surface for green screens.
