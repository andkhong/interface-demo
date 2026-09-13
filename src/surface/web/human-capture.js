// Installed in every frame. Reports what happens in the page so we can record what a HUMAN did
// while they were in control (the Session ignores events while automation is in control).
// Typed text is never reported - only which box changed and how many characters it has.
(() => {
  if (window.__cuaHumanCapture) return;
  window.__cuaHumanCapture = true;

  function send(type, el, detail) {
    if (typeof window.__cuaHumanEvent !== "function") return;
    let info = { role: null, name: "", rowLabel: null };
    try {
      if (el && window.__cua) info = window.__cua.describeElement(el);
    } catch {
      // describing is best effort
    }
    window.__cuaHumanEvent({ type, frame: window.name || "top", url: location.href, ...info, detail: detail || "" });
  }

  document.addEventListener(
    "click",
    (e) => {
      const el = e.target instanceof Element ? e.target.closest("a, button, input, select, textarea, td, th") : null;
      if (el) send("click", el);
    },
    true,
  );

  document.addEventListener(
    "change",
    (e) => {
      const el = e.target;
      if (!(el instanceof Element)) return;
      if (el.tagName.toLowerCase() === "select") {
        const option = el.selectedOptions[0];
        send("change", el, `selected "${option ? option.text.trim() : ""}"`);
      } else {
        send("change", el, `typed ${String(el.value || "").length} characters`);
      }
    },
    true,
  );

  window.addEventListener("load", () => send("page", null, ""));
})();
