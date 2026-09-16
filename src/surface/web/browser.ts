// Web implementation of the Surface, using Playwright + Chromium.
//
// - The browser is launched VISIBLE by default, so a human can take over the same session.
// - A network guard blocks any request the policy does not allow (second layer of safety).
// - All element finding uses page-script.js inside each frame, so discovery and replay agree.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { chromium, type Browser, type BrowserContext, type Frame, type Page } from "playwright";
import type { Target } from "../../capability/schema";
import { checkUrl, type Policy } from "../../safety/policy";
import type { ElementInfo, ElementRef, FindResult, HumanAction, Observation, Surface } from "../types";

const PAGE_SCRIPT = readFileSync(new URL("./page-script.js", import.meta.url), "utf8");
const HUMAN_CAPTURE_SCRIPT = readFileSync(new URL("./human-capture.js", import.meta.url), "utf8");
const ACTION_TIMEOUT_MS = 5_000;

export interface WebSurfaceOptions {
  headless?: boolean;
  policy: Policy;
  /** Called when the network guard blocks a page navigation. */
  onBlocked?: (url: string, reason: string) => void;
}

export class WebSurface implements Surface {
  private constructor(
    private readonly browser: Browser,
    readonly context: BrowserContext,
    readonly page: Page,
    private readonly humanListener: { fn?: (action: HumanAction) => void },
  ) {}

  static async launch(options: WebSurfaceOptions): Promise<WebSurface> {
    const browser = await chromium.launch({ headless: options.headless ?? false });
    const context = await browser.newContext({ viewport: { width: 1100, height: 760 } });

    // Page events (clicks, changes) from every frame are reported here; the Session keeps
    // only the ones that happen while a human is in control.
    const humanListener: { fn?: (action: HumanAction) => void } = {};
    await context.exposeBinding("__cuaHumanEvent", (_source, event: Omit<HumanAction, "at">) => {
      humanListener.fn?.({ ...event, at: new Date().toISOString() });
    });
    await context.addInitScript({ content: `${PAGE_SCRIPT}\n;${HUMAN_CAPTURE_SCRIPT}` });

    await context.route("**/*", async (route) => {
      const request = route.request();
      const url = request.url();
      if (!url.startsWith("http")) return route.continue();
      const decision = checkUrl(options.policy, url);
      if (decision.allowed) return route.continue();
      if (request.isNavigationRequest()) options.onBlocked?.(url, decision.reason);
      return route.abort("blockedbyclient");
    });
    const page = await context.newPage();
    return new WebSurface(browser, context, page, humanListener);
  }

  onHumanAction(fn: (action: HumanAction) => void): void {
    this.humanListener.fn = fn;
  }

  // ---------- frames ----------

  private frames(): { key: string; frame: Frame }[] {
    return this.page
      .frames()
      .filter((f) => !f.isDetached())
      .map((frame, i) => ({
        key: frame.name() || (frame === this.page.mainFrame() ? "top" : `frame${i}`),
        frame,
      }));
  }

  private frameByKey(key: string): Frame | null {
    return this.frames().find((f) => f.key === key)?.frame ?? null;
  }

  /** Run page-script.js (installs window.__cua if needed) and then an expression. null if the frame is navigating. */
  private async run<T>(frame: Frame, expression: string): Promise<T | null> {
    try {
      return (await frame.evaluate(`${PAGE_SCRIPT}\n;${expression}`)) as T;
    } catch {
      return null;
    }
  }

  // ---------- seeing ----------

  async open(url: string): Promise<void> {
    await this.page.goto(url, { waitUntil: "load" });
  }

  async observe(options: { screenshot?: boolean; sensitiveFields?: string[] } = {}): Promise<Observation> {
    const parts: string[] = [];
    for (const { key, frame } of this.frames()) {
      const snap = await this.run<{ lines: string[]; truncated: boolean }>(
        frame,
        `window.__cua.snapshot(${JSON.stringify(`${key}:`)})`,
      );
      if (snap && snap.lines.length > 0) {
        parts.push(`--- frame "${key}" ${frame.url()}\n${snap.lines.join("\n")}${snap.truncated ? "\n(truncated)" : ""}`);
      }
    }
    const text = parts.join("\n\n");
    const location = await this.location();
    let screenshotBase64: string | undefined;
    if (options.screenshot) {
      const buffer = await this.page.screenshot({
        type: "jpeg",
        quality: 60,
        mask: await this.sensitiveLocators(options.sensitiveFields ?? []),
      });
      screenshotBase64 = buffer.toString("base64");
    }
    return {
      url: location.url,
      frames: location.frames,
      text,
      screenshotBase64,
      stateKey: createHash("sha1").update(text).digest("hex").slice(0, 12),
    };
  }

  private splitRef(ref: string): { frame: Frame; key: string } | null {
    const key = ref.slice(0, ref.lastIndexOf(":"));
    const frame = this.frameByKey(key);
    return frame ? { frame, key } : null;
  }

  async describeRef(ref: string): Promise<ElementInfo | null> {
    const found = this.splitRef(ref);
    if (!found) return null;
    const info = await this.run<Omit<ElementInfo, "ref" | "frame" | "frameUrl">>(
      found.frame,
      `window.__cua.describe(${JSON.stringify(ref)})`,
    );
    return info ? { ...info, ref, frame: found.key, frameUrl: found.frame.url() } : null;
  }

  async refToElement(ref: string): Promise<ElementRef | null> {
    const info = await this.describeRef(ref);
    return info ? { frame: info.frame, frameUrl: info.frameUrl, path: info.path } : null;
  }

  async find(target: Target): Promise<FindResult> {
    const frames = this.frames().filter((f) => !target.frame || f.key === target.frame);
    const snapshots: { key: string; url: string; matches: string[][] }[] = [];
    for (const { key, frame } of frames) {
      const url = frame.url();
      // Evaluate the entire ladder in one document snapshot. A navigation between
      // separate evaluations must not make a valid primary locator look degraded.
      const matches = await this.run<string[][]>(frame, `${JSON.stringify(target.locators)}.map(locator => window.__cua.resolve(locator))`);
      if (!matches || frame.isDetached() || frame.url() !== url) return { status: "not_found" };
      snapshots.push({ key, url, matches });
    }
    for (const [locatorIndex, locator] of target.locators.entries()) {
      const hits: ElementRef[] = [];
      for (const { key, url, matches } of snapshots) {
        for (const path of matches[locatorIndex] ?? []) hits.push({ frame: key, frameUrl: url, path });
      }
      if (hits.length === 1) return { status: "found", element: hits[0]!, locator, locatorIndex };
      // Never guess between two matches: clicking the wrong control is worse than stopping.
      if (hits.length > 1) return { status: "ambiguous", locator, count: hits.length };
    }
    return { status: "not_found" };
  }

  async elementInfo(element: ElementRef) {
    const frame = this.frameByKey(element.frame);
    if (!frame) return null;
    return this.run<{ role: string | null; name: string; href: string | null }>(
      frame,
      `window.__cua.infoAt(${JSON.stringify(element.path)})`,
    );
  }

  // ---------- acting ----------

  private locate(element: ElementRef) {
    const frame = this.frameByKey(element.frame);
    if (!frame) throw new Error(`frame "${element.frame}" is gone`);
    return frame.locator(element.path);
  }

  async click(element: ElementRef): Promise<void> {
    await this.locate(element).click({ timeout: ACTION_TIMEOUT_MS });
  }

  async fill(element: ElementRef, value: string): Promise<void> {
    await this.locate(element).fill(value, { timeout: ACTION_TIMEOUT_MS });
  }

  async select(element: ElementRef, option: string): Promise<void> {
    await this.locate(element).selectOption({ label: option }, { timeout: ACTION_TIMEOUT_MS });
  }

  async press(element: ElementRef, key: string): Promise<void> {
    await this.locate(element).press(key, { timeout: ACTION_TIMEOUT_MS });
  }

  async readText(element: ElementRef): Promise<string> {
    const text = await this.locate(element).innerText({ timeout: ACTION_TIMEOUT_MS });
    return text.replace(/\s+/g, " ").trim();
  }

  // ---------- checks and evidence ----------

  async findText(text: string): Promise<{ frame: string; url: string } | null> {
    for (const { key, frame } of this.frames()) {
      const body = await this.run<string>(frame, "window.__cua.bodyText()");
      if (body && body.includes(text)) return { frame: key, url: frame.url() };
    }
    return null;
  }

  async visibleText(): Promise<string> {
    const parts: string[] = [];
    for (const { key, frame } of this.frames()) {
      const body = await this.run<string>(frame, "window.__cua.bodyText()");
      if (body?.trim()) parts.push(`[${key}] ${body.replace(/\s+/g, " ").trim()}`);
    }
    return parts.join("\n");
  }

  async location() {
    return {
      url: this.page.url(),
      frames: this.frames().map(({ key, frame }) => ({ name: key, url: frame.url() })),
    };
  }

  private async sensitiveLocators(fields: string[]) {
    const locators = [];
    for (const { frame } of this.frames()) {
      const paths = (await this.run<string[]>(frame, `window.__cua.sensitivePaths(${JSON.stringify(fields)})`)) ?? [];
      for (const path of paths) locators.push(frame.locator(path));
    }
    return locators;
  }

  async screenshot(path: string, sensitiveFields: string[]): Promise<void> {
    await this.page.screenshot({ path, type: "png", mask: await this.sensitiveLocators(sensitiveFields) });
  }

  async pageSnapshots() {
    const out: { frame: string; url: string; html: string }[] = [];
    for (const { key, frame } of this.frames()) {
      const html = await this.run<string>(frame, "document.documentElement.outerHTML");
      if (html) out.push({ frame: key, url: frame.url(), html });
    }
    return out;
  }

  async sensitiveValues(labels: string[]): Promise<string[]> {
    const out: string[] = [];
    for (const { frame } of this.frames()) {
      out.push(...((await this.run<string[]>(frame, `window.__cua.sensitiveValues(${JSON.stringify(labels)})`)) ?? []));
    }
    return out;
  }

  async close(): Promise<void> {
    await this.browser.close();
  }
}
