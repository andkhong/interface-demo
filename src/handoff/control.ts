// Who is in control of the live browser session?
//
// Think of it as a talking stick with a number on it:
//   - only one controller at a time: "automation", "human", or "nobody" (paused, waiting)
//   - every hand-over increases `turn`
//   - automation remembers the turn it was given, and before EVERY action it checks
//     that the turn is still current. If a human took over in between, the check fails
//     and the automation cannot act.

export type Controller = "automation" | "human" | "nobody";

export interface ControlState {
  controller: Controller;
  turn: number;
  reason: string;
  since: string;
}

export class ControlLostError extends Error {
  constructor(expectedTurn: number, state: ControlState) {
    super(`automation lost control: it holds turn ${expectedTurn}, but turn ${state.turn} belongs to ${state.controller}`);
  }
}

export class ControlTurn {
  private state: ControlState = { controller: "automation", turn: 1, reason: "run started", since: new Date().toISOString() };
  private listeners = new Set<(state: ControlState, previous: ControlState) => void>();

  get(): ControlState {
    return { ...this.state };
  }

  /** Give control to someone else. Returns the new turn number. */
  handTo(controller: Controller, reason: string): number {
    const previous = this.state;
    this.state = { controller, turn: previous.turn + 1, reason, since: new Date().toISOString() };
    for (const fn of this.listeners) fn(this.get(), previous);
    return this.state.turn;
  }

  /** Throws unless automation holds exactly this turn. Called before every automated action. */
  assertAutomationMayAct(turn: number): void {
    if (this.state.controller !== "automation" || this.state.turn !== turn) {
      throw new ControlLostError(turn, this.state);
    }
  }

  onChange(fn: (state: ControlState, previous: ControlState) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}
