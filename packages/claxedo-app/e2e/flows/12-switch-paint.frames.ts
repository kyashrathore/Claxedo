import type { Page } from "@playwright/test"

export type PaneFrame = {
  readonly sessionId: string
  readonly body: boolean
  readonly composer: boolean
  readonly footer: string
  readonly placeholders: number
  readonly turnLoading: number
  readonly rows: readonly string[]
  readonly scrollTop: number
  readonly nav: boolean
}

export type SwitchFrame = { readonly at: number; readonly rail: string; readonly panes: readonly PaneFrame[] }

type RecorderWindow = Window & { __claxedoSwitchFrames?: Promise<SwitchFrame[]> }

export async function recordSwitchFrames(app: Page, input: { readonly targetId: string; readonly quietFrames: number }): Promise<() => Promise<SwitchFrame[]>> {
  await app.evaluate(({ targetId, quietFrames }) => {
    const shown = (element: Element) => {
      const host = element.closest("[data-workbench-content]")
      if (!host || host.getAttribute("aria-hidden") === "true") return false
      const style = getComputedStyle(element)
      const box = element.getBoundingClientRect()
      return style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity) > 0 && box.width > 0 && box.height > 0
    }
    const pane = (root: HTMLElement): PaneFrame => {
      const scroller = root.querySelector<HTMLElement>('[data-slot="session-timeline-scroll"] [data-scrollable]')
      const timeline = root.querySelector<HTMLElement>("[data-session-timeline-root]")
      const view = scroller?.getBoundingClientRect()
      const rows = timeline && getComputedStyle(timeline).visibility !== "hidden" && view
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
        turnLoading: root.querySelectorAll('[data-timeline-row="TurnLoading"]').length,
        rows,
        scrollTop: Math.round(scroller?.scrollTop ?? -1),
        nav: !!timeline?.querySelector('[data-component="message-nav"]'),
      }
    }
    const frames: SwitchFrame[] = []
    const started = performance.now()
    let quiet = 0
    let previous = ""
    ;(window as RecorderWindow).__claxedoSwitchFrames = new Promise<SwitchFrame[]>((resolve) => {
      const sample = () => {
        const panes = [...document.querySelectorAll<HTMLElement>('[data-testid="session-page-root"]')].filter(shown).map(pane)
        const rail = document.querySelector<HTMLElement>('[data-testid="rail-sidebar-session-row"][data-active="true"]')?.dataset.sessionId ?? ""
        frames.push({ at: Math.round(performance.now() - started), rail, panes })
        const signature = JSON.stringify([rail, panes])
        const onTarget = panes.length === 1 && panes[0].sessionId === targetId && panes[0].rows.length > 0
        quiet = onTarget && signature === previous ? quiet + 1 : 0
        previous = signature
        if (quiet >= quietFrames || frames.length > 1200) return resolve(frames)
        requestAnimationFrame(afterPaint)
      }
      const painted = new MessageChannel()
      painted.port1.onmessage = sample
      const afterPaint = () => painted.port2.postMessage(undefined)
      requestAnimationFrame(afterPaint)
    })
  }, input)
  return () => app.evaluate(() => (window as RecorderWindow).__claxedoSwitchFrames!)
}

export type SwitchReport = {
  readonly states: readonly string[]
  readonly settledAt: number | undefined
  readonly sessions: readonly string[]
  readonly empty: readonly string[]
  readonly jumps: readonly string[]
  readonly footers: readonly string[]
  readonly railApart: readonly string[]
}

function describe(frame: SwitchFrame): string {
  return `+${frame.at}ms rail=${frame.rail} ${frame.panes.map((pane) => JSON.stringify(pane)).join(" | ") || "no session shown"}`
}

function emptyBody(frame: SwitchFrame): boolean {
  const pane = frame.panes[0]
  return frame.panes.length !== 1 || !pane.body || !pane.composer || pane.placeholders > 0 || pane.turnLoading > 0 || pane.rows.length === 0
}

export function switchReport(frames: readonly SwitchFrame[], targetId: string): SwitchReport {
  const states: string[] = []
  const sessions: string[] = []
  const target = frames.filter((frame) => frame.panes.length === 1 && frame.panes[0].sessionId === targetId)
  const first = target[0]?.panes[0]
  const layout = (pane: PaneFrame) => JSON.stringify([pane.rows, pane.scrollTop, pane.nav])
  let last = ""
  for (const frame of frames) {
    const state = describe(frame).replace(/^\+\d+ms /, "")
    if (state !== last) states.push(describe(frame))
    last = state
    const shown = frame.panes[0]?.sessionId
    if (shown && sessions.at(-1) !== shown) sessions.push(shown)
  }
  return {
    states,
    settledAt: states.length > 1 ? Number(/^\+(\d+)ms/.exec(states.at(-1) ?? "")?.[1]) : undefined,
    sessions,
    empty: frames.filter(emptyBody).map(describe),
    jumps: first ? target.filter((frame) => layout(frame.panes[0]) !== layout(first)).map(describe) : [],
    footers: [...new Set(target.map((frame) => frame.panes[0].footer))],
    railApart: frames.filter((frame) => frame.panes.length === 1 && frame.rail !== frame.panes[0].sessionId).map(describe),
  }
}
