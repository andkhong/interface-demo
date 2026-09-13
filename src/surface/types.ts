// The "surface" is the only layer that knows how to see and act on an application.
//
// Everything above it (discovery agent, recorder, replay engine) talks to this interface.
// Today there is one implementation: a web browser (surface/web). A desktop app would get
// a second implementation using the OS accessibility API (Windows UI Automation, macOS AX)
// behind the same interface, and the capability files would not need to change shape.

import type { Locator, Target } from "../capability/schema";

export interface Observation {
  url: string;
  frames: { name: string; url: string }[];
  /** Page text with [ref] markers for controls and table cells, across all frames. */
  text: string;
  /** JPEG screenshot, sensitive fields masked. */
  screenshotBase64?: string;
  /** Short hash of `text`, used to notice when nothing changed between steps. */
  stateKey: string;
}

/** What the recorder learns about an element the AI referred to by its [ref]. */
export interface ElementInfo {
  ref: string;
  frame: string;
  frameUrl: string;
  role: string | null;
  tag: string;
  name: string;
  rowLabel: string | null;
  tableCell: { row: string | null; column: string | null } | null;
  /** For grid cells: every text in the row that could identify it, longest first. */
  rowKeys: string[];
  css: string[];
  href: string | null;
  isPassword: boolean;
  options: string[] | null;
  text: string | null;
  path: string;
}

/** A found element. Opaque to callers; only the surface knows how to use it. */
export interface ElementRef {
  frame: string;
  frameUrl: string;
  path: string;
}

/** Something a person did in the live session (typed text is never included). */
export interface HumanAction {
  at: string;
  type: string; // click | change | page
  frame: string;
  url: string;
  role: string | null;
  name: string;
  rowLabel: string | null;
  detail?: string;
}

export type FindResult =
  | { status: "found"; element: ElementRef; locator: Locator; locatorIndex: number }
  | { status: "not_found" }
  | { status: "ambiguous"; locator: Locator; count: number };

export interface Surface {
  open(url: string): Promise<void>;
  observe(options?: { screenshot?: boolean; sensitiveFields?: string[] }): Promise<Observation>;
  describeRef(ref: string): Promise<ElementInfo | null>;
  refToElement(ref: string): Promise<ElementRef | null>;
  find(target: Target): Promise<FindResult>;
  /** Accessible name and link destination of a found element (used by the policy check). */
  elementInfo(element: ElementRef): Promise<{ role: string | null; name: string; href: string | null } | null>;

  click(element: ElementRef): Promise<void>;
  fill(element: ElementRef, value: string): Promise<void>;
  select(element: ElementRef, option: string): Promise<void>;
  press(element: ElementRef, key: string): Promise<void>;
  readText(element: ElementRef): Promise<string>;

  /** Is this text visible anywhere (any frame)? Returns the frame it was found in. */
  findText(text: string): Promise<{ frame: string; url: string } | null>;
  location(): Promise<{ url: string; frames: { name: string; url: string }[] }>;
  visibleText(): Promise<string>;
  screenshot(path: string, sensitiveFields: string[]): Promise<void>;
  pageSnapshots(): Promise<{ frame: string; url: string; html: string }[]>;
  sensitiveValues(labels: string[]): Promise<string[]>;
  /** Report page events so actions taken by a human in the live session can be recorded. */
  onHumanAction(fn: (action: HumanAction) => void): void;
  close(): Promise<void>;
}
