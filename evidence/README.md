# Evidence

Everything in this folder was produced by `npm run evidence -- --with-ai` ([`scripts/evidence.ts`](../scripts/evidence.ts)) against the local fake app. [`runs-index.json`](runs-index.json) lists every scenario with its outcome.

These checked-in runs preserve the original discovery evidence. `npm run evidence` refreshes the offline replay scenarios, including write approval, while retaining the real-discovery folders and their index entries. Current discovery logging omits the free-form goal and redacts declared sensitive goal values before any model response is persisted.

## Scenarios

| Folder | Requirement | What it shows | Result |
|---|---|---|---|
| [`01-discovery-get-savings-balance`](01-discovery-get-savings-balance/) | 3.1 · 3.2 · 3.5 | **A genuine Claude run.** Goal → observe/decide/act turns → saved capability. `transcript.jsonl` holds every prompt (screen text) and response. | saved `cu-legacy.get-savings-balance@1.0.0` in 6 turns |
| [`02-replay-success`](02-replay-success/) | 3.3 | Replay with no model, for a **different member** than the one used in discovery. | `success`, savingsBalance 8210.95 |
| [`03-replay-business-outcome-not-found`](03-replay-business-outcome-not-found/) | 3.3 | `MEMBER_NOT_FOUND` returned as a business outcome, not a failure. | `business_outcome` MEMBER_NOT_FOUND at `clickInquireButton` |
| [`04-replay-invalid-input`](04-replay-invalid-input/) | 3.3 | Inputs checked against the schema; the browser is never opened. | `failure` invalid_input |
| [`05-replay-recovered-runtime-conditions`](05-replay-recovered-runtime-conditions/) | 3.3 | Maintenance notice dismissed; session timeout → sign on and restart; slow page → extra wait. | `success`; recoveries: maintenance_notice, session_expired, slow_response |
| [`06-replay-app-error`](06-replay-app-error/) | 3.3 · 3.5 | Hard failure with step, expected and observed, plus a masked screenshot (`screenshots/`) and redacted HTML (`pages/`). | `failure` app_error at `clickMemberNumberLink` |
| [`07-replay-refused-draft`](07-replay-refused-draft/) | stretch | A draft capability is refused for unattended replay. | `failure` not_approved |
| [`08-stability-then-approved-replay`](08-stability-then-approved-replay/) | stretch | Stability report (10 happy-path + 10 not-found replays) → approved, bound to the content hash → replay runs without `--allow-draft`. | stable (10/10 success, 10/10 MEMBER_NOT_FOUND) → approved replay `success` |
| [`09-replay-human-handoff`](09-replay-human-handoff/) | 3.6 | Unknown screen → help request → operator **takes control of the same live session** → clicks Acknowledge → hands back (`continue_from`) → replay verifies the screen and finishes. The `slow_response` recovery is the extra wait taken before help was requested. | `success`; human help: continue_from |
| [`10-discovery-open-sub-account-with-approval`](10-discovery-open-sub-account-with-approval/) | 3.1 · 3.4 · 3.6 | **A genuine Claude run** on an irreversible flow. The Confirm click waited for operator approval. | saved `cu-legacy.open-sub-account@1.0.0` in 12 turns |
| [`11-replay-irreversible-without-operator`](11-replay-irreversible-without-operator/) | 3.4 | No operator available; replay stops **before** clicking Confirm. | `failure` approval_required at `clickConfirmButton` |
| [`12-replay-irreversible-approved`](12-replay-irreversible-approved/) | 3.4 · 3.6 | Same replay with an operator: approval requested → approved → confirmation number read. | `success`, confirmationNumber read |
| [`capabilities/`](capabilities/) | 3.2 | The saved capability files, with readable summaries. | |

## How to read a run folder

| File | What it is |
|---|---|
| `events.jsonl` | One redacted line per event, e.g. `observed`, `ai_decided`, `policy_checked`, `acted`, `target_found`, `recovered`, `help_requested`, `control_changed`, `human_action`, `failed`, `run_finished`. |
| `result.json` | The result contract returned to the caller. Outputs marked sensitive are replaced. |
| `transcript.jsonl` | Discovery only: screen/history and model responses, redacted. Current runs omit the free-form goal. |
| `capability.json` / `capability.md` | Discovery only: the capability that run produced. |
| `screenshots/` | Masked screenshots: every discovery turn, and failures and help requests during replay. |
| `pages/` | Redacted HTML of each frame at the moment of failure. |
| `help-requests.json` | What the operator was shown and how each request was resolved. |
| `operator-console-*.png` | The operator console during a handoff or approval. |
| `*.stability.json` | The stability report the approval was based on. |

## Notes

- **Operator steps here were performed by the evidence script.** It acts as the operator through the console's HTTP API and clicks in the same live page, and each decision carries the note "scripted operator". The mechanism is the real one: control turn, same session, recorded `human_action`s. [README.md](../README.md) steps 5–6 show how to do it by hand.
- **All data is synthetic.** Even so, evidence is redacted as if it were real. Masked fields in screenshots show as solid blocks.
