# Computer-Use Automation System

The first time, an AI works out how to do a task in a legacy app that has no API. That successful run is saved as a typed, versioned **capability**, which then **replays deterministically with no model in the loop**. Replay handles runtime errors and follows safety rules, and a human can take over the live session when automation gets stuck.

- **Design write-up:** [REPORT.md](REPORT.md)
- **Evidence of real runs:** [evidence/](evidence/README.md)
- **Presentation and study guide:** [STUDY_GUIDE.md](STUDY_GUIDE.md)

```
goal ─▶ discover (Claude drives the app) ─▶ capability file ─▶ replay (no AI) ─▶ success | business outcome | failure
                                                                   └─▶ stuck? ─▶ operator takes over the same browser ─▶ hands back
```

## Setup

You need Node.js 22.12+ or 24+ (tested on 24).

```bash
npm install
npx playwright install chromium
cp .env.example .env        # then set ANTHROPIC_API_KEY (only needed for `discover`)
```

| Variable | Needed for | Default |
|---|---|---|
| `ANTHROPIC_API_KEY` | `discover` (the real AI run) | — |
| `ANTHROPIC_WORKSPACE_ID` | only if your key is not scoped to a workspace | — |
| `ANTHROPIC_MODEL` / `ANTHROPIC_EFFORT` | `discover` | `claude-opus-5` / `medium` |
| `CU_TELLER_ID` / `CU_TELLER_PASSWORD` | signing on to the fake app | `teller01` / `Legacy-Demo-2026!` |
| `AUTO_CONFIRM_RISKY` | skip human approval of irreversible steps (**local demo only**) | `false` |
| `MOCK_BANK_APP_PORT` / `OPERATOR_PORT` | ports | `4000` / `4100` |

## Run without live services (no API key)

```bash
npm test            # unit tests + real headless-browser tests against the fake app (~75 s)
npm run typecheck
```

- The capabilities in `capabilities/` are checked in, so every `replay`, `show`, `stability` and handoff command below works without a key.
- Commands start the fake app automatically if nothing is listening on port 4000. You can also run `npm run app` yourself.
- Replay is headless by default; add `--headed` to watch it.

## Demo path

### 1. Discover (a real Claude run)

```bash
npm run cua -- discover --name get-savings-balance-demo \
  --goal "Look up member 100234 and read their current savings balance"
```

1. A Chromium window opens and signs on using the stored credentials. The password is filled outside the model loop.
2. Claude drives the app one action per turn (about 6 turns).
3. The capability is saved to `capabilities/cu-legacy.get-savings-balance-demo/<version>.json`.
4. The evidence goes to `runs/<runId>/`: `events.jsonl`, `transcript.jsonl`, and masked screenshots.

Discovery always saves a **draft**. Repeating the same name creates the next minor version (e.g. `1.1.0`). The command prints the version, path and replay input names. The separate `-demo` name keeps the checked-in examples available for the later commands.

**Goal privacy:** free-form goals are not written to logs or echoed by the CLI. If a goal contains a name, address, or other PII that pattern matching cannot recognize, declare it with repeatable `--sensitive-value` arguments (programmatic API: `sensitiveValues`). These values are registered before any model response is logged, so echoes are redacted too. Do not put credentials in goals; use the environment. Undeclared free-text PII cannot be reliably identified. Use synthetic values for this demo; shell history is outside the application's logging controls.

### 2. Review the capability

```bash
npm run cua -- show cu-legacy.get-savings-balance-demo
```

### 3. Replay it (no AI)

```bash
npm run cua -- replay cu-legacy.get-savings-balance-demo --allow-draft --input memberNumber=100587
```

- This prints the result contract as JSON: `success` with `outputs.savingsBalance`.
- This command uses `--allow-draft` because you just discovered it. If `show` lists a different input name, replace `memberNumber` with that name.
- For an exact offline demo without discovery, use the approved example: `npm run cua -- replay cu-legacy.get-savings-balance@1.0.0 --input memberNumber=100587`.
- The remaining commands use the checked-in capability, not the newly discovered `-demo` capability.

### 4. Errors and exceptional states

Use `npm run cua -- replay cu-legacy.get-savings-balance@1.0.0` followed by one of these argument sets:

| Arguments | Result |
|---|---|
| `--input memberNumber=999999` | `business_outcome` `MEMBER_NOT_FOUND` (an answer, not a crash) |
| `--input memberNumber=12AB` | `failure` `invalid_input`, before the app is opened |
| `--input memberNumber=100234 --fault interstitial,session_timeout,slow` | `success`, with 3 `recoveries` |
| `--input memberNumber=100234 --fault app_error` | `failure` `app_error` + masked screenshot + redacted HTML in the run folder |
| `--input memberNumber=100234 --fault unknown_dialog` | `failure` `check_failed` (see step 5 for the human path) |

### 5. Human handoff on the live session

```bash
npm run cua -- replay cu-legacy.get-savings-balance@1.0.0 --input memberNumber=100234 --fault unknown_dialog --escalate
```

1. After about 20 s (the step timeout plus one extra wait), the terminal prints **HUMAN HELP NEEDED** and the console URL. Open **http://127.0.0.1:4100**.
2. Click **Take control**. The badge changes to *In control: human*.
3. In the automation's Chromium window, click **Acknowledge** on the MEMBER ALERT.
4. Back in the console, choose **Continue from step** `extractSavingsCurrentBalCell`, then **Continue**.
5. Replay checks the screen, reads the balance and prints `success` with `humanHelp`. The run's `events.jsonl` shows `control_changed` (automation → nobody → human → automation) and your `human_action` clicks.

### 6. Irreversible flow (needs approval)

```bash
npm run cua -- show cu-legacy.open-sub-account@1.0.0
npm run cua -- replay cu-legacy.open-sub-account@1.0.0 --allow-draft --escalate \
  --input memberId=100587 --input product="S20 - HOLIDAY CLUB" --input openingDeposit=250.00 --input fundFromSuffix="S00 - REGULAR SAVINGS"
```

1. Replay stops before **Confirm** and asks for approval.
2. Click **Approve** in the console. Replay clicks Confirm and reads the confirmation number.
3. Without `--escalate`, the same command stops with `approval_required` and nothing is submitted.

(Input names can differ after a new discovery; `show` lists them.)

### 7. Stability and approval (stretch goal)

```bash
npm run cua -- stability cu-legacy.get-savings-balance@1.0.0 --input memberNumber=100234 --runs 10 \
  --expect-outcome memberNumber=999999:MEMBER_NOT_FOUND
npm run cua -- approve cu-legacy.get-savings-balance@1.0.0 --by "Your Name"
```

- `approve` refuses unless the stability report is `stable` **and** was made for the current content hash.
- Replay refuses drafts unless you pass `--allow-draft`.

### Regenerate all evidence

```bash
npm run evidence                # replays, recoveries, failures, handoff, stability (no API key)
npm run evidence -- --with-ai   # also the two real Claude discovery runs
```

In the evidence runs, operator steps are performed **by the script**: it calls the console's HTTP API and clicks in the same live page, and each decision is labelled "scripted operator". To do those steps by hand, follow steps 5 and 6.

## The fake app (`apps/mock-cu`)

- **Start it:** `npm run app` → http://localhost:4000, teller `teller01` / `Legacy-Demo-2026!`.
- **What it looks like:** deliberately legacy. It uses a `<frameset>` (banner, menu, main), layout tables, labels in the neighbouring `<td>`, `fld_03`-style field names and no ids.
- **Flows:**
  - Member Inquiry → results → member detail (balances)
  - Open Sub-Account → review → **Confirm** (irreversible)
- **Errors caused by inputs:** unknown member, bad amount, amount over the teller limit, insufficient funds.
- **Injected faults** (a cookie set by `--fault`, each fires once):

| Fault | What happens |
|---|---|
| `interstitial` | a maintenance notice with a Continue link |
| `session_timeout` | signs you out ("SESSION EXPIRED") |
| `slow` | member detail takes 12 s |
| `app_error` | a 500 "SYSTEM ERROR" page |
| `unknown_dialog` | a "MEMBER ALERT" that must be acknowledged |

  To try a fault by hand in a browser, open `/__faults?set=slow`.

## CLI

`npm run cua -- <command>`:
- `discover`
- `replay`
- `show`
- `list`
- `stability`
- `approve`
- `app`

Run `npm run cua` with no arguments for all options.

**Exit codes:** `0` for success or a business outcome; `1` for a failure or a stopped discovery.

## Project layout

```
apps/mock-cu/          fake legacy credit-union app (+ fault switch)
profiles/cu-legacy.json   app-wide knowledge: sign-on, known screens, business messages, sensitive fields
policies/cu-legacy.json   allowlist + irreversible rules
capabilities/          saved capability files (+ readable .md, stability reports)
src/surface/           eyes & hands: Surface interface, web implementation, in-page scripts
src/session.ts         act/read: control turn, policy, approval, secrets, logging
src/agent/             discovery loop, tools, prompt, Claude + scripted models
src/recorder/          executed actions -> capability (verified locators, inputs, checks, outcomes)
src/capability/        schema (Zod), store (versions, hash, approval state), lint, show, templates
src/replay/            deterministic replay engine + result contract
src/handoff/           control turn, help requests, operator console
src/safety/            policy checks, redaction
src/evidence/          run logger (all writes are redacted)
src/stability/         stability runs + approval
scripts/evidence.ts    regenerates evidence/
tests/                 unit + integration (real browser, fake app, scripted model)
```

## What is mocked

- **The target app** is a local fake. No real bank system was used, and all data is synthetic.
- **The operator console** is a minimal local page with no authentication, and escalated replays wait in-process. REPORT.md §5 describes the production design.
- **Operator actions in `evidence/`** were done by the evidence script, labelled as such. The mechanism they use (control turn, same live page, recorded human actions) is the real one.
