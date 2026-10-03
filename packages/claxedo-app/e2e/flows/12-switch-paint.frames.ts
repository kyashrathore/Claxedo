import type { Page } from "@playwright/test"

export type PaneFrame = {
  readonly sessionId: string
  readonly body: boolean
  readonly composer: boolean
  readonly footer: string
  readonly placeholders: number
  readonly rows: readonly string[]
  readonly scrollTop: number
  readonly fromEnd: number
  readonly nav: boolean
}

export type SwitchFrame = { readonly at: number; readonly rail: string; readonly panes: readonly PaneFrame[] }

type RecorderWindow = Window & { __claxedoSwitchFrames?: Promise<SwitchFrame[]>; __claxedoSwitchStarted?: number }

export type ReadArrival = { readonly view: string; readonly arrivedMs: number; readonly bytes: number }

export async function recordSwitchFrames(app: Page, input: { readonly targetId: string; readonly quietFrames: number }): Promise<() => Promise<SwitchFrame[]>> {
  await app.evaluate(({ targetId, quietFrames }) => {
    const paintedFrames = window.__claxedoPaintedFrames
    if (!paintedFrames) throw new Error("installPaintedFrames has not run in this page")
    const painted = (element: Element) => element.checkVisibility({ opacityProperty: true, visibilityProperty: true })
    const shown = (root: Element) => [root, ...root.querySelectorAll("[data-session-timeline-root], [data-timeline-key]")].some(painted)
    const pane = (root: HTMLElement): PaneFrame => {
      const scroller = root.querySelector<HTMLElement>('[data-slot="session-timeline-scroll"] [data-scrollable]')
      const timeline = root.querySelector<HTMLElement>("[data-session-timeline-root]")
      const view = scroller?.getBoundingClientRect()
      const rows = timeline && painted(timeline) && view
        ? [...root.querySelectorAll<HTMLElement>("[data-timeline-key]")]
            .map((row) => ({ key: row.dataset.timelineKey ?? "", box: row.getBoundingClientRect() }))
            .filter((row) => row.box.height > 0 && row.box.bottom > view.top && row.box.top < view.bottom)
            .sort((left, right) => left.box.top - right.box.top)
            .map((row) => `${row.key}@${Math.round(row.box.top - view.top)}`)
        : []
      return {
        sessionId: root.dataset.sessionId ?? "",
        body: !!root.querySelector('[data-slot="session-screen-body"]'),
        composer: !!root.querySelector('[data-component="prompt-input"]'),
        footer: root.querySelector<HTMLElement>('[data-slot="composer-toolbar"]')?.innerText.replace(/\s+/g, " ").trim() ?? "",
        placeholders: root.querySelectorAll('[data-session-timeline-loading], [data-slot="skeleton"]').length,
        rows,
        scrollTop: Math.round(scroller?.scrollTop ?? -1),
        fromEnd: scroller ? Math.round(scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop) : -1,
        nav: !!timeline?.querySelector('[data-component="message-nav"]'),
      }
    }
    const frames: SwitchFrame[] = []
    let started = performance.now()
    window.addEventListener("pointerdown", (event) => {
      if (!event.isTrusted) return
      const shift = Math.round(event.timeStamp - started)
      for (const [index, frame] of frames.entries()) frames[index] = { ...frame, at: frame.at - shift }
      started = event.timeStamp
      ;(window as RecorderWindow).__claxedoSwitchStarted = started
    }, { capture: true, once: true })
    let quiet = 0
    let previous = ""
    ;(window as RecorderWindow).__claxedoSwitchFrames = new Promise<SwitchFrame[]>((resolve) => {
      paintedFrames({
        sample: () => ({
          panes: [...document.querySelectorAll<HTMLElement>('[data-testid="session-page-root"]')].filter(shown).map(pane),
          rail: document.querySelector<HTMLElement>('[data-testid="rail-sidebar-session-row"][data-active="true"]')?.dataset.sessionId ?? "",
        }),
        painted: ({ panes, rail }, paintedAt) => {
          frames.push({ at: Math.round(paintedAt - started), rail, panes })
          const signature = JSON.stringify([rail, panes])
          const onTarget = panes.length === 1 && panes[0].sessionId === targetId && panes[0].rows.length > 0
          quiet = onTarget && signature === previous ? quiet + 1 : 0
          previous = signature
          if (quiet < quietFrames && frames.length <= 1200) return false
          resolve(frames)
          return true
        },
      })
    })
  }, input)
  return () => app.evaluate(() => (window as RecorderWindow).__claxedoSwitchFrames!)
}

export function readArrivals(app: Page, sessionId: string): Promise<ReadArrival[]> {
  return app.evaluate((sessionId) => {
    const started = (window as RecorderWindow).__claxedoSwitchStarted ?? 0
    const path = new RegExp(`/session/${encodeURIComponent(sessionId).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/(message|outline)(\\?|$)`)
    return performance
      .getEntriesByType("resource")
      .filter((entry): entry is PerformanceResourceTiming => entry.startTime >= started && path.test(entry.name))
      .map((entry) => {
        const url = new URL(entry.name)
        const view = url.pathname.endsWith("/outline") ? "outline" : (url.searchParams.get("view") ?? "older")
        return { view, arrivedMs: Math.round(entry.responseEnd - started), bytes: entry.encodedBodySize }
      })
  }, sessionId)
}

export type SwitchReport = {
  readonly states: readonly string[]
  readonly revealedAt: { readonly ms: number; readonly frame: number } | undefined
  readonly settledAt: { readonly ms: number; readonly frame: number } | undefined
  readonly longestFrameMs: number
  readonly sessions: readonly string[]
  readonly empty: readonly string[]
  readonly overlaid: readonly string[]
  readonly moved: readonly string[]
  readonly shownStates: readonly string[]
  readonly footers: readonly string[]
  readonly navs: readonly boolean[]
  readonly railApart: readonly string[]
}

function describe(frame: SwitchFrame): string {
  return `+${frame.at}ms rail=${frame.rail} ${frame.panes.map((pane) => JSON.stringify(pane)).join(" | ") || "no session shown"}`
}

function emptyBody(frame: SwitchFrame): boolean {
  return frame.panes.length === 0 || frame.panes.some((pane) => !pane.body || !pane.composer || pane.placeholders > 0 || pane.rows.length === 0)
}

function rowTops(pane: PaneFrame): ReadonlyMap<string, string> {
  return new Map(pane.rows.map((row) => [row.slice(0, row.lastIndexOf("@")), row.slice(row.lastIndexOf("@") + 1)]))
}

function movedRows(target: readonly SwitchFrame[]): string[] {
  const first = target[0] ? rowTops(target[0].panes[0]) : new Map<string, string>()
  const painted = new Map(first)
  return target.flatMap((frame) => {
    const now = rowTops(frame.panes[0])
    const gone = [...first].flatMap(([key, top]) => (now.has(key) ? [] : [`${key}@${top}→gone`]))
    const moved = [...now].flatMap(([key, top]) => {
      const was = painted.get(key)
      if (was === undefined) painted.set(key, top)
      return was === undefined || was === top ? [] : [`${key}@${was}→${top}`]
    })
    const rows = [...gone, ...moved]
    return rows.length ? [`+${frame.at}ms ${rows.join(" ")}`] : []
  })
}

export function switchReport(frames: readonly SwitchFrame[], targetId: string): SwitchReport {
  const states: string[] = []
  const sessions: string[] = []
  const shows = (frame: SwitchFrame) => frame.panes.length === 1 && frame.panes[0].sessionId === targetId
  const target = frames.filter(shows)
  let last = ""
  let settled = -1
  frames.forEach((frame, index) => {
    const state = describe(frame).replace(/^\+\d+ms /, "")
    if (state !== last) {
      states.push(describe(frame))
      settled = index
    }
    last = state
    const shown = frame.panes[0]?.sessionId
    if (shown && sessions.at(-1) !== shown) sessions.push(shown)
  })
  const revealed = frames.findIndex(shows)
  const clicked = frames.findIndex((frame) => frame.at > 0)
  const at = (index: number) => (index < 0 ? undefined : { ms: frames[index].at, frame: index - clicked + 1 })
  const transition = frames.slice(Math.max(0, clicked - 1), settled + 1)
  return {
    states,
    revealedAt: at(revealed),
    longestFrameMs: transition.reduce((longest, frame, index) => (index === 0 ? longest : Math.max(longest, frame.at - transition[index - 1].at)), 0),
    settledAt: states.length > 1 ? at(settled) : undefined,
    sessions,
    empty: frames.filter(emptyBody).map(describe),
    overlaid: frames.filter((frame) => frame.panes.length > 1).map(describe),
    moved: movedRows(target),
    shownStates: target.flatMap((frame, index) => {
      const shown = (pane: PaneFrame) => JSON.stringify([pane.rows, pane.footer, pane.nav])
      return index > 0 && shown(frame.panes[0]) === shown(target[index - 1].panes[0]) ? [] : [describe(frame)]
    }),
    footers: [...new Set(target.map((frame) => frame.panes[0].footer))],
    navs: [...new Set(target.map((frame) => frame.panes[0].nav))],
    railApart: frames.filter((frame) => frame.panes.length === 1 && frame.rail !== frame.panes[0].sessionId).map(describe),
  }
}
