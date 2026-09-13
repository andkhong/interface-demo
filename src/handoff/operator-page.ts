// The operator console page. Plain HTML + a little JavaScript that polls /api/state every second.

export const OPERATOR_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>Operator Console</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 0; background: #f4f4f5; color: #18181b; }
  header { background: #18181b; color: #fff; padding: 12px 20px; display: flex; justify-content: space-between; align-items: center; }
  .badge { padding: 4px 12px; border-radius: 999px; font-weight: 600; }
  .automation { background: #2563eb; } .human { background: #16a34a; } .nobody { background: #d97706; }
  main { max-width: 980px; margin: 20px auto; padding: 0 16px; }
  .card { background: #fff; border-radius: 10px; padding: 16px; margin-bottom: 16px; box-shadow: 0 1px 3px #0002; }
  .card.resolved { opacity: .65; }
  .meta { color: #52525b; font-size: 13px; }
  .reason { font-size: 16px; margin: 10px 0; }
  img { max-width: 100%; border: 1px solid #ddd; border-radius: 6px; margin-top: 12px; }
  button, select { padding: 8px 14px; border-radius: 6px; border: 1px solid #d4d4d8; background: #fff; cursor: pointer; margin: 8px 8px 0 0; font-size: 14px; }
  button.primary { background: #2563eb; color: #fff; border-color: #2563eb; }
  button.danger { background: #dc2626; color: #fff; border-color: #dc2626; }
  .error { color: #dc2626; }
  code { background: #f4f4f5; padding: 1px 4px; border-radius: 4px; }
</style></head>
<body>
<header><strong>Operator Console</strong><span id="control" class="badge">connecting...</span></header>
<main><p id="error" class="error"></p><div id="requests"></div></main>
<script>
const LABELS = {
  approve: "Approve", reject: "Reject", resume: "Resume automation",
  retry_step: "Retry this step", mark_done: "I finished the task - check it and read outputs", abort: "Abort the run"
};
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => "&#" + c.charCodeAt(0) + ";");
let last = "";

async function post(url, body) {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) });
  document.getElementById("error").textContent = res.ok ? "" : (await res.json()).error;
  refresh();
}

function decisionButtons(r) {
  return r.choices.map((choice) => {
    if (choice === "continue_from") {
      const options = r.stepIds.map((s) => "<option>" + esc(s) + "</option>").join("");
      return '<span>Continue from step <select id="step-' + r.id + '">' + options + '</select>' +
        '<button onclick="post(\\'/api/requests/' + r.id + '/resolve\\', {choice: \\'continue_from\\', stepId: document.getElementById(\\'step-' + r.id + '\\').value})">Continue</button></span>';
    }
    const style = choice === "abort" || choice === "reject" ? "danger" : "primary";
    return '<button class="' + style + '" onclick="post(\\'/api/requests/' + r.id + '/resolve\\', {choice: \\'' + choice + '\\'})">' + LABELS[choice] + '</button>';
  }).join("");
}

function card(r) {
  let actions = "";
  if (r.status === "open" && r.kind === "stuck") {
    actions = "<p>Take control, fix the problem in the automation's browser window, then come back here to hand control back.</p>" +
      '<button class="primary" onclick="post(\\'/api/requests/' + r.id + '/claim\\')">Take control</button>';
  } else if (r.status === "open" && r.kind === "approval") {
    actions = decisionButtons(r) + '<button onclick="post(\\'/api/requests/' + r.id + '/claim\\')">Take control to inspect first</button>';
  } else if (r.status === "claimed") {
    actions = "<p><b>You are in control.</b> Work in the browser window. Your clicks are recorded (typed text is not). When you are done, choose:</p>" + decisionButtons(r);
  }
  const main = (r.observed.frames.find((f) => f.name === "main") || r.observed).url;
  return '<div class="card ' + r.status + '">' +
    '<div class="meta">' + esc(r.id) + " · " + esc(r.mode) + " · " + esc(r.subject) + " · " + esc(r.createdAt) + " · <b>" + esc(r.status) + "</b></div>" +
    '<div class="reason"><b>' + esc(r.reasonCode) + "</b>: " + esc(r.reason) + "</div>" +
    '<div class="meta">Step: ' + (r.step ? esc(r.step.id + " - " + r.step.intent) : "-") + " · Page: <code>" + esc(main) + "</code></div>" +
    actions +
    (r.resolution ? '<p class="meta">Resolved with: <b>' + esc(r.resolution.choice) + "</b></p>" : "") +
    '<img src="' + r.screenshotUrl + '" alt="screenshot when help was requested">' +
    "</div>";
}

async function refresh() {
  try {
    const state = await (await fetch("/api/state")).json();
    const json = JSON.stringify(state);
    if (json === last) return;
    last = json;
    const badge = document.getElementById("control");
    badge.textContent = "In control: " + state.control.controller + " · turn " + state.control.turn;
    badge.className = "badge " + state.control.controller;
    document.getElementById("requests").innerHTML =
      state.requests.map(card).join("") || '<p class="meta">No help requests. Automation is running.</p>';
  } catch {
    document.getElementById("control").textContent = "run finished (console offline)";
  }
}
refresh();
setInterval(refresh, 1000);
</script>
</body></html>`;
