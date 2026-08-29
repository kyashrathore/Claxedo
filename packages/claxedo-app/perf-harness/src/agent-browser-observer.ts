import type { BenchmarkPage as Page } from "./agent-cdp-page";
import {
  blockedFrameRatio,
  eventTimingP95,
  percentile,
  terminalThroughput,
  type AgentMetricValue,
} from "./agent-metrics";

type ActionResult =
  | {
      state: "exact";
      durationMs: number;
      trustedEventAtMs: number;
      paintedAtMs: number;
    }
  | { state: "invalid"; reason: string };

type TimelineCoverage = {
  overflowPx: number;
  topGapPx: number;
  visibleRowCount: number;
  virtualKeyCount: number;
  rowCount: number;
};

type PaintStabilityFrame = {
  atMs: number;
  ready: boolean;
  /** Harness JS plus any synchronous style/layout forced by semantic reads. */
  observerSampleMs: number;
  signature?: Record<string, unknown>;
  diagnostic?: Record<string, unknown>;
};

export type PaintedMessage = {
  messageId: string;
  kind: "UserMessage" | "AssistantPart";
  /**
   * The part-group identity of the painted row. An assistant message renders
   * one row PER PART GROUP, all stamped with the same message id, so the
   * message id alone cannot say which content the row shows — and a message
   * taller than the viewport never has its first text part on screen at the
   * bottom-anchored open, so content verification must be part-granular.
   */
  partId: string | undefined;
  textLength: number;
  contentSha256: string;
  composerVisibleAndEnabled: boolean;
  surfaceFocused: boolean;
  timelineCoverage: TimelineCoverage;
};

type SemanticTimelineTarget = {
  expectedMessageIds: readonly string[];
  expectedContentSha256: Readonly<Record<string, string>>;
  /** sha256(trimmed raw text) per latest-turn TEXT part id. */
  expectedTextPartSha256: Readonly<Record<string, string>>;
  /** Every latest-turn part id, text or not. */
  expectedPartIds: readonly string[];
};

export type SessionReadinessTarget = SemanticTimelineTarget & {
  sessionId: string;
  title: string;
};

type SessionActionResult =
  | Extract<ActionResult, { state: "invalid" }>
  | (Extract<ActionResult, { state: "exact" }> & {
      paintedMessage: PaintedMessage;
      paintStabilityFrames: PaintStabilityFrame[];
    });

type StreamEvidence = {
  startedAtMs: number;
  endedAtMs: number;
  durationMs: number;
  probeCount: number;
  durationThresholdMs: number;
  eventEntries: Array<{ interactionId: number; durationMs: number }>;
  loafSupported: boolean;
  loafEntries: Array<{ durationMs: number; blockingDurationMs: number }>;
};

type TerminalEvidence = {
  /**
   * Echoes that arrived further than the 64 KiB `parsedTail` window from the end
   * of their own batch. Recorded on every run at zero marginal cost so the
   * distribution of `bytesFromEnd` accumulates across ordinary benchmark runs
   * instead of needing a dedicated hunt: the gate opens below 65,536 and
   * `serialize()` can only still contain the echo below the ~340 KB scrollback,
   * so these two numbers bound how often each window is the binding one.
   */
  echoTailMisses: Array<{ echo: string; batchBytes: number; bytesFromEnd: number }>;
  instanceId: string;
  bytes: number;
  acceptedAtMs: number;
  paintedAtMs: number;
  modelHash: string;
  cols: number;
  rows: number;
  outputHash: string;
  outputHashAlgorithm: "sha256-chunk-tree-v1";
  inputDurationsMs: number[];
  inputWindows: Array<{ startTimestamp: number; endTimestamp: number }>;
};

type BrowserBenchmark = {
  armAction(token: string): void;
  finishAction(
    token: string,
    observedPaintAtMs?: number,
  ): Promise<ActionResult>;
  beginStream(): void;
  finishStream(): StreamEvidence;
  beginTerminal(input: {
    terminalId: string;
    instanceId: string;
    startSentinel: string;
    rawEndSentinel: string;
    modelEndSentinel: string;
    expectedEchoes: string[];
    bytes: number;
  }): void;
  armTerminalInput(expectedEcho: string): void;
  terminalOutputObserved(terminalId: string): boolean;
  terminalOutputIncludes(terminalId: string, text: string): boolean;
  terminalInputObserved(expectedEcho: string): boolean;
  terminalObservationStarted(): boolean;
  terminalObservationAcceptedBytes(): number;
  terminalAcceptedMarkerObserved(value: string): boolean;
  terminalObservationComplete(): boolean;
  terminalObservationStatus(): Record<string, unknown>;
  finishTerminal(): Promise<
    TerminalEvidence | { state: "invalid"; reason: string }
  >;
  terminalWriteAccepted(receipt: {
    data: string;
    acceptedAtMs: number;
    terminalId: string;
    instanceId: string;
  }): void;
  terminalWriteParsed(receipt: {
    data: string;
    serialize: () => string;
    dimensions: () => { cols: number; rows: number };
    parsedAtMs: number;
    terminalId: string;
    instanceId: string;
  }): void;
};

declare global {
  interface Window {
    __CLAXEDO_AGENT_APP_BENCHMARK__?: BrowserBenchmark;
  }
}

export function seededSwitchSequence<T>(values: readonly T[], seed: number) {
  const result = [...values];
  let state = seed >>> 0;
  const random = () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
  for (let index = result.length - 1; index > 0; index--) {
    const swap = Math.floor(random() * (index + 1));
    [result[index], result[swap]] = [result[swap]!, result[index]!];
  }
  return result;
}

export function warmSwitchPlan<T extends { sessionId: string }>(
  values: readonly T[],
  seed: number,
) {
  const warmup = [...values];
  // Headed runs should click top→bottom in rail order. `values` is already the
  // visible/created_desc sequence; do not reshuffle into a random path.
  void seed;
  const measured = [...values];
  if (measured[0]?.sessionId === warmup.at(-1)?.sessionId)
    measured.push(measured.shift()!);
  return { warmup, measured };
}

export function completeFirstFold(coverage: TimelineCoverage) {
  return (
    coverage.overflowPx <= 100 ||
    (coverage.visibleRowCount > 0 && coverage.topGapPx <= 96)
  );
}

/**
 * Content verification for the painted row, part-granular where possible:
 * - a row showing a TEXT part must hash-match that part's raw text;
 * - a row showing a transformed part (tool call, diff — rendered as a
 *   summary, so raw payload text can never hash-match the rendered text
 *   without duplicating the renderer) must be a real latest-turn part and
 *   have painted non-empty text;
 * - a row with no part identity (user rows, pre-part-id markup) falls back
 *   to the message-level sha.
 */
export function paintedContentVerification(
  message: PaintedMessage,
  target: SemanticTimelineTarget,
):
  | { mode: "text-part-sha256"; expectedSha256: string; passed: boolean }
  | { mode: "part-identity"; passed: boolean }
  | { mode: "message-sha256"; expectedSha256: string | undefined; passed: boolean } {
  if (message.kind === "AssistantPart" && message.partId !== undefined) {
    const expectedSha256 = target.expectedTextPartSha256[message.partId];
    if (expectedSha256 !== undefined)
      return {
        mode: "text-part-sha256",
        expectedSha256,
        passed: expectedSha256 === message.contentSha256,
      };
    return {
      mode: "part-identity",
      passed:
        target.expectedPartIds.includes(message.partId) &&
        message.textLength > 0,
    };
  }
  const expectedSha256 = target.expectedContentSha256[message.messageId];
  return {
    mode: "message-sha256",
    expectedSha256,
    passed: expectedSha256 === message.contentSha256,
  };
}

export function semanticTimelinePaintReady(
  message: PaintedMessage,
  target: SemanticTimelineTarget,
) {
  return (
    target.expectedMessageIds.includes(message.messageId) &&
    paintedContentVerification(message, target).passed &&
    message.textLength > 0 &&
    message.composerVisibleAndEnabled &&
    message.surfaceFocused &&
    completeFirstFold(message.timelineCoverage)
  );
}

export async function installAgentBrowserObserver(page: Page) {
  await page.addInitScript(installBrowserBenchmark);
  await page.evaluate(installBrowserBenchmark);
}

/**
 * Windows a side observation to exactly the interval the duration covers.
 *
 * A CPU profile of a session switch is only readable if it starts at the
 * trusted click and ends at the stable paint. Started any earlier it also
 * contains sidebar pagination — fixture discovery the measured duration
 * deliberately excludes — and every frame of that shows up as app cost that
 * no user pays.
 */
export type ActivationHooks = {
  /** After the action is armed, before the trusted click. */
  onArmed?: () => Promise<void>
  /** As soon as the stable painted frame is observed. */
  onPainted?: () => Promise<void>
}

export async function measureSessionActivation(
  page: Page,
  target: SessionReadinessTarget,
  hooks?: ActivationHooks,
): Promise<SessionActionResult> {
  // Pagination is fixture discovery, not session activation. Expose the target
  // through the same public sidebar path before arming the trusted-action clock.
  await revealSessionRows(page, [target.sessionId]);
  const token = `session:${target.sessionId}:${crypto.randomUUID()}`;
  await page.evaluate(
    (next) => window.__CLAXEDO_AGENT_APP_BENCHMARK__?.armAction(next),
    token,
  );
  await hooks?.onArmed?.();
  // Install the semantic paint observer before the trusted pointerdown. The
  // old order clicked, waited for a locator in Node, then made another browser
  // round trip before sampling; if the app painted during that gap, the clock
  // still charged two later confirmation frames to the product.
  const stablePaintPromise = page.evaluate(
    ({
      id,
      expectedMessageIds,
      expectedContentSha256,
    }: {
      id: string;
      expectedMessageIds: string[];
      expectedContentSha256: Record<string, string>;
    }) =>
      new Promise<{
        paintedAtMs: number;
        paintedMessage: Omit<PaintedMessage, "contentSha256">;
        contentText: string;
        frames: PaintStabilityFrame[];
      }>(
        (resolve, reject) => {
          const expected = new Set(expectedMessageIds);
          const deadline = performance.now() + 30_000;
          let previousSignature: string | undefined;
          const frames: PaintStabilityFrame[] = [];
          const hashText = (value: string) => {
            let hash = 2_166_136_261;
            for (let index = 0; index < value.length; index++) {
              hash ^= value.charCodeAt(index);
              hash = Math.imul(hash, 16_777_619) >>> 0;
            }
            return hash;
          };
          const timeoutDiagnostic = () => {
            const candidate = document.querySelector<HTMLElement>(
              `[data-testid="session-page-root"][data-session-id="${CSS.escape(id)}"]`,
            );
            const surface = candidate?.closest<HTMLElement>("[data-workbench-content]");
            const composer = candidate?.querySelector<HTMLElement>('[data-component="prompt-input"]');
            const timeline = candidate?.querySelector<HTMLElement>("[data-session-timeline-root]");
            const viewport = timeline?.querySelector<HTMLElement>(
              '[data-slot="session-timeline-scroll"] [data-scrollable]',
            );
            const rect = (element: HTMLElement | null | undefined) => {
              if (!element) return undefined;
              const bounds = element.getBoundingClientRect();
              const style = getComputedStyle(element);
              return {
                display: style.display,
                visibility: style.visibility,
                opacity: style.opacity,
                x: Math.round(bounds.x * 10) / 10,
                y: Math.round(bounds.y * 10) / 10,
                width: Math.round(bounds.width * 10) / 10,
                height: Math.round(bounds.height * 10) / 10,
              };
            };
            const expectedRows = candidate
              ? [...candidate.querySelectorAll<HTMLElement>("[data-content-message-id]")]
                .filter((item) => expected.has(item.dataset.contentMessageId ?? ""))
                .slice(0, 8)
                .map((item) => ({
                  messageId: item.dataset.contentMessageId,
                  partId: item.dataset.contentPartId,
                  timelineRow: item.dataset.timelineRow,
                  textLength: item.innerText.trim().length,
                  rect: rect(item),
                }))
              : [];
            return {
              root: rect(candidate),
              selectionSync: {
                activeRailSessionIds: [
                  ...document.querySelectorAll<HTMLElement>(
                    '[data-testid="rail-sidebar-session-row"][data-active="true"]',
                  ),
                ].map((row) => row.dataset.sessionId ?? ""),
                visibleSessionIds: [
                  ...document.querySelectorAll<HTMLElement>("[data-testid='session-page-root']"),
                ]
                  .filter((root) => {
                    const host = root.closest<HTMLElement>("[data-workbench-content]");
                    return !!host && host.getAttribute("aria-hidden") !== "true" && !host.hasAttribute("inert");
                  })
                  .map((root) => root.dataset.sessionId ?? ""),
              },
              sessionState: {
                firstFoldReady: candidate?.dataset.sessionFirstFoldReady,
                messagesReady: candidate?.dataset.sessionMessagesReady,
                messageCount: candidate?.dataset.sessionMessageCount,
                conversationCount: candidate?.dataset.sessionConversationCount,
                visibleUserCount: candidate?.dataset.sessionVisibleUserCount,
                renderedUserCount: candidate?.dataset.sessionRenderedUserCount,
                timelineLoading: !!candidate?.querySelector("[data-session-timeline-loading]"),
                unavailable: !!candidate?.querySelector('[data-testid="session-unavailable"]'),
              },
              surface: {
                rect: rect(surface),
                ariaHidden: surface?.getAttribute("aria-hidden"),
                inert: surface?.hasAttribute("inert"),
              },
              composer: {
                rect: rect(composer),
                ariaDisabled: composer?.getAttribute("aria-disabled"),
                contenteditable: composer?.getAttribute("contenteditable"),
              },
              timeline: {
                rect: rect(timeline),
                revealReady: timeline?.dataset.sessionTimelineRevealReady,
                progressiveReady: timeline?.dataset.sessionTimelineProgressiveReady,
                rowCount: timeline?.dataset.sessionTimelineRowCount,
                virtualKeyCount: timeline?.dataset.sessionTimelineKeyCount,
              },
              viewport: viewport
                ? {
                    rect: rect(viewport),
                    scrollTop: viewport.scrollTop,
                    scrollHeight: viewport.scrollHeight,
                    clientHeight: viewport.clientHeight,
                    mountedKeys: [...viewport.querySelectorAll<HTMLElement>("[data-timeline-key]")]
                      .slice(-8)
                      .map((item) => item.dataset.timelineKey),
                  }
                : undefined,
              expectedRows,
              documentFocused: document.hasFocus(),
              documentVisibility: document.visibilityState,
              previousSignature,
            };
          };
          const sample = ():
            | {
                signature: string;
                signatureValue: Record<string, unknown>;
                paintedMessage: Omit<PaintedMessage, "contentSha256">;
                contentText: string;
              }
            | undefined => {
            const candidate = document.querySelector<HTMLElement>(
              `[data-testid="session-page-root"][data-session-id="${CSS.escape(id)}"]`,
            );
            if (!candidate) return undefined;
            const surface = candidate.closest<HTMLElement>(
              "[data-workbench-content]",
            );
            if (
              !surface ||
              surface.getAttribute("aria-hidden") === "true" ||
              surface.hasAttribute("inert")
            )
              return undefined;
            // Left/right sync: the rail's selected row and the painted session
            // root must agree on this activation. A draft or previous session
            // still owning the pane while another row looks selected is a fail.
            const activeRows = [
              ...document.querySelectorAll<HTMLElement>(
                '[data-testid="rail-sidebar-session-row"][data-active="true"]',
              ),
            ];
            const activeIds = activeRows.map((row) => row.dataset.sessionId ?? "");
            if (activeIds.length !== 1 || activeIds[0] !== id) return undefined;
            const visibleSessionRoots = [
              ...document.querySelectorAll<HTMLElement>("[data-testid='session-page-root']"),
            ].filter((root) => {
              const host = root.closest<HTMLElement>("[data-workbench-content]");
              if (!host || host.getAttribute("aria-hidden") === "true" || host.hasAttribute("inert")) {
                return false;
              }
              const style = getComputedStyle(root);
              const bounds = root.getBoundingClientRect();
              return (
                style.display !== "none" &&
                style.visibility !== "hidden" &&
                Number(style.opacity) !== 0 &&
                bounds.width > 0 &&
                bounds.height > 0
              );
            });
            if (
              visibleSessionRoots.length !== 1 ||
              visibleSessionRoots[0]?.dataset.sessionId !== id ||
              visibleSessionRoots.some((root) => root.dataset.sessionId === "new")
            ) {
              return undefined;
            }
            const composer = candidate.querySelector<HTMLElement>(
              '[data-component="prompt-input"]',
            );
            const composerStyle = composer ? getComputedStyle(composer) : undefined;
            const composerBounds = composer?.getBoundingClientRect();
            const composerVisibleAndEnabled = !!(
              composer &&
              composerStyle &&
              composerBounds &&
              composerStyle.display !== "none" &&
              composerStyle.visibility !== "hidden" &&
              Number(composerStyle.opacity) !== 0 &&
              composerBounds.width > 0 &&
              composerBounds.height > 0 &&
              composer.getAttribute("aria-disabled") !== "true" &&
              composer.getAttribute("contenteditable") === "true"
            );
            const surfaceFocused = document.visibilityState === "visible" && document.hasFocus();
            if (!composerVisibleAndEnabled || !surfaceFocused) return undefined;
            // KTD11: app-specific progressive and staged-ready markers never
            // end the neutral clock. Canonical DOM content, generic geometry,
            // composer usability, focus, and two equal frames are sufficient.
            const timeline = candidate.querySelector<HTMLElement>(
              "[data-session-timeline-root]",
            );
            if (!timeline) return undefined;
            const viewport = timeline.querySelector<HTMLElement>(
              '[data-slot="session-timeline-scroll"] [data-scrollable]',
            );
            if (!viewport) return undefined;
            const view = viewport.getBoundingClientRect();
            const visible = (element: HTMLElement) => {
              const style = getComputedStyle(element);
              const bounds = element.getBoundingClientRect();
              return (
                style.display !== "none" &&
                style.visibility !== "hidden" &&
                Number(style.opacity) !== 0 &&
                bounds.width > 0 &&
                bounds.height > 0 &&
                bounds.bottom > view.top &&
                bounds.top < view.bottom
              );
            };
            const virtualRows = [
              ...viewport.querySelectorAll<HTMLElement>("[data-timeline-key]"),
            ]
              .filter(visible)
              .sort(
                (left, right) =>
                  left.getBoundingClientRect().top -
                  right.getBoundingClientRect().top,
              );
            const timelineCoverage = {
              overflowPx: Math.max(
                0,
                viewport.scrollHeight - viewport.clientHeight,
              ),
              topGapPx: Math.max(
                0,
                (virtualRows[0]?.getBoundingClientRect().top ?? view.bottom) -
                  view.top,
              ),
              visibleRowCount: virtualRows.length,
              virtualKeyCount: Number(timeline.dataset.sessionTimelineKeyCount),
              rowCount: Number(timeline.dataset.sessionTimelineRowCount),
            };
            const row = [
              ...candidate.querySelectorAll<HTMLElement>(
                '[data-timeline-row="UserMessage"][data-content-message-id], [data-timeline-row="AssistantPart"][data-content-message-id]',
              ),
            ].find(
              (item) =>
                item.dataset.contentMessageId &&
                expected.has(item.dataset.contentMessageId) &&
                visible(item),
            );
            const kind = row?.dataset.timelineRow;
            const messageId = row?.dataset.contentMessageId;
            const partId = row?.dataset.contentPartId;
            const content =
              kind === "AssistantPart" && partId
                ? row?.querySelector<HTMLElement>(
                    `[data-component="text-part"][data-timeline-part-id="${CSS.escape(partId)}"] [data-slot="text-part-body"]`,
                  )
                : kind === "UserMessage"
                  ? row?.querySelector<HTMLElement>(
                      '[data-slot="user-message-text"]',
                    )
                  : undefined;
            const text = (content ?? row)?.innerText.trim() ?? "";
            const completeFirstFold =
              timelineCoverage.overflowPx <= 100 ||
              (timelineCoverage.visibleRowCount > 0 &&
                timelineCoverage.topGapPx <= 96);
            if (
              !row ||
              !messageId ||
              (kind !== "UserMessage" && kind !== "AssistantPart") ||
              text.length === 0 ||
              row.querySelector('[data-slot="skeleton"]') ||
              !completeFirstFold
            )
              return undefined;
            const paintedMessage: Omit<PaintedMessage, "contentSha256"> = {
              messageId,
              kind,
              partId,
              textLength: text.length,
              composerVisibleAndEnabled,
              surfaceFocused,
              timelineCoverage,
            };
            const signatureValue = {
              messageId,
              partId,
              textLength: text.length,
              textHash: hashText(text),
              scrollTop: Math.round(viewport.scrollTop * 10) / 10,
              scrollHeight: viewport.scrollHeight,
              clientHeight: viewport.clientHeight,
              timelineCoverage,
              rows: virtualRows.map((item) => {
                const bounds = item.getBoundingClientRect();
                const rowText = item.innerText.trim();
                return [
                  item.dataset.timelineKey,
                  item.querySelector<HTMLElement>("[data-message-id]")?.dataset
                    .messageId,
                  rowText.length,
                  hashText(rowText),
                  Math.round(bounds.top * 10) / 10,
                  Math.round(bounds.height * 10) / 10,
                ];
              }),
            };
            return { signature: JSON.stringify(signatureValue), signatureValue, paintedMessage, contentText: text };
          };
          const notReadyDiagnostic = () => {
            const candidate = document.querySelector<HTMLElement>(
              `[data-testid="session-page-root"][data-session-id="${CSS.escape(id)}"]`,
            );
            const surface = candidate?.closest<HTMLElement>("[data-workbench-content]");
            const composer = candidate?.querySelector<HTMLElement>('[data-component="prompt-input"]');
            const timeline = candidate?.querySelector<HTMLElement>("[data-session-timeline-root]");
            const viewport = timeline?.querySelector<HTMLElement>(
              '[data-slot="session-timeline-scroll"] [data-scrollable]',
            );
            const expectedRows = candidate
              ? [...candidate.querySelectorAll<HTMLElement>("[data-content-message-id]")]
                .filter((row) => expected.has(row.dataset.contentMessageId ?? ""))
              : [];
            const visibleExpectedRows = viewport
              ? expectedRows.filter((row) => {
                  const bounds = row.getBoundingClientRect();
                  const view = viewport.getBoundingClientRect();
                  const style = getComputedStyle(row);
                  return style.visibility !== "hidden" && bounds.height > 0 && bounds.bottom > view.top && bounds.top < view.bottom;
                })
              : [];
            return {
              root: !!candidate,
              surfaceHidden: !surface || surface.getAttribute("aria-hidden") === "true" || surface.hasAttribute("inert"),
              composer: !!composer,
              composerEditable: composer?.getAttribute("contenteditable"),
              timeline: !!timeline,
              timelineVisibility: timeline ? getComputedStyle(timeline).visibility : undefined,
              revealReady: timeline?.dataset.sessionTimelineRevealReady,
              progressiveReady: timeline?.dataset.sessionTimelineProgressiveReady,
              viewport: !!viewport,
              expectedRows: expectedRows.length,
              visibleExpectedRows: visibleExpectedRows.length,
              expectedTextLengths: visibleExpectedRows.slice(0, 3).map((row) => row.innerText.trim().length),
              virtualKeys: timeline?.dataset.sessionTimelineKeyCount,
            };
          };
          const frame = (paintedAtMs: number) => {
            const observerStartedAtMs = performance.now();
            const current = sample();
            const diagnostic = current || !window.__claxedoPerfTrace ? undefined : notReadyDiagnostic();
            frames.push({
              atMs: paintedAtMs,
              ready: !!current,
              observerSampleMs: performance.now() - observerStartedAtMs,
              signature: current?.signatureValue,
              diagnostic,
            });
            if (current && current.signature === previousSignature) {
              resolve({
                paintedAtMs,
                paintedMessage: current.paintedMessage,
                contentText: current.contentText,
                frames,
              });
              return;
            }
            previousSignature = current?.signature;
            if (performance.now() >= deadline) {
              reject(
                new Error(
                  `Claxedo timeline did not paint a stable canonical latest-turn message: ${JSON.stringify(timeoutDiagnostic())}`,
                ),
              );
              return;
            }
            requestAnimationFrame(frame);
          };
          requestAnimationFrame(frame);
        },
      ),
    {
      id: target.sessionId,
      expectedMessageIds: [...target.expectedMessageIds],
      expectedContentSha256: { ...target.expectedContentSha256 },
    },
  );
  await clickVisibleSessionActivation(page, target.sessionId);
  const stablePaint = await stablePaintPromise;
  await hooks?.onPainted?.();
  const contentSha256 = stablePaint
    ? await sha256Text(stablePaint.contentText)
    : "";
  const paintedMessage = stablePaint
    ? { ...stablePaint.paintedMessage, contentSha256 }
    : undefined;
  const timing = await page.evaluate<
    ActionResult,
    { token: string; paintedAtMs?: number }
  >(
    async (input) =>
      (await window.__CLAXEDO_AGENT_APP_BENCHMARK__?.finishAction(
        input.token,
        input.paintedAtMs,
      )) ?? {
        state: "invalid",
        reason: "browser-observer-missing",
      },
    { token, paintedAtMs: stablePaint?.paintedAtMs },
  );
  if (timing.state !== "exact") return timing;
  if (!stablePaint)
    return {
      state: "invalid",
      reason: "visible-real-message-missing-after-stable-paint",
    };
  if (!paintedMessage || !semanticTimelinePaintReady(paintedMessage, target)) {
    return {
      state: "invalid",
      reason: `invalid-semantic-paint:${JSON.stringify(paintedMessage)}`,
    };
  }
  return { ...timing, paintedMessage, paintStabilityFrames: stablePaint.frames };
}

async function clickVisibleSessionActivation(page: Page, sessionId: string) {
  const selector = `[data-testid="rail-sidebar-session-row"][data-session-id="${cssEscape(sessionId)}"] [data-slot="navigation-row-activate"]`;
  const result = await page.evaluate(async (query) => {
    const elements = Array.from(document.querySelectorAll<HTMLElement>(query));
    const candidates: Array<Record<string, unknown>> = [];
    for (let index = 0; index < elements.length; index++) {
      const element = elements[index]!;
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
  }, selector);
  if (result.index < 0) throw new Error(`Claxedo has no visible hit-testable session row for ${sessionId}: ${JSON.stringify(result.candidates)}`);
  await page.locator(selector).nth(result.index).click();
}

async function sha256Text(value: string) {
  const bytes = new TextEncoder().encode(value.trim().replace(/\s+/gu, " "));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function measureWarmSwitches(
  page: Page,
  targets: readonly SessionReadinessTarget[],
  seed: number,
) {
  if (targets.length !== 20)
    throw new Error("warm switch requires exactly twenty work items");
  const sessionIds = targets.map((target) => target.sessionId);
  await revealSessionRows(page, sessionIds);
  // Establish the warm condition through the same public UI path before any
  // measured switch. The final warm-up target is known, so rotate the seeded
  // order if necessary to keep the first measurement a real switch too.
  const plan = warmSwitchPlan(targets, seed);
  for (const target of plan.warmup) {
    const warmed = await measureSessionActivation(page, target);
    if (warmed.state !== "exact") {
      return {
        metric: { state: "invalid", reason: warmed.reason } as AgentMetricValue,
        sequence: [],
      };
    }
  }
  const samples: number[] = [];
  const actions: Array<Extract<SessionActionResult, { state: "exact" }>> = [];
  for (const target of plan.measured) {
    const result = await measureSessionActivation(page, target);
    if (result.state !== "exact")
      return {
        metric: { state: "invalid", reason: result.reason } as AgentMetricValue,
        sequence: plan.measured,
      };
    samples.push(result.durationMs);
    actions.push(result);
  }
  return {
    metric: {
      state: "exact",
      value: percentile(samples, 95),
      unit: "ms",
    } as AgentMetricValue,
    samples,
    actions,
    sequence: plan.measured,
  };
}

async function revealSessionRows(page: Page, sessionIds: readonly string[]) {
  // A multi-workspace inventory renders one project group per workspace.
  // Inactive groups start CLOSED — their session-list queries do not even
  // mount until the group opens — and every group paginates independently.
  // Open closed groups through their headers (the user's own flow), then
  // click the load-more buttons round-robin until every target row exists.
  for (let attempt = 0; attempt < 80; attempt++) {
    const state = await page.evaluate(
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

export async function beginStreamObservation(page: Page) {
  await page.evaluate(() =>
    window.__CLAXEDO_AGENT_APP_BENCHMARK__?.beginStream(),
  );
}

export async function finishStreamObservation(page: Page) {
  const evidence = await page.evaluate(() =>
    window.__CLAXEDO_AGENT_APP_BENCHMARK__?.finishStream(),
  );
  if (!evidence) {
    const invalid = invalidMetric("browser-observer-missing");
    return { interaction: invalid, blockedFrames: invalid };
  }
  return {
    interaction: eventTimingP95({
      probeCount: evidence.probeCount,
      durationThresholdMs: evidence.durationThresholdMs,
      entries: evidence.eventEntries,
    }),
    blockedFrames: blockedFrameRatio({
      scenarioDurationMs: evidence.durationMs,
      supported: evidence.loafSupported,
      entries: evidence.loafEntries,
    }),
    evidence,
  };
}

export async function beginTerminalObservation(
  page: Page,
  input: {
    terminalId: string;
    instanceId: string;
    startSentinel: string;
    rawEndSentinel: string;
    modelEndSentinel: string;
    expectedEchoes: string[];
    bytes: number;
  },
) {
  await page.evaluate(
    (value) => window.__CLAXEDO_AGENT_APP_BENCHMARK__?.beginTerminal(value),
    input,
  );
}

export async function finishTerminalObservation(
  page: Page,
  expected: { outputHash: string; bytes: number; minimumDurationMs: number },
) {
  const evidence = await page.evaluate(() =>
    window.__CLAXEDO_AGENT_APP_BENCHMARK__?.finishTerminal(),
  );
  if (!evidence || "state" in evidence) {
    return {
      metric: invalidMetric(evidence?.reason ?? "browser-observer-missing"),
      evidence,
    };
  }
  return {
    metric: terminalThroughput({
      bytes: evidence.bytes,
      startedAtMs: evidence.acceptedAtMs,
      paintedAtMs: evidence.paintedAtMs,
      exactModelHash:
        evidence.outputHash === expected.outputHash &&
        evidence.bytes === expected.bytes,
      concurrentInputP95Ms: percentile(evidence.inputDurationsMs, 95),
      minimumDurationMs: expected.minimumDurationMs,
    }),
    inputMetric:
      evidence.inputDurationsMs.length === 0
        ? invalidMetric("terminal-input-evidence-missing")
        : ({
            state: "exact",
            value: percentile(evidence.inputDurationsMs, 95),
            unit: "ms",
          } as AgentMetricValue),
    evidence,
  };
}

function cssEscape(value: string) {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function invalidMetric(reason: string): AgentMetricValue {
  return { state: "invalid", reason };
}

function installBrowserBenchmark() {
  if (window.__CLAXEDO_AGENT_APP_BENCHMARK__) return;

  const durationThresholdMs = 16;
  let action: { token: string; trustedEventAtMs?: number } | undefined;
  let stream:
    | {
        startedAtMs: number;
        probeCount: number;
        events: Map<number, number>;
        probes: Array<{ atMs: number; type: string; matched: boolean }>;
        interactionIds: Set<number>;
        loafs: Array<{ durationMs: number; blockingDurationMs: number }>;
      }
    | undefined;
  let terminal:
    | {
        startSentinel: string;
        rawEndSentinel: string;
        modelEndSentinel: string;
        expectedEchoes: string[];
        terminalId: string;
        instanceId: string;
        bytes: number;
        acceptedAtMs?: number;
        paintedAtMs?: number;
        model?: string;
        cols?: number;
        rows?: number;
        inputStarts: number[];
        inputDurationsMs: number[];
        inputPaintedAtMs: number[];
        inputPaintPending: Set<number>;
        pendingInputIndex?: number;
        acceptedTail: string;
        acceptedChunks: Array<{ data: string; atMs: number }>;
        acceptedEndTail: string;
        acceptedHashBuffer: Uint8Array;
        acceptedHashLength: number;
        acceptedHashDigests: Array<Promise<ArrayBuffer>>;
        acceptedBytes: number;
        acceptedComplete?: boolean;
        startSentinelOverflow?: boolean;
        parsedTail: string;
        echoTailMisses: Array<{ echo: string; batchBytes: number; bytesFromEnd: number }>;
        foreignAcceptedCount: number;
        foreignParsedCount: number;
      }
    | undefined;
  const terminalsWithParsedOutput = new Set<string>();
  const terminalParsedTails = new Map<string, string>();

  const trustedEvent = (event: Event) => {
    if (!event.isTrusted) return;
    if (action && action.trustedEventAtMs === undefined)
      action.trustedEventAtMs = performance.now();
    if (stream && (event.type === "pointerdown" || event.type === "keydown")) {
      stream.probeCount++;
      stream.probes.push({
        atMs: event.timeStamp,
        type: event.type,
        matched: false,
      });
    }
    if (
      terminal &&
      event.type === "keydown" &&
      terminal.pendingInputIndex !== undefined
    ) {
      terminal.inputStarts[terminal.pendingInputIndex] = performance.now();
      terminal.pendingInputIndex = undefined;
    }
  };
  addEventListener("pointerdown", trustedEvent, true);
  addEventListener("keydown", trustedEvent, true);

  let eventObserver: PerformanceObserver | undefined;
  const processEventEntries = (entries: PerformanceEntry[]) => {
    if (!stream) return;
    for (const raw of entries) {
      const entry = raw as PerformanceEntry & { interactionId?: number };
      if (!entry.interactionId || entry.duration < durationThresholdMs)
        continue;
      if (!stream.interactionIds.has(entry.interactionId)) {
        const probe = stream.probes.find(
          (candidate) =>
            !candidate.matched &&
            candidate.type === entry.name &&
            Math.abs(candidate.atMs - entry.startTime) <= 8,
        );
        if (!probe) continue;
        probe.matched = true;
        stream.interactionIds.add(entry.interactionId);
      }
      stream.events.set(
        entry.interactionId,
        Math.max(stream.events.get(entry.interactionId) ?? 0, entry.duration),
      );
    }
  };
  try {
    eventObserver = new PerformanceObserver((list) =>
      processEventEntries(list.getEntries()),
    );
    eventObserver.observe({
      type: "event",
      buffered: false,
      durationThreshold: durationThresholdMs,
    } as PerformanceObserverInit);
  } catch {
    eventObserver?.disconnect();
  }

  const loafSupported = PerformanceObserver.supportedEntryTypes.includes(
    "long-animation-frame",
  );
  let loafObserver: PerformanceObserver | undefined;
  const processLoafEntries = (entries: PerformanceEntry[]) => {
    if (!stream) return;
    for (const raw of entries) {
      const entry = raw as PerformanceEntry & { blockingDuration?: number };
      stream.loafs.push({
        durationMs: entry.duration,
        blockingDurationMs: entry.blockingDuration ?? 0,
      });
    }
  };
  if (loafSupported) {
    loafObserver = new PerformanceObserver((list) =>
      processLoafEntries(list.getEntries()),
    );
    loafObserver.observe({ type: "long-animation-frame", buffered: false });
  }

  const afterPaint = () =>
    new Promise<number>((resolve) => {
      requestAnimationFrame(() =>
        requestAnimationFrame(() => resolve(performance.now())),
      );
    });
  const hash = async (value: string) => {
    const bytes = new TextEncoder().encode(value);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
  };
  const appendTerminalHash = (current: NonNullable<typeof terminal>, value: string) => {
    const bytes = new TextEncoder().encode(value);
    current.acceptedBytes += bytes.byteLength;
    let offset = 0;
    while (offset < bytes.byteLength) {
      const count = Math.min(
        current.acceptedHashBuffer.byteLength - current.acceptedHashLength,
        bytes.byteLength - offset,
      );
      current.acceptedHashBuffer.set(bytes.subarray(offset, offset + count), current.acceptedHashLength);
      current.acceptedHashLength += count;
      offset += count;
      if (current.acceptedHashLength !== current.acceptedHashBuffer.byteLength) continue;
      const block = current.acceptedHashBuffer;
      current.acceptedHashDigests.push(crypto.subtle.digest("SHA-256", block.buffer as ArrayBuffer));
      current.acceptedHashBuffer = new Uint8Array(1024 * 1024);
      current.acceptedHashLength = 0;
    }
  };
  const appendTerminalAccepted = (current: NonNullable<typeof terminal>, value: string) => {
    if (current.acceptedComplete) return;
    const combined = current.acceptedEndTail + value;
    const endIndex = combined.indexOf(current.rawEndSentinel);
    if (endIndex >= 0) {
      appendTerminalHash(current, combined.slice(0, endIndex + current.rawEndSentinel.length));
      current.acceptedEndTail = "";
      current.acceptedComplete = true;
      return;
    }
    const retainedChars = Math.max(0, current.rawEndSentinel.length - 1);
    const confirmedEnd = Math.max(0, combined.length - retainedChars);
    if (confirmedEnd > 0) appendTerminalHash(current, combined.slice(0, confirmedEnd));
    current.acceptedEndTail = combined.slice(confirmedEnd);
  };
  const finishTerminalHash = async (current: NonNullable<typeof terminal>) => {
    if (current.acceptedHashLength > 0) {
      const block = current.acceptedHashBuffer.slice(0, current.acceptedHashLength);
      current.acceptedHashDigests.push(crypto.subtle.digest("SHA-256", block.buffer as ArrayBuffer));
      current.acceptedHashLength = 0;
    }
    const digests = await Promise.all(current.acceptedHashDigests);
    const tree = new Uint8Array(digests.length * 32);
    digests.forEach((digest, index) => tree.set(new Uint8Array(digest), index * 32));
    const root = await crypto.subtle.digest("SHA-256", tree);
    return Array.from(new Uint8Array(root), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
  };

  window.__CLAXEDO_AGENT_APP_BENCHMARK__ = {
    armAction(token) {
      action = { token };
    },
    async finishAction(token, observedPaintAtMs) {
      if (!action || action.token !== token)
        return { state: "invalid", reason: "action-token-mismatch" };
      const trustedEventAtMs = action.trustedEventAtMs;
      action = undefined;
      if (trustedEventAtMs === undefined)
        return { state: "invalid", reason: "trusted-action-missing" };
      // An already-active destination can satisfy the semantic observer before
      // the trusted row click is dispatched. That observation cannot timestamp
      // the click's presentation; wait for the canonical post-input paint
      // instead of returning an impossible negative interval.
      const paintedAtMs = observedPaintAtMs !== undefined && observedPaintAtMs >= trustedEventAtMs
        ? observedPaintAtMs
        : await afterPaint();
      if (!Number.isFinite(paintedAtMs) || paintedAtMs < trustedEventAtMs)
        return { state: "invalid", reason: "invalid-paint-timestamp" };
      return {
        state: "exact",
        durationMs: paintedAtMs - trustedEventAtMs,
        trustedEventAtMs,
        paintedAtMs,
      };
    },
    beginStream() {
      stream = {
        startedAtMs: performance.now(),
        probeCount: 0,
        events: new Map(),
        probes: [],
        interactionIds: new Set(),
        loafs: [],
      };
    },
    finishStream() {
      processEventEntries(eventObserver?.takeRecords() ?? []);
      processLoafEntries(loafObserver?.takeRecords() ?? []);
      const current = stream;
      stream = undefined;
      if (!current) {
        return {
          startedAtMs: 0,
          endedAtMs: 0,
          durationMs: 0,
          probeCount: 0,
          durationThresholdMs,
          eventEntries: [],
          loafSupported,
          loafEntries: [],
        };
      }
      const endedAtMs = performance.now();
      return {
        startedAtMs: current.startedAtMs,
        endedAtMs,
        durationMs: endedAtMs - current.startedAtMs,
        probeCount: current.probeCount,
        durationThresholdMs,
        eventEntries: Array.from(
          current.events,
          ([interactionId, durationMs]) => ({ interactionId, durationMs }),
        ),
        loafSupported,
        loafEntries: current.loafs,
      };
    },
    beginTerminal(input) {
      terminal = {
        ...input,
        inputStarts: [],
        inputDurationsMs: [],
        inputPaintedAtMs: [],
        inputPaintPending: new Set(),
        acceptedTail: "",
        acceptedChunks: [],
        acceptedEndTail: "",
        acceptedHashBuffer: new Uint8Array(1024 * 1024),
        acceptedHashLength: 0,
        acceptedHashDigests: [],
        acceptedBytes: 0,
        parsedTail: "",
        echoTailMisses: [],
        foreignAcceptedCount: 0,
        foreignParsedCount: 0,
      };
    },
    armTerminalInput(expectedEcho) {
      if (!terminal) return;
      const index = terminal.expectedEchoes.indexOf(expectedEcho);
      if (index >= 0) terminal.pendingInputIndex = index;
    },
    terminalOutputObserved(terminalId) {
      return terminalsWithParsedOutput.has(terminalId);
    },
    terminalOutputIncludes(terminalId, text) {
      return terminalParsedTails.get(terminalId)?.includes(text) === true;
    },
    terminalInputObserved(expectedEcho) {
      if (!terminal) return false;
      const index = terminal.expectedEchoes.indexOf(expectedEcho);
      return index >= 0 && terminal.inputDurationsMs[index] !== undefined;
    },
    terminalObservationStarted() {
      return !!(
        terminal &&
        terminal.acceptedAtMs !== undefined &&
        terminal.parsedTail.includes(terminal.startSentinel)
      );
    },
    terminalObservationAcceptedBytes() {
      if (!terminal || terminal.acceptedAtMs === undefined) return 0;
      return terminal.acceptedBytes + new TextEncoder().encode(terminal.acceptedEndTail).byteLength;
    },
    terminalAcceptedMarkerObserved(value) {
      return !!terminal?.acceptedEndTail.includes(value);
    },
    terminalObservationComplete() {
      return (
        terminal?.paintedAtMs !== undefined &&
        terminal.inputDurationsMs.filter((value) => value !== undefined)
          .length === terminal.expectedEchoes.length
      );
    },
    terminalObservationStatus() {
      if (!terminal) return { active: false };
      return {
        active: true,
        instanceId: terminal.instanceId,
        acceptedStarted: terminal.acceptedAtMs !== undefined,
        acceptedComplete: terminal.acceptedComplete === true,
        parsedReachedEnd: terminal.parsedTail.includes(terminal.modelEndSentinel),
        modelCaptured: terminal.model !== undefined,
        painted: terminal.paintedAtMs !== undefined,
        inputCount: terminal.inputDurationsMs.filter((value) => value !== undefined).length,
        expectedInputCount: terminal.expectedEchoes.length,
        foreignAcceptedCount: terminal.foreignAcceptedCount,
        foreignParsedCount: terminal.foreignParsedCount,
      };
    },
    async finishTerminal() {
      const current = terminal;
      terminal = undefined;
      if (current?.startSentinelOverflow)
        return { state: "invalid", reason: "terminal-start-sentinel-missing" };
      if (
        current?.acceptedAtMs === undefined ||
        !current.acceptedComplete ||
        current.paintedAtMs === undefined ||
        current.model === undefined ||
        current.cols === undefined ||
        current.rows === undefined
      ) {
        return { state: "invalid", reason: "terminal-output-incomplete" };
      }
      return {
        instanceId: current.instanceId,
        bytes: current.acceptedBytes,
        acceptedAtMs: current.acceptedAtMs,
        paintedAtMs: current.paintedAtMs,
        modelHash: await hash(current.model),
        cols: current.cols,
        rows: current.rows,
        outputHash: await finishTerminalHash(current),
        outputHashAlgorithm: "sha256-chunk-tree-v1" as const,
        echoTailMisses: current.echoTailMisses,
        inputDurationsMs: current.inputDurationsMs,
        inputWindows: current.inputDurationsMs.map((_, index) => ({
          startTimestamp: current.inputStarts[index]!,
          endTimestamp: current.inputPaintedAtMs[index]!,
        })),
      };
    },
    terminalWriteAccepted(receipt) {
      if (!terminal || receipt.terminalId !== terminal.terminalId) return;
      if (receipt.instanceId !== terminal.instanceId) {
        terminal.foreignAcceptedCount += 1;
        return;
      }
      if (terminal.acceptedAtMs !== undefined) {
        appendTerminalAccepted(terminal, receipt.data);
        return;
      }
      terminal.acceptedChunks.push({
        data: receipt.data,
        atMs: receipt.acceptedAtMs,
      });
      terminal.acceptedTail += receipt.data;
      const sentinelIndex = terminal.acceptedTail.indexOf(
        terminal.startSentinel,
      );
      if (sentinelIndex >= 0) {
        let offset = 0;
        terminal.acceptedAtMs = terminal.acceptedChunks.find((chunk) => {
          const containsStart = sentinelIndex < offset + chunk.data.length;
          offset += chunk.data.length;
          return containsStart;
        })?.atMs;
        const initial = terminal.acceptedTail.slice(sentinelIndex);
        terminal.acceptedTail = "";
        terminal.acceptedChunks = [];
        appendTerminalAccepted(terminal, initial);
      }
      if (terminal.acceptedTail.length > 65_536) {
        terminal.startSentinelOverflow = true;
        terminal.acceptedTail = "";
        terminal.acceptedChunks = [];
      }
    },
    terminalWriteParsed(receipt) {
      terminalsWithParsedOutput.add(receipt.terminalId);
      terminalParsedTails.set(
        receipt.terminalId,
        `${terminalParsedTails.get(receipt.terminalId) ?? ""}${receipt.data}`.slice(
          -65_536,
        ),
      );
      const current = terminal;
      if (!current || receipt.terminalId !== current.terminalId) return;
      if (receipt.instanceId !== current.instanceId) {
        current.foreignParsedCount += 1;
        return;
      }
      current.parsedTail = `${current.parsedTail}${receipt.data}`.slice(
        -65_536,
      );
      // The rolling tail is a CHEAP GATE whose only job is to avoid calling the
      // expensive `serialize()` on every batch; `serialized.includes(echo)` below
      // remains the authoritative check and is untouched.
      //
      // The gate had a false negative. A parsed batch can be far larger than the
      // 64 KiB window — measured at 331,990 bytes with the echo 331,967 bytes from
      // its end, 5.1x past the window — so the same append that DELIVERED the echo
      // evicted it, the gate never opened, `serialize()` was never called, and a
      // correctly echoed, parsed, on-screen input was recorded as never observed.
      // Testing the incoming batch's own `data` as well costs one `indexOf` per
      // expected echo per batch and cannot admit anything the authoritative check
      // would reject.
      const matchedEchoes = current.expectedEchoes.filter((echo) => {
        // `parsedTail` is the last 64 KiB of the stream, and this batch ends the
        // stream, so the tail contains the echo iff it fits ENTIRELY inside that
        // window: `bytesFromEnd + echo.length <= 65,536`. The second branch
        // therefore fires on exactly the population that used to be lost, which
        // makes recording it free: an `indexOf` where an `includes` already was,
        // on a batch we were already scanning.
        if (current.parsedTail.includes(echo)) return true;
        const at = receipt.data.indexOf(echo);
        if (at < 0) return false;
        current.echoTailMisses.push({
          echo,
          batchBytes: receipt.data.length,
          bytesFromEnd: receipt.data.length - at - echo.length,
        });
        return true;
      });
      // Same false negative as the echo gate above, same non-weakening fix: the
      // authoritative test is `serialized.includes(current.modelEndSentinel)`
      // below and is untouched. Without this, an end sentinel landing more than
      // 64 KiB from its batch's end never opens the gate, `serialize()` is never
      // called, the model is never captured, and it surfaces as "Terminal
      // observation did not complete" — the same string that a component remount
      // also produces, which is why that string implies two mechanisms, not one.
      const reachedEnd =
        current.parsedTail.includes(current.modelEndSentinel) ||
        receipt.data.includes(current.modelEndSentinel);
      if (matchedEchoes.length === 0 && !reachedEnd) return;
      const serialized = receipt.serialize();
      for (const [echoIndex, echo] of current.expectedEchoes.entries()) {
        if (
          !serialized.includes(echo) ||
          current.inputStarts[echoIndex] === undefined ||
          current.inputDurationsMs[echoIndex] !== undefined ||
          current.inputPaintPending.has(echoIndex)
        )
          continue;
        current.inputPaintPending.add(echoIndex);
        const startedAtMs = current.inputStarts[echoIndex]!;
        void afterPaint().then((paintedAtMs) => {
          current.inputPaintPending.delete(echoIndex);
          current.inputPaintedAtMs[echoIndex] = paintedAtMs;
          current.inputDurationsMs[echoIndex] = paintedAtMs - startedAtMs;
        });
      }
      if (
        current.paintedAtMs !== undefined ||
        !reachedEnd ||
        !serialized.includes(current.modelEndSentinel)
      )
        return;
      current.model = serialized;
      const dimensions = receipt.dimensions();
      current.cols = dimensions.cols;
      current.rows = dimensions.rows;
      void afterPaint().then((paintedAtMs) => {
        current.paintedAtMs = paintedAtMs;
      });
    },
  };
}
