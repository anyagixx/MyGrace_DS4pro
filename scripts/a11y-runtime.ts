#!/usr/bin/env bun
/// <reference lib="dom" />
/**
 * Runtime accessibility checks for benchmark artifacts (v3.6.0).
 *
 * Uses Playwright + Chromium headless to exercise the generated HTML instead of
 * only grepping source patterns. Browser binaries are a local/CI tool
 * dependency (`bunx playwright install chromium-headless-shell`); the script
 * fails honestly when the browser is unavailable.
 *
 * Usage: bun run scripts/a11y-runtime.ts --file dialog.html --task dialog
 */

import { pathToFileURL } from "node:url";

export interface RuntimeCheck {
  score: number;
  max: number;
  checks: Record<string, boolean>;
  error: string | null;
}

interface BrowserLike {
  newPage(): Promise<PageLike>;
  close(): Promise<void>;
}
interface PageLike {
  goto(url: string): Promise<unknown>;
  evaluate<T>(fn: () => T): Promise<T>;
  keyboard: { press(key: string): Promise<void> };
  locator(selector: string): {
    count(): Promise<number>;
    first(): { focus(): Promise<void>; fill(value: string): Promise<void> };
  };
}

const checksFor = (task: string): string[] => {
  if (task === "dialog") return ["dialogOpens", "focusInside", "escapeCloses"];
  if (task === "tabs") return ["arrowNavigation", "focusMoves", "selectionUpdates", "homeEndKeys"];
  if (task === "form") return ["nativeValidation", "invalidStateExposed", "formSubmits"];
  return [];
};

/** Run task-specific runtime checks against a generated HTML file. */
export async function gradeArtifactRuntime(file: string, task: string): Promise<RuntimeCheck> {
  const names = checksFor(task);
  if (names.length === 0) return { score: 0, max: 0, checks: {}, error: "unsupported task" };
  let chromium: { launch(options?: Record<string, unknown>): Promise<BrowserLike> };
  try {
    const playwright = (await import("playwright")) as { chromium: typeof chromium };
    chromium = playwright.chromium;
  } catch (error) {
    return { score: 0, max: names.length, checks: {}, error: `playwright unavailable: ${error instanceof Error ? error.message : String(error)}` };
  }
  let browser: BrowserLike | null = null;
  try {
    browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
    const page = await browser.newPage();
    await page.goto(pathToFileURL(file).href);
    const checks: Record<string, boolean> = {};
    if (task === "dialog") {
      const opened = await page.evaluate((): { has: boolean; open: boolean; focusInside: boolean; error: string | null } => {
        const dialog = document.querySelector("dialog");
        if (dialog === null) return { has: false, open: false, focusInside: false, error: "no <dialog>" };
        try {
          if (!(dialog as HTMLDialogElement).open) (dialog as HTMLDialogElement).showModal();
        } catch (error) {
          return { has: true, open: false, focusInside: false, error: error instanceof Error ? error.message : String(error) };
        }
        return { has: true, open: (dialog as HTMLDialogElement).open, focusInside: dialog.contains(document.activeElement), error: null };
      });
      checks.dialogOpens = opened.has && opened.open;
      checks.focusInside = opened.focusInside;
      if (opened.open) {
        await page.keyboard.press("Escape");
        checks.escapeCloses = await page.evaluate((): boolean => !(document.querySelector("dialog") as HTMLDialogElement | null)?.open);
      } else {
        checks.escapeCloses = false;
      }
    } else if (task === "tabs") {
      const tabs = page.locator('[role="tab"]');
      const count = await tabs.count();
      if (count < 2) {
        checks.arrowNavigation = false;
        checks.focusMoves = false;
        checks.selectionUpdates = false;
        checks.homeEndKeys = false;
      } else {
        await tabs.first().focus();
        await page.keyboard.press("ArrowRight");
        const next = await page.evaluate((): { focusRole: string | null; selected: number } => ({
          focusRole: document.activeElement?.getAttribute("role") ?? null,
          selected: [...document.querySelectorAll('[role="tab"]')].filter((tab) => tab.getAttribute("aria-selected") === "true").length,
        }));
        checks.arrowNavigation = next.focusRole === "tab";
        checks.focusMoves = next.focusRole === "tab";
        checks.selectionUpdates = next.selected <= 1;
        await page.keyboard.press("End");
        checks.homeEndKeys = (await page.evaluate((): string | null => document.activeElement?.getAttribute("role") ?? null)) === "tab";
      }
    } else if (task === "form") {
      const email = page.locator('input[type="email"]');
      const count = await email.count();
      if (count === 0) {
        checks.nativeValidation = false;
        checks.invalidStateExposed = false;
        checks.formSubmits = false;
      } else {
        await email.first().fill("not-an-email");
        checks.nativeValidation = await page.evaluate((): boolean => {
          const input = document.querySelector('input[type="email"]') as HTMLInputElement | null;
          return input !== null && !input.checkValidity();
        });
        checks.invalidStateExposed = await page.evaluate((): boolean => {
          const input = document.querySelector('input[type="email"]') as HTMLInputElement | null;
          if (input === null) return false;
          return input.getAttribute("aria-invalid") === "true" || document.querySelector('[aria-live], [role="alert"], .error') !== null;
        });
        checks.formSubmits = await page.evaluate((): boolean => {
          const form = document.querySelector("form") as HTMLFormElement | null;
          if (form === null) return false;
          let submitted = false;
          form.addEventListener("submit", (event) => { event.preventDefault(); submitted = true; });
          form.requestSubmit();
          return submitted;
        });
      }
    }
    const score = Object.values(checks).filter(Boolean).length;
    return { score, max: names.length, checks, error: null };
  } catch (error) {
    return { score: 0, max: names.length, checks: {}, error: error instanceof Error ? error.message : String(error) };
  } finally {
    await browser?.close().catch(() => {});
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const file = args[args.indexOf("--file") + 1];
  const task = args[args.indexOf("--task") + 1];
  if (file === undefined || task === undefined) {
    console.error("usage: bun run scripts/a11y-runtime.ts --file <html> --task dialog|tabs|form");
    process.exit(2);
  }
  const result = await gradeArtifactRuntime(file, task);
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.error !== null || result.score < result.max ? 1 : 0);
}
