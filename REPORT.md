# REPORT — Computer-Use Automation System

**The model discovers → the recorder turns the run into a capability file → replay runs it with no model → a human can take over the same live session → every action is policy-checked and all evidence is redacted.**

The target is a deliberately legacy fake credit-union app (`apps/mock-cu`: framesets, layout tables, labels in neighbouring cells, no ids) that can inject runtime faults on demand. Evidence is in [`evidence/`](evidence/README.md); 31 tests run without an API key.

## 1. Architecture

```
goal ─▶ Discovery agent ─(recorder + lint)─▶ capability file ─▶ Replay engine ◀─ id + inputs
        observe → decide → act               (JSON, versioned)   steps · checks · recoveries
                  └──────────────┬───────────────────────────────────────┘
                                 ▼
          Session: control turn · policy · approvals · secrets · redacted log
                                 ▼
          Surface (web: Playwright, a script in each frame) ◀── same browser ── Operator console
```

| Decision | Why | Trade-off |
|---|---|---|
| **TypeScript, one Node process, CLI** | Zod types shared by recorder, replay and tests; the simplest setup that shows every piece | The browser lives inside the runner (production split in §5) |
| **Local hostile fake app** | Real runtime errors on demand; no terms-of-service or PII risk | I built both sides, so locators use only generic strategies |
| **Perception: page text with role, name, row label, column header + masked screenshot** | Works without a clean DOM or test ids; same vocabulary as OS accessibility APIs; maps straight to locators | Pixel-only surfaces need another Surface (§4) |
| **One tool call per turn, a fresh request each turn**; `claude-opus-5`, adaptive thinking | Each action can be checked, recorded and paused; tokens stay bounded; the system prompt is cached | The model sees its step history, not its earlier reasoning |
| **Record executed actions; test every locator at record time** | The artifact is separate from the transcript and known to work | Extra lookups during discovery |
| **Build replay first**, against a hand-written capability | Proves the production path independently of the model | — |

The seam is `src/surface/types.ts`: nothing above it imports Playwright. `src/session.ts` is the one choke point every action passes through.

## 2. Artifact schema

A capability (`src/capability/schema.ts`) is a **contract plus a recipe**. Trimmed from the discovered artifact:

```jsonc
{
  "id": "cu-legacy.get-savings-balance", "version": "1.0.0",
  "status": "approved", "contentHash": "sha256:05c6…",       // approval is bound to this hash
  "app": { "profile": "cu-legacy", "surface": "web", "startPath": "/cu/main" },
  "risk": "read_only",
  "inputs":  { "memberNumber": { "type": "string", "pattern": "^\\d{6}$", "sensitivity": "pii" } },
  "outputs": { "savingsBalance": { "type": "money", "sensitivity": "none" } },
  "outcomes": [ { "code": "MEMBER_NOT_FOUND", "whenTextVisible": "NO RECORDS MATCH" } ],
  "targets": {
    "memberNumberLink": { "frame": "main", "locators": [
      { "by": "role", "role": "link", "name": "{{inputs.memberNumber}}" },
      { "by": "css", "selector": "a[href=\"/cu/member?m={{inputs.memberNumber}}\"]" } ] },
    "savingsCurrentBalCell": { "frame": "main", "locators": [
      { "by": "tableCell", "row": "REGULAR SAVINGS", "column": "Current Bal" },
      { "by": "tableCell", "row": "S00", "column": "Current Bal" } ] } },
  "steps": [ /* … */ { "id": "clickMemberNumberLink", "do": { "action": "click", "target": "memberNumberLink" },
      "risk": "safe", "by": "ai",
      "then": [ { "type": "urlContains", "value": "/cu/member" },
                { "type": "targetVisible", "target": "savingsCurrentBalCell" } ] } /* … */ ],
  "finalCheck": [ { "type": "textVisible", "text": "SHARE / LOAN SUFFIXES" },
                  { "type": "outputPresent", "output": "savingsBalance" } ]
}
```

- **Contract first.** A caller only needs `inputs`, `outputs` and `outcomes`. Inputs are validated before the app is touched. `outcomes` makes "no such member" part of the contract. `sensitivity` drives redaction.
- **Targets are separate from steps.** Reviewers can see how each control is found, in words. A control used twice is described once. Targets are also the per-tenant override point (§4).
- **Locator ladder, best first:** role + name → table cell (row text + column header) → row label → attribute CSS.
  - Each locator is verified to match exactly one element when it is recorded.
  - Positional paths are never saved: after a layout change they silently point at a different row.
- **Parameterized.** Values taken from the goal become `{{inputs.x}}` everywhere, including inside locators. Credentials are `{{secrets.x}}` and live only in the app profile.
- **Every step has a check** (the next control is visible, and the page changed if it did), plus a final check.
- **Versioned and reviewable:**
  - semver version, content hash, and a draft/approved status bound to that hash
  - provenance: which run and model created it
  - `show` renders it as Markdown for reviewers
  - `lint` refuses to save anything that looks like PII

App-wide knowledge (sign-on, known screens, business messages, sensitive fields) is written once in `profiles/cu-legacy.json`. The business outcomes for pages a flow visits are copied into the capability, so the capability is self-contained.

## 3. Determinism & error handling

Replay (`src/replay/engine.ts`) runs the same steps with the same locators and no model. Every wait is a poll with a timeout. A locator must match **exactly one** visible control:
- **None:** try the next locator.
- **Two or more:** `target_ambiguous`. Replay never guesses.
- **Found by a fallback locator:** success, plus a `locator_degraded` warning. This is the drift signal.

While waiting for anything, replay checks the screen in priority order:
1. **Failure screens** (profile) → `failure: app_error`.
2. **Business outcomes** (capability) → `business_outcome`.
3. **Recoverable screens** (profile) → handled and listed in `recoveries[]`:
   - maintenance notice → click Continue
   - signed out → sign on and restart from step 1
   - slow page → one extra wait

   Each is capped at 2 per condition. **Restarts happen only before any irreversible step.** After one, replay stops with `session_lost` rather than risk doing it twice.
4. The step's own check.

| Status | Carries | Examples |
|---|---|---|
| `success` | outputs, `recoveries`, `warnings`, `humanHelp` | balance read after dismissing a maintenance notice |
| `business_outcome` | code, message, step | `MEMBER_NOT_FOUND`, `VALIDATION_REJECTED`, `INSUFFICIENT_FUNDS`, `PERMISSION_DENIED` |
| `failure` | category, retryable, step, expected, observed, masked screenshot + redacted HTML | `invalid_input`, `not_approved`, `target_not_found`, `target_ambiguous`, `check_failed`, `app_error`, `session_lost`, `policy_blocked`, `approval_required`/`approval_rejected`, `nobody_responded`, `bad_output` |

Evidence folders 02–12 show each path. Tests also cover ambiguous and degraded locators, policy blocks, and a rejected approval.

## 4. Heterogeneity & multi-tenant

**Surface seam.** `Surface` is small: observe, find, click/fill/select/press, read, findText, screenshot. The capability's vocabulary (role, name, row label, column header, visible text) is not web-specific. Only `css` is, and it is always the last locator.
- **Legacy web (built):** every frame is searched, with a frame-name hint. Tables are handled by row label and table cell.
- **Desktop:** a Windows UI Automation or macOS AX surface exposes the same role + name tree. A window plays the role of a frame, and an `automationId` locator is added. Recorder, replay, Session, policy and handoff stay unchanged.
- **Pixel-only (Citrix, 3270 green screens):** an OCR surface returns text with positions, plus a `screenField(row, col)` locator. This is the weakest surface, so expect more escalations.

**Multi-tenant (designed, not built).** The capability actually run is built from three layers:
1. **Vendor profile**, one per product version.
2. **Base capability**, recorded once (relative paths, parameterized values).
3. **Tenant overlay**: a small JSON patch keyed by target or step id. Examples: the `memberNumberBox` label is "Account Number", an extra known screen, a different base URL or policy.

The result records the hash of the merged capability.

**Managing drift:**
- Pick the profile from a version fingerprint on screen.
- Track `locator_degraded`, `target_not_found` and `check_failed` rates per capability × tenant × version.
- Run stability canaries.
- Keep approvals per tenant and hash, so one drifting tenant drops back to draft on its own.
- Fix drift by re-running discovery on that tenant to propose an overlay diff, not a new capability.

## 5. Escalation & handoff

**Detect "stuck":**
- **Discovery:** the agent calls `request_human`, the screen is unchanged for 3 turns, 3 actions fail in a row, or a click is irreversible.
- **Replay:** a target is not found or ambiguous, or a check fails (after the timeout plus one extra wait), or a step is irreversible.

**Route.** A help request carries kind, reason code and text, the capability or goal, the step, frame URLs, a masked screenshot, the allowed choices and a deadline. It is redacted, saved to `help-requests.json`, and shown on the operator console at http://127.0.0.1:4100.

**Control model** (`src/handoff/control.ts`). There is one `ControlTurn`: `{controller: automation | human | nobody, turn}`.
1. A help request hands control to `nobody` (automation paused).
2. *Take control* hands it to `human`.
3. A decision hands it back to `automation`.

The turn number goes up at every hand-over. `Session.act` checks the turn **before every action**. That makes it a fencing token: a runner holding an old turn cannot act after a human took over. Every change is logged.

**Same live session.** Automation runs a visible Chromium, and the operator works in that same window (same cookies, same page). A script in every frame reports clicks and changes by role, name and row label. They are logged as `human_action` only while a human is in control. Typed text is never captured.

**Hand back, then verify.**
- **Replay** offers:
  - `retry_step`
  - `continue_from <step>`: re-checks the previous step first
  - `mark_done`: reads outputs and runs the final check
  - `abort`

  A missed deadline gives `nobody_responded`.
- **Discovery** offers `resume` (the model is told what the human did, and the capability gets a review note) or `abort`.

**Mocked:**
- The console is a local polling page with one operator and no auth.
- An escalated replay waits in-process for the decision.
- Operator steps in `evidence/` were done by a script, and labelled as such.

**Production needs:**
- isolated browsers streamed to a remote console
- per-tenant request queues with routing and SLAs
- the control turn stored as a database lease
- operator identity recorded on every action
- an async `needs_human` result

## 6. Safety

- **Allowlist** (`policies/cu-legacy.json`): allowed origins, allowed and blocked paths, and action types.
  - Checked in `Session.act` for every action, including where a link leads.
  - A browser network guard blocks disallowed requests as a second layer.
- **Risky actions.** An action is irreversible if its name matches (confirm, submit, post, transfer…), its page is marked irreversible, or the step or model declares it. Risk can be raised, never lowered.
  - Irreversible actions **need human approval**. With no operator available they fail with `approval_required`.
  - Why approval: blocking outright would make write capabilities useless, and flagging afterwards is too late for money movement.
  - They are never retried automatically. `AUTO_CONFIRM_RISKY` exists for demos only and logs a warning.
- **Secrets** are filled in inside `act()` from the environment. Claude, capability files and logs never contain them.
- **Redaction.** One `Redactor` per run sits where all evidence is written. It covers:
  - known values: pii inputs and outputs, secrets, and text read from sensitive fields
  - patterns: SSN, card numbers, dates, phone, email, account numbers

  Screenshots mask sensitive fields. Pii outputs are never logged. Playwright traces are off. Tests and a final scan found none of the seeded PII in the evidence.
- **Limits:**
  - During discovery the model sees PII on screen; production needs zero data retention or masking.
  - Name redaction only catches names it has seen in sensitive fields.
  - The policy works at path level and does not inspect POST bodies.
  - The console has no authentication.

## 7. Cuts

**Cut on purpose:**
- tenant overlays and a second tenant app (designed in §4)
- desktop and OCR surfaces (only the seam exists)
- coordinate clicks, which can't be replayed safely
- the async `needs_human` result
- a remote, authenticated operator console
- turning human actions in discovery into steps (logged and flagged instead)
- stability runs for irreversible flows (they need a data reset between runs)
- code generation, a tool catalog, and AI repair

**Stretch goal done: stability + approval.** Stability runs N replays (happy path plus an expected business outcome) and writes a report bound to the content hash. `approve` requires that report to be stable and current. Replay refuses drafts.

**Next:**
1. Tenant overlays and per-tenant drift metrics.
2. Async `needs_human` with a session broker.
3. A remote operator console.
4. A UI Automation spike.
5. An OCR surface for green screens.
