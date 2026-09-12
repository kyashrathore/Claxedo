import { escapeRegExp } from "@claxedo/helpers/string"
import type { fixtureFor, sessionRenderer } from "../fixtures"
import { sessionPath } from "../state"
import {
  recordVisualFailure,
  countTitlesInBody,
  waitForText,
  waitForAnimationFrame,
  settleForVideo,
  waitForUsefulScreen,
} from "./common"
import type { Page } from "playwright-core"

export async function waitForSessionComposer(page: Page) {
  // The route fixture does not synthesize provider readiness, so PromptInput
  // may legitimately show its loading body. The dock still proves that the
  // lazy composer module evaluated, mounted, and established its interaction
  // region before the launch recorder stops.
  await page.waitForSelector("[data-component='session-prompt-dock']", { timeout: 10_000 })
}

export async function waitForTranscript(page: Page, fixture: ReturnType<typeof fixtureFor>, sessionID: string, text: string) {
  fixture.requestCounts.expectedTranscripts[sessionID] = text
  const visible = await page.waitForFunction(({ id, expected }) =>
    Array.from(document.querySelectorAll<HTMLElement>("[data-testid='session-page-root']"))
      .some((node) => {
        if (node.dataset.sessionId !== id) return false
        const rect = node.getBoundingClientRect()
        if (rect.width <= 0 || rect.height <= 0) return false
        if (node.dataset.sessionFirstFoldReady !== "true") return false
        if (node.dataset.sessionMessagesReady !== "true") return false
        const messageCount = Number(node.dataset.sessionMessageCount ?? node.dataset.sessionConversationCount ?? "0")
        if (Number.isFinite(messageCount) && messageCount <= 0) return false
        const timeline = node.querySelector<HTMLElement>("[data-session-timeline-root]")
        if (!timeline || timeline.dataset.sessionTimelineRevealReady !== "true") return false
        if (timeline.dataset.sessionTimelineProgressiveReady !== "true") return false
        if (getComputedStyle(timeline).visibility === "hidden") return false
        if (Number(timeline.dataset.sessionTimelineKeyCount ?? "0") <= 0) return false
        // "Some mounted row has rendered content" — NOT "the first row in DOM
        // order has content". `TurnGap` (message-timeline.tsx:1398) is a real
        // timeline row that is `aria-hidden` and deliberately EMPTY, and on a
        // cold mount with overscan 1 it is routinely the first row above the
        // fold. Sampling only `querySelector` therefore made readiness depend
        // on which arbitrary row happened to lead the list: with a spacer
        // leading, this clause stayed false for ~1.25 s after the transcript
        // was fully rendered and visible, and only flipped when an unrelated
        // event (the 2 s SSE reconnect advisory disappearing, growing the
        // scroller by 28 px) mounted two more rows. That pinned
        // `transcript_render_ms` to RECONNECT_DELAY_MS + first-connect ~= 2.28 s
        // and made it insensitive to transcript work — a wall-clock timer
        // wearing a render metric's name (its relative stddev was 0.002 on a
        // host where real work scatters 7-19%).
        // The content proof is unchanged and still independent: the expected
        // text assertion below has to pass either way.
        const rows = Array.from(timeline.querySelectorAll<HTMLElement>("[data-timeline-key]"))
        if (!rows.some((row) => (row.textContent ?? "").trim())) return false
        return (timeline.textContent ?? "").includes(expected)
      }),
    { id: sessionID, expected: text },
    { timeout: 10_000 },
  ).then(() => true).catch(() => false)
  if (visible) {
    fixture.requestCounts.visibleTranscripts[sessionID] = true
    return
  }
  recordVisualFailure(fixture, `seeded transcript text did not render for ${sessionID}: ${text}`)
}

export async function showSessionInventory(
  page: Page,
  fixture: ReturnType<typeof fixtureFor>,
  expected: number,
  options: { settle?: "video" | "frame" } = {},
) {
  if ((options.settle ?? "video") === "frame") {
    const found = await countTitlesInBody(page, fixture.sessions.slice(0, expected).map((session) => session.title))
    if (found < expected) {
      recordVisualFailure(fixture, `only ${found} of ${expected} seeded sessions were visible in the session inventory`)
    }
    return
  }
  await waitForText(page, fixture.sessions[0]?.title ?? "session", 10_000)
  await clickLoadMoreUntil(page, fixture, expected)
  const found = await countTitlesInBody(page, fixture.sessions.slice(0, expected).map((session) => session.title))
  if (found < expected) {
    recordVisualFailure(fixture, `only ${found} of ${expected} seeded sessions were visible in the session inventory`)
  }
  for (const session of fixture.sessions.slice(0, expected)) {
    const row = await sessionLocator(page, session)
    if (await row.isVisible({ timeout: 200 }).catch(() => false)) {
      await row.scrollIntoViewIfNeeded().catch(() => undefined)
      await waitForAnimationFrame(page, 1)
    }
  }
  if ((options.settle ?? "video") === "video") await settleForVideo(page)
  else await waitForAnimationFrame(page, 1)
}

export async function measureInPageSessionFirstFoldSwitch(
  page: Page,
  session: ReturnType<typeof fixtureFor>["sessions"][number],
  options: {
    renderer?: ReturnType<typeof sessionRenderer>
    renderMermaid?: boolean
    beforeClick?: () => Promise<void>
    afterReady?: () => Promise<void>
  } = {},
) {
  const rowSelector = `[data-testid="rail-sidebar-session-row"][data-session-id="${session.id}"]`
  const canonicalRow = page.locator(rowSelector).first()
  const row = await canonicalRow.count()
    ? canonicalRow
    : page.locator("[role='button'], button, a").filter({ hasText: session.title }).first()
  if (!await row.count()) return 10_000
  await row.scrollIntoViewIfNeeded()
  const canonicalActivate = row.locator('[data-slot="navigation-row-activate"]').first()
  const activate = await canonicalActivate.count() ? canonicalActivate : row
  const mark = `claxedo-session-switch-${session.id}-${crypto.randomUUID()}`
  const before = await activate.evaluate((node, input) => {
    const id = input.id
    const beforeRoot = document.querySelector<HTMLElement>(`[data-testid="session-page-root"][data-session-id="${CSS.escape(id)}"]`)
    const beforeContent = document.querySelector<HTMLElement>(`[data-testid="session-content"][data-session-id="${CSS.escape(id)}"]`)
    performance.clearMarks(input.mark)
    node.addEventListener("pointerdown", (event) => {
      if (event.isTrusted) performance.mark(input.mark)
    }, { once: true })
    return {
      hadBeforeRoot: !!beforeRoot,
      hadBeforeContent: !!beforeContent,
      beforeReady: beforeRoot?.dataset.sessionMessagesReady,
      beforeCount: beforeRoot?.dataset.sessionMessageCount,
    }
  }, { id: session.id, mark })
  // Use Playwright's trusted mouse input so the benchmark follows the exact
  // browser pointer lifecycle. Hand-dispatched PointerEvents are untrusted and
  // do not reproduce the real activation/drag boundary this benchmark measures.
  await options.beforeClick?.()
  await activate.click({ timeout: 5_000 })
  const result = await page.evaluate(async ({ id, debug, renderer, renderMermaid, mark, before }) => {
    const started = performance.getEntriesByName(mark, "mark").at(-1)?.startTime
    if (started === undefined) throw new Error(`Trusted session switch did not emit pointerdown for ${id}`)
    if (window.__claxedoPerfTrace) {
      window.__claxedoPerfRendererPhases?.push({
        name: "sessionSwitch.click",
        durationMs: performance.now() - started,
      })
    }
    const ms = await new Promise<number>((resolve) => {
      const tick = () => {
        const elapsed = performance.now() - started
        const targetRoot = document.querySelector<HTMLElement>(`[data-testid="session-page-root"][data-session-id="${CSS.escape(id)}"]`)
        const readyMessages = targetRoot?.dataset.sessionFirstFoldReady === "true" &&
          targetRoot.dataset.sessionMessagesReady === "true" &&
          Number(targetRoot?.dataset.sessionMessageCount ?? targetRoot?.dataset.sessionConversationCount ?? "0") > 0
        const timeline = targetRoot?.querySelector<HTMLElement>("[data-session-timeline-root]")
        const baseTimelineReady = timeline?.dataset.sessionTimelineRevealReady === "true" &&
          timeline.dataset.sessionTimelineProgressiveReady === "true" &&
          getComputedStyle(timeline).visibility !== "hidden" &&
          Number(timeline.dataset.sessionTimelineKeyCount ?? "0") > 0 &&
          // Same defect as `waitForTranscript` (fixed in 9d16de0): sampling
          // only the FIRST `[data-timeline-key]` in DOM order makes readiness
          // depend on whether a `TurnGap` — an aria-hidden, deliberately empty
          // spacer row that routinely leads a cold mount — happens to lead the
          // list. Require SOME mounted row to carry content instead.
          Array.from(timeline.querySelectorAll<HTMLElement>("[data-timeline-key]")).some(
            (row) => (row.textContent ?? "").trim(),
          )
        const inlineDiffReady = !!timeline?.querySelector(
          "[data-timeline-row-rich-ready='true'] [data-component='edit-content']",
        )
        if (baseTimelineReady && renderer === "diff" && !inlineDiffReady) {
          const trigger = timeline?.querySelector<HTMLElement>(
            "[data-component='edit-tool'] [data-slot='collapsible-trigger']",
          )
          if (trigger && trigger.getAttribute("aria-expanded") !== "true" && trigger.dataset.perfOpened !== "true") {
            trigger.dataset.perfOpened = "true"
            trigger.click()
          }
        }
        const rendererReady = renderer === "diff" ? inlineDiffReady
          : renderer === "markdown" ? !!timeline?.querySelector("[data-component='markdown'] table")
          : renderer === "code" ? !!timeline?.querySelector("[data-markdown-complete='true'] [data-component='markdown-code']")
          : renderer === "mermaid" && renderMermaid === false
            ? !!timeline?.querySelector("[data-mermaid-state='deferred'] [data-slot='mermaid-render-button']")
          : renderer === "mermaid" ? !!timeline?.querySelector("[data-mermaid-state='rendered'] [data-slot='mermaid-diagram'] svg")
          : true
        if (baseTimelineReady && renderer === "mermaid" && renderMermaid !== false && !rendererReady) {
          timeline?.querySelector<HTMLElement>("[data-slot='mermaid-render-button']")?.click()
        }
        const readyTimeline = baseTimelineReady && rendererReady
        if (targetRoot && !targetRoot.closest("[aria-hidden='true']") && readyMessages && readyTimeline) {
          resolve(performance.now() - started)
          return
        }
        if (elapsed > 10_000) {
          resolve(elapsed)
          return
        }
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
    const afterRoot = document.querySelector<HTMLElement>(`[data-testid="session-page-root"][data-session-id="${CSS.escape(id)}"]`)
    const afterTimeline = afterRoot?.querySelector<HTMLElement>("[data-session-timeline-root]")
    const output = {
      ms,
      debug: debug
        ? {
            ...before,
            afterReady: afterRoot?.dataset.sessionMessagesReady,
            afterCount: afterRoot?.dataset.sessionMessageCount,
            timelineRows: afterTimeline?.dataset.sessionTimelineRowCount,
            virtualRows: afterTimeline?.dataset.sessionTimelineKeyCount,
            progressiveReady: afterTimeline?.dataset.sessionTimelineProgressiveReady,
            mountedRows: afterTimeline?.querySelectorAll("[data-timeline-key]").length,
            rowTypes: Array.from(afterTimeline?.querySelectorAll<HTMLElement>("[data-timeline-row]") ?? [])
              .map((node) => node.dataset.timelineRow),
            messageBodies: afterTimeline?.querySelectorAll("[data-slot='session-turn-message-content']").length,
            editTools: afterTimeline?.querySelectorAll("[data-component='edit-tool']").length,
            editContents: afterTimeline?.querySelectorAll("[data-component='edit-content']").length,
            readyEditContents: afterTimeline?.querySelectorAll(
              "[data-timeline-row-rich-ready='true'] [data-component='edit-content']",
            ).length,
            markdownTables: afterTimeline?.querySelectorAll("[data-component='markdown'] table").length,
            markdownRowHeights: Array.from(
              afterTimeline?.querySelectorAll<HTMLElement>("[data-markdown-block]") ?? [],
            ).map((node) => node.closest<HTMLElement>("[data-index]")?.offsetHeight),
            highlightedCode: afterTimeline?.querySelectorAll("[data-markdown-complete='true'] [data-component='markdown-code']").length,
            renderedMermaid: afterTimeline?.querySelectorAll("[data-mermaid-state='rendered'] [data-slot='mermaid-diagram'] svg").length,
          }
        : undefined,
    }
    performance.clearMarks(mark)
    return output
  }, {
    id: session.id,
    debug: Bun.env.CLAXEDO_PERF_DEBUG_SESSION_SWITCH === "1",
    renderer: options.renderer ?? "plain",
    renderMermaid: options.renderMermaid,
    mark,
    before,
  })
  await options.afterReady?.()
  if (result.debug) console.log("first-fold-switch-debug", JSON.stringify(result.debug))
  if (result.ms >= 10_000) {
    await page.goto(`${new URL(page.url()).origin}${sessionPath(session, session.id)}`, {
      waitUntil: "domcontentloaded",
    })
    await waitForUsefulScreen(page)
  }
  return result.ms
}

async function sessionLocator(page: Page, session: ReturnType<typeof fixtureFor>["sessions"][number]) {
  const link = page.locator(`a[href="${sessionPath(session, session.id)}"]`).first()
  if (await link.count().catch(() => 0)) return link
  const canonicalLink = page.locator(`a[href="/s/${session.id}"]`).first()
  if (await canonicalLink.count().catch(() => 0)) return canonicalLink
  const sessionLink = page.locator(`a[href*="/session/${session.id}"]`).first()
  if (await sessionLink.count().catch(() => 0)) return sessionLink
  const button = page.getByRole("button", { name: new RegExp(`${escapeRegExp(session.title)}(?!\\d)`, "i") }).first()
  if (await button.count().catch(() => 0)) return button
  return page.getByText(session.title, { exact: true }).first()
}

async function clickLoadMoreUntil(page: Page, fixture: ReturnType<typeof fixtureFor>, expected: number) {
  let clicked = false
  for (let index = 0; index < 8; index++) {
    const found = await countTitlesInBody(page, fixture.sessions.slice(0, expected).map((session) => session.title))
    if (found >= expected) return clicked
    const more = page.getByRole("button", { name: /load more/i }).first()
    if (!(await more.isVisible({ timeout: 500 }).catch(() => false))) return clicked
    await more.scrollIntoViewIfNeeded().catch(() => undefined)
    await more.click()
    clicked = true
    await settleForVideo(page)
  }
  return clicked
}
