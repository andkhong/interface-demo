// A deliberately old-fashioned credit-union back-office app ("CU*LEGACY").
//
// It imitates what legacy bank software looks like to automation:
//   - a <frameset> (banner + menu + main frame)
//   - layout tables, labels in the neighbouring <td> instead of <label>
//   - generated field names (fld_03), no ids, no test ids
//
// It can also be told to misbehave, so replay error handling can be demonstrated.
// Faults are armed with a cookie `cu_fault=<fault>.<fault>` and each one fires ONCE:
//   session_timeout  search results page logs you out ("SESSION EXPIRED")
//   interstitial     inquiry page shows a maintenance notice with a Continue link
//   slow             member detail page takes 12 seconds
//   app_error        member detail page returns a 500 "SYSTEM ERROR"
//   unknown_dialog   member detail page shows a "MEMBER ALERT" that must be acknowledged

import express, { type Request, type Response, type NextFunction } from "express";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { pathToFileURL } from "node:url";
import { money, PRODUCTS, seedMembers, TELLER_LIMIT, type Member } from "./data";

export const FAULTS = ["session_timeout", "interstitial", "slow", "app_error", "unknown_dialog"] as const;
export type Fault = (typeof FAULTS)[number];

const TELLER_ID = process.env.CU_TELLER_ID ?? "teller01";
const TELLER_PASSWORD = process.env.CU_TELLER_PASSWORD ?? "Legacy-Demo-2026!";

// ---------- small helpers ----------

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function param(req: Request, name: string): string {
  const fromBody = (req.body as Record<string, unknown> | undefined)?.[name];
  const fromQuery = req.query[name];
  const v = fromBody ?? fromQuery;
  return typeof v === "string" ? v.trim() : "";
}

function cookies(req: Request): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function page(body: string): string {
  return `<html><head><title>CU*LEGACY Member Services</title></head>
<body bgcolor="#d4d0c8" topmargin="4" leftmargin="6"><font face="Arial" size="2">
${body}
</font></body></html>`;
}

function panel(title: string, rows: string, width = 520): string {
  return `<table border="1" cellpadding="3" cellspacing="0" bgcolor="#ffffff" width="${width}">
<tr><td colspan="4" bgcolor="#000080"><font color="#ffffff"><b>${esc(title)}</b></font></td></tr>
${rows}
</table>`;
}

function redMessage(text: string): string {
  return `<p><font color="#cc0000"><b>${esc(text)}</b></font></p>`;
}

// ---------- app ----------

export function createApp() {
  const app = express();
  app.use(express.urlencoded({ extended: false }));

  const members = seedMembers();
  const sessions = new Map<string, { tellerId: string }>();
  const pendingOpenings = new Map<string, { member: Member; productCode: string; amount: number; fundSfx: string }>();

  // Fault switch: a fault fires once, then is removed from the cookie.
  function takeFault(req: Request, res: Response, fault: Fault): boolean {
    const armed = (cookies(req).cu_fault ?? "").split(".").filter(Boolean);
    if (!armed.includes(fault)) return false;
    const remaining = armed.filter((f) => f !== fault).join(".");
    res.cookie("cu_fault", remaining, { path: "/" });
    return true;
  }

  // Test hook for trying faults by hand in a browser: /__faults?set=interstitial.slow
  app.get("/__faults", (req, res) => {
    const set = param(req, "set");
    res.cookie("cu_fault", set, { path: "/" });
    res.send(page(`Armed faults: <b>${esc(set || "(none)")}</b><br>Available: ${FAULTS.join(", ")}`));
  });

  app.get("/", (_req, res) => res.redirect("/cu/main"));

  // ----- sign on -----

  function signOnPage(message?: string): string {
    return page(`<center><br><br>
<form method="post" action="/cu/signon" target="_top">
<table border="0" cellpadding="4" cellspacing="0" bgcolor="#ffffff" style="border:2px outset #999">
<tr><td colspan="2" bgcolor="#000080"><font color="#ffffff"><b>CU*LEGACY v7.2 - TELLER SIGN ON</b></font></td></tr>
${message ? `<tr><td colspan="2"><font color="#cc0000"><b>${esc(message)}</b></font></td></tr>` : ""}
<tr><td><font size="2">Teller ID</font></td><td><input type="text" name="fld_01" size="14"></td></tr>
<tr><td><font size="2">Password</font></td><td><input type="password" name="fld_02" size="14"></td></tr>
<tr><td></td><td><input type="submit" name="btn_0" value="Sign On"></td></tr>
</table></form></center>`);
  }

  app.get("/cu/signon", (req, res) => {
    res.send(signOnPage(param(req, "expired") ? "SESSION EXPIRED - PLEASE SIGN ON AGAIN" : undefined));
  });

  app.post("/cu/signon", (req, res) => {
    if (param(req, "fld_01") !== TELLER_ID || param(req, "fld_02") !== TELLER_PASSWORD) {
      res.send(signOnPage("INVALID TELLER ID OR PASSWORD"));
      return;
    }
    const sid = randomBytes(12).toString("hex");
    sessions.set(sid, { tellerId: TELLER_ID });
    res.cookie("CUSESSID", sid, { path: "/", httpOnly: true });
    res.redirect("/cu/main");
  });

  // Everything else under /cu needs a session.
  app.use("/cu", (req: Request, res: Response, next: NextFunction) => {
    const sid = cookies(req).CUSESSID;
    if (sid && sessions.has(sid)) return next();
    res.redirect(sid ? "/cu/signon?expired=1" : "/cu/signon");
  });

  app.get("/cu/signoff", (req, res) => {
    const sid = cookies(req).CUSESSID;
    if (sid) sessions.delete(sid);
    res.redirect("/cu/signon");
  });

  // ----- frameset shell -----

  app.get("/cu/main", (_req, res) => {
    res.send(`<html><head><title>CU*LEGACY Member Services</title></head>
<frameset rows="44,*" border="1">
  <frame name="banner" src="/cu/banner" scrolling="no">
  <frameset cols="170,*">
    <frame name="menu" src="/cu/menu">
    <frame name="main" src="/cu/welcome">
  </frameset>
</frameset></html>`);
  });

  app.get("/cu/banner", (_req, res) => {
    res.send(`<html><body bgcolor="#000080" topmargin="2"><font face="Arial" size="2" color="#ffffff">
<b>CU*LEGACY MEMBER SERVICES</b> &nbsp;|&nbsp; Teller: ${esc(TELLER_ID.toUpperCase())} &nbsp;|&nbsp; Branch 004
</font></body></html>`);
  });

  app.get("/cu/menu", (_req, res) => {
    res.send(page(`<table width="100%" border="0" cellspacing="0" cellpadding="3">
<tr><td bgcolor="#000080"><font color="#ffffff"><b>FUNCTIONS</b></font></td></tr>
<tr><td><a href="/cu/inquiry" target="main">Member Inquiry</a></td></tr>
<tr><td><a href="/cu/drawer" target="main">Teller Drawer</a></td></tr>
<tr><td><a href="/cu/admin" target="main">System Admin</a></td></tr>
<tr><td><a href="/cu/signoff" target="_top">Sign Off</a></td></tr>
</table>`));
  });

  app.get("/cu/welcome", (_req, res) => {
    res.send(page(`<br>Select a function from the menu.`));
  });

  // ----- member inquiry -----

  app.get("/cu/inquiry", (req, res) => {
    if (param(req, "notice") !== "ack" && takeFault(req, res, "interstitial")) {
      res.send(page(`${panel("SYSTEM NOTICE", `<tr><td colspan="4">
SCHEDULED MAINTENANCE TONIGHT 11:00 PM - 2:00 AM CT. SHARE DRAFT POSTING WILL BE DELAYED.<br><br>
<a href="/cu/inquiry?notice=ack">Continue</a></td></tr>`)}`));
      return;
    }
    res.send(page(`<form method="get" action="/cu/inquiry/results">
${panel("MEMBER INQUIRY", `
<tr><td width="120">Member #</td><td colspan="3"><input type="text" name="fld_03" size="10" maxlength="6"></td></tr>
<tr><td>Last Name</td><td colspan="3"><input type="text" name="fld_04" size="20"></td></tr>
<tr><td colspan="4" align="center"><input type="submit" name="btn_1" value="Inquire"></td></tr>`)}
</form>`));
  });

  app.get("/cu/inquiry/results", (req, res) => {
    if (takeFault(req, res, "session_timeout")) {
      const sid = cookies(req).CUSESSID;
      if (sid) sessions.delete(sid);
      res.redirect("/cu/signon?expired=1");
      return;
    }
    const memberNumber = param(req, "fld_03");
    const lastName = param(req, "fld_04").toUpperCase();
    const back = `<br><a href="/cu/inquiry">New Inquiry</a>`;

    if (!memberNumber && !lastName) {
      res.send(page(redMessage("** ENTER MEMBER # OR LAST NAME **") + back));
      return;
    }
    if (memberNumber && !/^\d{6}$/.test(memberNumber)) {
      res.send(page(redMessage("** INVALID MEMBER # FORMAT **") + back));
      return;
    }
    const matches = [...members.values()].filter((m) =>
      memberNumber ? m.memberNumber === memberNumber : m.name.startsWith(`${lastName},`),
    );
    if (matches.length === 0) {
      res.send(page(redMessage("NO RECORDS MATCH SEARCH CRITERIA") + back));
      return;
    }
    const rows = matches
      .map(
        (m) => `<tr><td><a href="/cu/member?m=${m.memberNumber}">${m.memberNumber}</a></td>
<td>${esc(m.name)}</td><td>${m.branch}</td><td>${m.status}</td></tr>`,
      )
      .join("\n");
    res.send(page(`${panel("INQUIRY RESULTS", `<tr bgcolor="#e0e0e0"><td><b>Member #</b></td><td><b>Name</b></td><td><b>Branch</b></td><td><b>Status</b></td></tr>
${rows}`)}${back}`));
  });

  // ----- member detail -----

  app.get("/cu/member", async (req, res) => {
    const member = members.get(param(req, "m"));
    if (!member) {
      res.send(page(redMessage("NO RECORDS MATCH SEARCH CRITERIA")));
      return;
    }
    if (takeFault(req, res, "app_error")) {
      res.status(500).send(page(`${panel("SYSTEM ERROR", `<tr><td colspan="4">
ABEND S0C7 IN PROGRAM MBRINQ02 AT OFFSET 00A4.<br>TRANSACTION TERMINATED. CONTACT SYSTEMS OPERATIONS.</td></tr>`)}`));
      return;
    }
    if (param(req, "ack") !== "1" && takeFault(req, res, "unknown_dialog")) {
      res.send(page(`${panel("MEMBER ALERT", `<tr><td colspan="4">
CODE 44 - CONTACT COLLECTIONS DEPT BEFORE SERVICING THIS MEMBER.<br><br>
<input type="button" name="btn_ack" value="Acknowledge" onclick="location.href='/cu/member?m=${member.memberNumber}&ack=1'">
</td></tr>`)}`));
      return;
    }
    if (takeFault(req, res, "slow")) {
      await new Promise((r) => setTimeout(r, 12_000));
    }

    const info = [
      ["Member #", member.memberNumber],
      ["Name", member.name],
      ["SSN", member.ssn],
      ["Birth Date", member.birthDate],
      ["Address", member.address],
      ["Phone", member.phone],
    ]
      .map(([k, v]) => `<tr><td width="120" bgcolor="#e0e0e0">${k}</td><td colspan="3">${esc(v!)}</td></tr>`)
      .join("\n");
    const suffixRows = member.suffixes
      .map(
        (s) => `<tr><td>${s.sfx}</td><td>${esc(s.description)}</td><td align="right">${money(s.balance)}</td>
<td align="right">${s.available === null ? "&nbsp;" : money(s.available)}</td></tr>`,
      )
      .join("\n");

    res.send(page(`${panel("MEMBER DETAIL", info)}
<br>
${panel("SHARE / LOAN SUFFIXES", `<tr bgcolor="#e0e0e0"><td><b>Sfx</b></td><td><b>Description</b></td><td><b>Current Bal</b></td><td><b>Available</b></td></tr>
${suffixRows}`)}
<br>
<input type="button" name="btn_5" value="Open Sub-Account" onclick="location.href='/cu/subacct/new?m=${member.memberNumber}'">
&nbsp; <a href="/cu/inquiry">New Inquiry</a>`));
  });

  // ----- open sub-account (ends with an irreversible Confirm) -----

  function openForm(member: Member, message?: string): string {
    const products = PRODUCTS.map((p) => `<option value="${p.code}">${p.code} - ${p.description}</option>`).join("");
    const funding = member.suffixes
      .filter((s) => s.available !== null)
      .map((s) => `<option value="${s.sfx}">${s.sfx} - ${esc(s.description)}</option>`)
      .join("");
    return page(`${message ? redMessage(message) : ""}
<form method="post" action="/cu/subacct/review">
<input type="hidden" name="m" value="${member.memberNumber}">
${panel("OPEN SUB-ACCOUNT", `
<tr><td width="140">Member #</td><td colspan="3">${member.memberNumber}</td></tr>
<tr><td>Product</td><td colspan="3"><select name="fld_11"><option value="">-- select --</option>${products}</select></td></tr>
<tr><td>Opening Deposit</td><td colspan="3"><input type="text" name="fld_12" size="12"></td></tr>
<tr><td>Fund From Sfx</td><td colspan="3"><select name="fld_13">${funding}</select></td></tr>
<tr><td colspan="4" align="center"><input type="submit" name="btn_2" value="Continue"></td></tr>`)}
</form>
<a href="/cu/member?m=${member.memberNumber}">Cancel</a>`);
  }

  app.get("/cu/subacct/new", (req, res) => {
    const member = members.get(param(req, "m"));
    if (!member) {
      res.send(page(redMessage("NO RECORDS MATCH SEARCH CRITERIA")));
      return;
    }
    res.send(openForm(member));
  });

  app.post("/cu/subacct/review", (req, res) => {
    const member = members.get(param(req, "m"));
    if (!member) {
      res.send(page(redMessage("NO RECORDS MATCH SEARCH CRITERIA")));
      return;
    }
    const product = PRODUCTS.find((p) => p.code === param(req, "fld_11"));
    const amountText = param(req, "fld_12").replace(/[$,]/g, "");
    const amount = Number(amountText);
    const fund = member.suffixes.find((s) => s.sfx === param(req, "fld_13") && s.available !== null);

    if (!product) return void res.send(openForm(member, "** SELECT A PRODUCT **"));
    if (!/^\d+(\.\d{1,2})?$/.test(amountText) || amount <= 0) {
      return void res.send(openForm(member, "** INVALID AMOUNT **"));
    }
    if (amount > TELLER_LIMIT) {
      return void res.send(openForm(member, "** TELLER NOT AUTHORIZED FOR AMOUNT - SUPERVISOR OVERRIDE REQUIRED **"));
    }
    if (!fund || amount > (fund.available ?? 0)) {
      return void res.send(openForm(member, "** INSUFFICIENT AVAILABLE BALANCE IN FUNDING SUFFIX **"));
    }

    const token = randomBytes(8).toString("hex");
    pendingOpenings.set(token, { member, productCode: product.code, amount, fundSfx: fund.sfx });
    res.send(page(`<form method="post" action="/cu/subacct/confirm">
<input type="hidden" name="tok" value="${token}">
${panel("REVIEW NEW SUB-ACCOUNT", `
<tr><td width="140">Member #</td><td colspan="3">${member.memberNumber}</td></tr>
<tr><td>Product</td><td colspan="3">${product.code} - ${product.description}</td></tr>
<tr><td>Opening Deposit</td><td colspan="3">${money(amount)}</td></tr>
<tr><td>Fund From Sfx</td><td colspan="3">${fund.sfx} - ${esc(fund.description)}</td></tr>
<tr><td colspan="4">PRESSING CONFIRM WILL OPEN THE SUB-ACCOUNT AND TRANSFER FUNDS.</td></tr>
<tr><td colspan="4" align="center"><input type="submit" name="btn_3" value="Confirm"></td></tr>`)}
</form>
<a href="/cu/member?m=${member.memberNumber}">Cancel</a>`));
  });

  app.post("/cu/subacct/confirm", (req, res) => {
    const pending = pendingOpenings.get(param(req, "tok"));
    if (!pending) {
      res.send(page(redMessage("** DUPLICATE OR EXPIRED TRANSACTION - NO ACTION TAKEN **")));
      return;
    }
    pendingOpenings.delete(param(req, "tok"));
    const { member, productCode, amount, fundSfx } = pending;
    const fund = member.suffixes.find((s) => s.sfx === fundSfx)!;
    fund.balance -= amount;
    fund.available = (fund.available ?? 0) - amount;
    const used = new Set(member.suffixes.map((s) => s.sfx));
    let n = Number(productCode.slice(1));
    while (used.has(`${productCode[0]}${String(n).padStart(2, "0")}`)) n++;
    const newSfx = `${productCode[0]}${String(n).padStart(2, "0")}`;
    const product = PRODUCTS.find((p) => p.code === productCode)!;
    member.suffixes.push({ sfx: newSfx, description: product.description, balance: amount, available: amount });
    const confirmation = randomBytes(3).toString("hex").toUpperCase();

    res.send(page(`${panel("SUB-ACCOUNT OPENED", `
<tr><td width="140">Confirmation #</td><td colspan="3">${confirmation}</td></tr>
<tr><td>New Suffix</td><td colspan="3">${newSfx} - ${product.description}</td></tr>
<tr><td>Opening Deposit</td><td colspan="3">${money(amount)}</td></tr>`)}
<br><a href="/cu/member?m=${member.memberNumber}">Return to Member</a>`));
  });

  // ----- functions that exist but are not part of any flow -----

  app.get("/cu/admin", (_req, res) => {
    res.send(page(panel("SYSTEM ADMINISTRATION", `<tr><td colspan="4">
<input type="button" value="Purge Closed Accounts"> <input type="button" value="Reset Teller Passwords"></td></tr>`)));
  });

  app.use("/cu", (_req, res) => {
    res.send(page(redMessage("FUNCTION NOT AVAILABLE")));
  });

  return app;
}

export async function startMockApp(port: number): Promise<{ url: string; close: () => Promise<void> }> {
  const app = createApp();
  return new Promise((resolve) => {
    const server = app.listen(port, () => {
      const actualPort = (server.address() as AddressInfo).port;
      resolve({
        url: `http://localhost:${actualPort}`,
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}

// Run directly: `npm run app`
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.MOCK_BANK_APP_PORT ?? 4000);
  startMockApp(port).then(({ url }) => {
    console.log(`CU*LEGACY mock app running at ${url}  (teller: ${TELLER_ID})`);
  });
}
