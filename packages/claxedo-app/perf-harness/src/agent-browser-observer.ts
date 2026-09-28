import { settleExpression, type PageSettle } from "agent-app-benchmark/driver-sdk";
import type { BenchmarkLocator } from "./agent-cdp-page";
import { installPaintedFrames } from "./browser/painted-frames";
import { claxedoSettleFacts, type SettleFactsTarget } from "./claxedo-settle-facts";

/**
 * The page surface this observer drives.
 *
 * Narrower than `BenchmarkPage` on purpose. The observer runs against both the
 * packaged app's CDP page and a Playwright page, and declaring the whole
 * `BenchmarkPage` forced every Playwright caller through `page as never` —
 * an assertion that would have hidden a real mismatch just as readily.
 */
export type Page = {
  /** Widened to `unknown` because Playwright's own `addInitScript` resolves a `Disposable`. */
  addInitScript(fn: () => void): Promise<unknown>;
  /**
   * Resolves `unknown` because the answer crosses a JSON boundary: see
   * `BenchmarkPage.evaluate`. Playwright's own `evaluate` satisfies this, since
   * its `Promise<R>` is assignable to `Promise<unknown>`. A string is evaluated
   * as an expression, as Playwright does.
   */
  evaluate<A = undefined>(fn: string | ((arg: A) => unknown) | (() => unknown), arg?: A): Promise<unknown>;
  locator(selector: string): BenchmarkLocator;
  getByTestId(testId: string): BenchmarkLocator;
  waitForFunction<A = undefined>(
    fn: ((arg: A) => unknown) | (() => unknown),
    arg?: A,
    options?: { polling?: "raf"; timeout?: number },
  ): Promise<unknown>;
};
import {
  readBoolean,
  readNumber,
  readNumberFields,
  readRecord,
  readRecords,
  readText,
} from "./page-value";

type ActionResult =
  | {
      state: "exact";
      durationMs: number;
      trustedEventAtMs: number;
      endAtMs: number;
    }
  | { state: "invalid"; reason: string };

export type SessionReadinessTarget = SettleFactsTarget & { title: string };

type BrowserBenchmark = {
  armAction(token: string): void;
  finishAction(token: string): Promise<ActionResult>;
};

declare global {
  interface Window {
    __CLAXEDO_AGENT_APP_BENCHMARK__?: BrowserBenchmark;
  }
}

export async function installAgentBrowserObserver(page: {
  addInitScript(fn: () => void): Promise<unknown>;
  evaluate(fn: () => void): Promise<unknown>;
}) {
  await page.addInitScript(installPaintedFrames);
  await page.evaluate(installPaintedFrames);
  await page.addInitScript(installBrowserBenchmark);
  await page.evaluate(installBrowserBenchmark);
}

/**
 * Opens `target` through its rail row with a trusted click, timed by the
 * benchmark's page clock from the click's pointerdown to the settle frame.
 */
export async function measureSessionActivation(
  page: Page,
  target: SessionReadinessTarget,
  options: { readinessTimeoutMs?: number } = {},
): Promise<PageSettle> {
  // Pagination is fixture discovery, not session activation. Expose the target
  // through the same public sidebar path before arming the clock.
  await revealSessionRows(page, [target.sessionId]);
  const expression = settleExpression({
    facts: claxedoSettleFacts,
    target: {
      sessionId: target.sessionId,
      expectedMessageIds: [...target.expectedMessageIds],
      expectedPartIds: [...target.expectedPartIds],
    },
    timeoutMs: options.readinessTimeoutMs ?? 30_000,
    start: "trusted-pointerdown",
  });
  // The clock is sent before the click: the click's own renderer evaluations
  // queue behind it, so the clock is armed before the pointerdown.
  const settle = page.evaluate(expression).catch((error: unknown) => {
    throw new Error(`Claxedo session ${target.sessionId} did not settle: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  });
  const [settled] = await Promise.all([settle, clickVisibleSessionActivation(page, target.sessionId)]);
  return readPageSettle(settled);
}

/** The page clock's answer, read off JSON; it throws rather than defaulting because every field is a published measurement. */
function readPageSettle(value: unknown): PageSettle {
  const record = readRecord(value);
  return {
    ...readNumberFields(record, ["startAt", "settledAt", "timeOrigin"]),
    frames: readRecords(record.frames).map((frame) => {
      const gates = readRecord(frame.gates);
      return {
        at: readNumber(frame.at),
        gates: {
          displayedDestination: readBoolean(gates.displayedDestination),
          latestTurnPainted: readBoolean(gates.latestTurnPainted),
          noPlaceholder: readBoolean(gates.noPlaceholder),
          firstFoldComplete: readBoolean(gates.firstFoldComplete),
          composerEditable: readBoolean(gates.composerEditable),
          windowVisibleFocused: readBoolean(gates.windowVisibleFocused),
        },
        signature: frame.signature === null ? null : readText(frame.signature),
        mutated: readBoolean(frame.mutated),
      };
    }),
  };
}

async function clickVisibleSessionActivation(page: Page, sessionId: string) {
  const selector = `[data-testid="rail-sidebar-session-row"][data-session-id="${cssEscape(sessionId)}"] [data-slot="navigation-row-activate"]`;
  const answer = readRecord(await page.evaluate(async (query) => {
    const elements = Array.from(document.querySelectorAll<HTMLElement>(query));
    const candidates: Array<Record<string, unknown>> = [];
    for (let index = 0; index < elements.length; index++) {
      const element = elements[index];
      element.scrollIntoView({ block: "center", inline: "center" });
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      const geometricallyVisible = !(
        rect.width <= 0 ||
        rect.height <= 0 ||
        rect.bottom <= 0 ||
        rect.right <= 0 ||
        rect.top >= innerHeight ||
        rect.left >= innerWidth ||
        style.display === "none" ||
        style.visibility === "hidden" ||
        Number(style.opacity) === 0
      );
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      const candidate = {
        geometricallyVisible,
        hitTarget: hit === element || (!!hit && element.contains(hit)),
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        hit: hit instanceof HTMLElement ? { tag: hit.tagName, testid: hit.dataset.testid, slot: hit.dataset.slot, label: hit.getAttribute("aria-label") } : undefined,
      };
      candidates.push(candidate);
      if (candidate.geometricallyVisible && candidate.hitTarget) return { index, candidates };
    }
    return { index: -1, candidates };
  }, selector));
  const index = readNumber(answer.index);
  if (index < 0) throw new Error(`Claxedo has no visible hit-testable session row for ${sessionId}: ${JSON.stringify(readRecords(answer.candidates))}`);
  await page.locator(selector).nth(index).click();
}

async function revealSessionRows(page: Page, sessionIds: readonly string[]) {
  // A multi-workspace inventory renders one project group per workspace.
  // Inactive groups start CLOSED — their session-list queries do not even
  // mount until the group opens — and every group paginates independently.
  // Open closed groups through their headers (the user's own flow), then
  // click the load-more buttons round-robin until every target row exists.
  for (let attempt = 0; attempt < 80; attempt++) {
    const state = readNumberFields(
      await page.evaluate(
        (ids) => ({
          missing: ids.filter(
            (id) =>
              !document.querySelector(
                `[data-testid="rail-sidebar-session-row"][data-session-id="${CSS.escape(id)}"]`,
              ),
          ).length,
          closedGroups: [
            ...document.querySelectorAll<HTMLElement>('[data-testid="project-group"]'),
          ].filter(
            (group) =>
              !group.querySelector('[data-testid="rail-sidebar-session-row"]'),
          ).length,
          loadMoreCount: document.querySelectorAll(
            '[data-testid="rail-sidebar-session-load-more"]',
          ).length,
          visibleRows: document.querySelectorAll(
            '[data-testid="rail-sidebar-session-row"]',
          ).length,
        }),
        [...sessionIds],
      ),
      ["missing", "closedGroups", "loadMoreCount", "visibleRows"],
    );
    if (state.missing === 0) return;
    if (state.closedGroups > 0) {
      await page
        .locator(
          '[data-testid="project-group"]:not(:has([data-testid="rail-sidebar-session-row"])) [data-testid="project-header"]',
        )
        .nth(0)
        // The active group can finish its already-enabled list request between
        // the snapshot above and this click. In that case the :not(:has(...))
        // locator correctly stops matching; resample instead of waiting thirty
        // seconds for a state that has already advanced.
        .click({ timeout: 1_000 })
        .catch(() => undefined);
      await page
        .waitForFunction(
          (previous) =>
            document.querySelectorAll('[data-testid="rail-sidebar-session-row"]')
              .length > previous,
          state.visibleRows,
          { timeout: 15_000 },
        )
        .catch(() => undefined);
      continue;
    }
    if (state.loadMoreCount === 0)
      throw new Error(
        `session sidebar is missing ${String(state.missing)} benchmark rows and has no next page`,
      );
    await page
      .getByTestId("rail-sidebar-session-load-more")
      .nth(attempt % state.loadMoreCount)
      .click();
    await page.waitForFunction(
      (previous) =>
        document.querySelectorAll('[data-testid="rail-sidebar-session-row"]')
          .length > previous.visibleRows ||
        document.querySelectorAll(
          '[data-testid="rail-sidebar-session-load-more"]',
        ).length !== previous.loadMoreCount,
      { visibleRows: state.visibleRows, loadMoreCount: state.loadMoreCount },
      { timeout: 15_000 },
    );
  }
  throw new Error(
    "session sidebar pagination did not expose all benchmark rows",
  );
}

function cssEscape(value: string) {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function installBrowserBenchmark() {
  if (window.__CLAXEDO_AGENT_APP_BENCHMARK__) return;

  let action: { token: string; trustedEventAtMs?: number } | undefined;
  const trustedEvent = (event: Event) => {
    if (!event.isTrusted) return;
    if (action && action.trustedEventAtMs === undefined)
      action.trustedEventAtMs = performance.now();
  };
  addEventListener("pointerdown", trustedEvent, true);
  addEventListener("keydown", trustedEvent, true);

  const afterPaint = () =>
    new Promise<number>((resolve, reject) => {
      const paintedFrames = window.__claxedoPaintedFrames;
      if (!paintedFrames) {
        reject(new Error("Claxedo painted-frame clock is not installed"));
        return;
      }
      const painted = (_: unknown, paintedAtMs: number) => {
        resolve(paintedAtMs);
        return true;
      };
      paintedFrames({ sample: () => undefined, painted });
    });

  window.__CLAXEDO_AGENT_APP_BENCHMARK__ = {
    armAction(token) {
      action = { token };
    },
    async finishAction(token) {
      if (!action || action.token !== token)
        return { state: "invalid", reason: "action-token-mismatch" };
      const trustedEventAtMs = action.trustedEventAtMs;
      action = undefined;
      if (trustedEventAtMs === undefined)
        return { state: "invalid", reason: "trusted-action-missing" };
      const endAtMs = await afterPaint();
      if (!Number.isFinite(endAtMs) || endAtMs < trustedEventAtMs)
        return { state: "invalid", reason: "invalid-end-timestamp" };
      return {
        state: "exact",
        durationMs: endAtMs - trustedEventAtMs,
        trustedEventAtMs,
        endAtMs,
      };
    },
  };
}
