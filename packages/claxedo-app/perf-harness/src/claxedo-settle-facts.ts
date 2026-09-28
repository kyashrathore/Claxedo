import type { AppFacts } from "agent-app-benchmark/driver-sdk"

export type SettleFactsTarget = {
  sessionId: string
  expectedMessageIds: readonly string[]
  /** Every latest-turn part id, text or not. */
  expectedPartIds: readonly string[]
}

/**
 * `settleExpression` serializes this into the renderer with `toString()`, so it
 * may use only browser globals and `target`.
 *
 * A latest-turn row is the destination's own latest turn by message id, and an
 * assistant row that carries a part id must show one of that turn's parts: an
 * assistant message renders one row per part group, all stamped with the same
 * message id. Each row is answered by the element holding its painted text, so
 * the clock's text check reads the text body rather than the row's controls.
 */
export const claxedoSettleFacts = (target: SettleFactsTarget): AppFacts => {
  const expectedMessageIds = new Set(target.expectedMessageIds)
  const expectedPartIds = new Set(target.expectedPartIds)
  const sessionRoot = () =>
    document.querySelector<HTMLElement>(
      `[data-testid="session-page-root"][data-session-id="${CSS.escape(target.sessionId)}"]`,
    )
  const hiddenSurface = (root: HTMLElement) => {
    const surface = root.closest<HTMLElement>("[data-workbench-content]")
    return !surface || surface.getAttribute("aria-hidden") === "true" || surface.hasAttribute("inert")
  }
  const shown = (element: HTMLElement) => {
    const style = getComputedStyle(element)
    const bounds = element.getBoundingClientRect()
    return (
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      Number(style.opacity) !== 0 &&
      bounds.width > 0 &&
      bounds.height > 0
    )
  }
  const timeline = () => sessionRoot()?.querySelector<HTMLElement>("[data-session-timeline-root]") ?? null
  const transcript = () =>
    timeline()?.querySelector<HTMLElement>('[data-slot="session-timeline-scroll"] [data-scrollable]') ?? null
  return {
    displayed: () => {
      const root = sessionRoot()
      if (!root || hiddenSurface(root)) return false
      const activeRows = [
        ...document.querySelectorAll<HTMLElement>('[data-testid="rail-sidebar-session-row"][data-active="true"]'),
      ]
      const visibleRoots = [...document.querySelectorAll<HTMLElement>('[data-testid="session-page-root"]')].filter(
        (candidate) => !hiddenSurface(candidate) && shown(candidate),
      )
      return (
        activeRows.length === 1 &&
        activeRows[0]?.dataset.sessionId === target.sessionId &&
        visibleRoots.length === 1 &&
        visibleRoots[0]?.dataset.sessionId === target.sessionId
      )
    },
    latestTurnRows: () => {
      const root = sessionRoot()
      if (!root) return []
      return [
        ...root.querySelectorAll<HTMLElement>(
          '[data-timeline-row="UserMessage"][data-content-message-id], [data-timeline-row="AssistantPart"][data-content-message-id]',
        ),
      ]
        .filter((row) => {
          if (!expectedMessageIds.has(row.dataset.contentMessageId ?? "")) return false
          const partId = row.dataset.contentPartId
          return row.dataset.timelineRow !== "AssistantPart" || !partId || expectedPartIds.has(partId)
        })
        .map((row) => {
          const partId = row.dataset.contentPartId
          const text =
            row.dataset.timelineRow === "AssistantPart" && partId
              ? row.querySelector<HTMLElement>(
                  `[data-component="text-part"][data-timeline-part-id="${CSS.escape(partId)}"] [data-slot="text-part-body"]`,
                )
              : row.dataset.timelineRow === "UserMessage"
                ? row.querySelector<HTMLElement>('[data-slot="user-message-text"]')
                : null
          return text ?? row
        })
    },
    composer: () => {
      const composer = sessionRoot()?.querySelector<HTMLElement>('[data-component="prompt-input"]')
      return composer?.getAttribute("contenteditable") === "true" ? composer : null
    },
    placeholder: () => {
      const root = sessionRoot()
      const scope = timeline()
      return (
        !root ||
        !!root.querySelector("[data-session-timeline-loading]") ||
        !scope ||
        !!scope.querySelector('[data-slot="skeleton"]')
      )
    },
    transcript,
    rows: () => [...(transcript()?.querySelectorAll<HTMLElement>("[data-timeline-key]") ?? [])],
    rowKey: (row) => row.dataset.timelineKey ?? "",
  }
}
