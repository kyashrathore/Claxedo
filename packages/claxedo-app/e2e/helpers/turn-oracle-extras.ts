/**
 * Turn-settlement assertions for specs whose replies come from a REAL model
 * path (Tier L) or a real engine/harness driven by the scripted endpoint
 * (Tier R) — not from `mock-runtime.ts`.
 *
 * `turn-oracle.ts`'s `expectTurnCounts`/`expectNoDuplicateRows` assume one
 * `session-turn-assistant-content` row per turn. That holds for every Tier M
 * mock (a single fixed text part) and does NOT hold once a real assistant
 * message is in play: `message-timeline.data.ts`'s `groupParts` renders one row
 * per renderable part, and a real reply legitimately carries both a `reasoning`
 * part and a `text` part. `expectTurnCounts`'s own doc comment anticipates
 * exactly this and tells callers with multi-part replies to assert on a
 * narrower locator — these two helpers are that narrower locator, shared so
 * both the Tier L smoke and the Tier R local lane prove duplication the same
 * way instead of each hand-rolling it.
 *
 * These supplement the oracle, they do not replace it: reply *text* is still
 * asserted only through `expectAssistantReplyVisible` (INVARIANTS.md authoring
 * rule 2). What lives here is the per-turn row bookkeeping around it.
 */
import { expect, type Page } from "@playwright/test"
import { SELECTORS } from "./turn-oracle"

/** Exactly one user row per turn — the count real multi-part replies can't distort. */
export async function expectLiveUserRowCount(page: Page, count: number) {
  await expect(page.locator(SELECTORS.userMessageContent), `expected exactly ${count} user row(s)`).toHaveCount(count, {
    timeout: 20_000,
  })
}

/**
 * The strict per-marker duplicate-render check — call it ONLY after
 * `page.reload()`, never mid-session. A confirmed client-store defect
 * (`mergeStoredItems` in `src/session/store/message-page.ts:41-56` never prunes
 * a part id that a later canonical fetch/event no longer contains) can
 * transiently render a turn's reply in two `session-turn-assistant-content`
 * rows with byte-identical text while the session is live — verified by
 * cross-checking the SAME turn's real `GET /session/:id/message` response,
 * which never contains more than one text part for that message. A full reload
 * discards the incrementally-merged client history and rehydrates purely from
 * that clean response, so the check is both valid and load-bearing there.
 */
export async function expectLiveTurnsSettledAfterReload(page: Page, markers: string[]) {
  await expectLiveUserRowCount(page, markers.length)
  for (const marker of markers) {
    await expect(
      page.locator(SELECTORS.assistantContentVisible).filter({ hasText: new RegExp(marker) }),
      `expected exactly one visible assistant row containing marker ${marker} (duplicate-render check)`,
    ).toHaveCount(1, { timeout: 20_000 })
  }
}
