// The operator console: a small local web page where a human sees help requests,
// takes control of the live browser session, and hands control back.
//
// This is deliberately minimal (the brief allows a mock operator UI). The mechanism is real:
//   request()  -> control goes to "nobody" (automation paused), request shown on the page
//   claim      -> control goes to "human" (automation cannot act; human clicks are recorded)
//   resolve    -> control goes back to "automation" with a new turn number, and the run continues

import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { RunLogger } from "../evidence/logger";
import type { ControlTurn } from "./control";
import type { HelpChoice, HelpDesk, HelpRequest, HelpRequestInput, HelpResolution } from "./helpdesk";
import { OPERATOR_PAGE } from "./operator-page";

export interface OperatorConsoleOptions {
  port: number;
  control: ControlTurn;
  log: RunLogger;
  deadlineMs?: number;
}

export class OperatorConsole implements HelpDesk {
  private readonly requests: HelpRequest[] = [];
  private readonly waiters = new Map<string, { resolve: (r: HelpResolution) => void; timer: NodeJS.Timeout }>();

  private constructor(
    private readonly server: Server,
    readonly url: string,
    private readonly control: ControlTurn,
    private readonly log: RunLogger,
    private readonly deadlineMs: number,
  ) {}

  static async start(options: OperatorConsoleOptions): Promise<OperatorConsole> {
    const app = express();
    app.use(express.json());
    const holder: { console?: OperatorConsole } = {};
    const handle = (fn: (c: OperatorConsole, req: express.Request) => unknown) => (req: express.Request, res: express.Response) => {
      try {
        res.json(fn(holder.console!, req) ?? { ok: true });
      } catch (error) {
        res.status(409).json({ error: (error as Error).message });
      }
    };

    app.get("/", (_req, res) => {
      res.type("html").send(OPERATOR_PAGE);
    });
    app.get("/api/state", handle((c) => c.state()));
    app.get("/api/requests/:id/screenshot", (req, res) => {
      const request = holder.console!.requests.find((r) => r.id === req.params.id);
      if (!request) return void res.sendStatus(404);
      res.sendFile(request.screenshotFile);
    });
    app.post("/api/requests/:id/claim", handle((c, req) => c.claim(String(req.params.id))));
    app.post("/api/requests/:id/resolve", handle((c, req) => c.resolve(String(req.params.id), req.body)));

    const server = await new Promise<Server>((resolve) => {
      const s = app.listen(options.port, "127.0.0.1", () => resolve(s));
    });
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    holder.console = new OperatorConsole(server, url, options.control, options.log, options.deadlineMs ?? 15 * 60_000);
    return holder.console;
  }

  request(input: HelpRequestInput): Promise<HelpResolution> {
    const now = Date.now();
    const request: HelpRequest = {
      ...input,
      id: `help-${this.requests.length + 1}`,
      createdAt: new Date(now).toISOString(),
      deadline: new Date(now + this.deadlineMs).toISOString(),
      status: "open",
    };
    this.requests.push(request);
    this.control.handTo("nobody", `paused, waiting for an operator (${request.id}: ${input.reasonCode})`);
    this.persist();
    console.log(`\n  >>> HUMAN HELP NEEDED (${input.reasonCode}). Open the operator console: ${this.url}\n`);

    return new Promise((resolve) => {
      const timer = setTimeout(() => this.finish(request, { choice: "timeout", humanActions: [] }), this.deadlineMs);
      this.waiters.set(request.id, { resolve, timer });
    });
  }

  claim(id: string): void {
    const request = this.requests.find((r) => r.id === id);
    if (!request || request.status !== "open") throw new Error(`request ${id} is not open`);
    request.status = "claimed";
    this.control.handTo("human", `operator took control for ${id}`);
    this.persist();
  }

  resolve(id: string, body: { choice?: string; note?: string; stepId?: string }): void {
    const request = this.requests.find((r) => r.id === id);
    if (!request || request.status === "resolved") throw new Error(`request ${id} is not waiting for a decision`);
    const choice = body.choice as HelpChoice;
    if (!request.choices.includes(choice)) throw new Error(`"${body.choice}" is not an allowed choice for ${id}`);
    if (choice === "continue_from" && !request.stepIds.includes(body.stepId ?? "")) {
      throw new Error("continue_from needs a valid stepId");
    }
    this.finish(request, { choice, note: body.note, stepId: body.stepId, humanActions: [] });
  }

  private finish(request: HelpRequest, resolution: HelpResolution): void {
    const waiter = this.waiters.get(request.id);
    if (!waiter) return;
    clearTimeout(waiter.timer);
    this.waiters.delete(request.id);
    request.status = "resolved";
    request.resolution = resolution;
    this.control.handTo("automation", `operator chose "${resolution.choice}" for ${request.id}`);
    this.persist();
    waiter.resolve(resolution);
  }

  recordHumanActions(): void {
    // `resolution` is the same object stored as `request.resolution` (set in finish()), so the
    // caller's mutation of `humanActions` already landed in memory; this just re-persists it.
    this.persist();
  }

  state() {
    return {
      control: this.control.get(),
      requests: [...this.requests].reverse().map(({ screenshotFile: _file, ...rest }) => ({
        ...rest,
        screenshotUrl: `/api/requests/${rest.id}/screenshot`,
      })),
    };
  }

  private persist(): void {
    this.log.writeJson(
      "help-requests.json",
      this.requests.map(({ screenshotFile: _file, ...rest }) => rest),
    );
  }

  async close(): Promise<void> {
    for (const request of this.requests) {
      if (request.status !== "resolved") this.finish(request, { choice: "abort", note: "run ended", humanActions: [] });
    }
    await new Promise<void>((resolve) => {
      this.server.closeAllConnections();
      this.server.close(() => resolve());
    });
  }
}
