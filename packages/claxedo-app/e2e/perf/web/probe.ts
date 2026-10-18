export type ProbeMark = { readonly name: string; readonly at: number }

export type ProbeLoaf = {
  readonly start: number
  readonly duration: number
  readonly blocking: number
  readonly scripts: readonly { readonly url: string; readonly fn: string; readonly char: number; readonly duration: number; readonly forced: number; readonly invoker: string }[]
}

export type ProbeNavigation = {
  readonly fetchStart: number
  readonly requestStart: number
  readonly responseStart: number
  readonly responseEnd: number
  readonly domContentLoaded: number
  readonly loadEventEnd: number
  readonly transferSize: number
}

export type ProbeState = {
  readonly timeOrigin: number
  readonly navigation: ProbeNavigation | undefined
  readonly marks: readonly ProbeMark[]
  readonly lcp: { readonly at: number; readonly size: number; readonly element: string } | undefined
  readonly railRows: number
  readonly longTasks: readonly { readonly start: number; readonly duration: number }[]
  readonly loafs: readonly ProbeLoaf[]
  readonly inputs: readonly { readonly at: number; readonly kind: string }[]
  readonly keys: readonly { readonly at: number; readonly latencyMs: number }[]
  readonly frames: number
}

declare global {
  interface Window {
    __webPerf?: { read: () => ProbeState; arm: () => void }
  }
}

export function installWebProbe() {
  const SCROLLER = '[data-slot="session-timeline-scroll"] > [data-scrollable]'
  const INTERACTION_SCOPED = /^(session-|settings$|marketplace$|composer:)/
  const state = {
    marks: [] as { name: string; at: number }[],
    lcp: undefined as { at: number; size: number; element: string } | undefined,
    railRows: 0,
    longTasks: [] as { start: number; duration: number }[],
    loafs: [] as ProbeLoaf[],
    inputs: [] as { at: number; kind: string }[],
    keys: [] as { at: number; latencyMs: number }[],
    frames: 0,
    armed: false,
    pendingKeys: [] as { at: number; length: number }[],
    signatures: new Map<string, { signature: string; stable: number }>(),
  }
  const has = (name: string) => state.marks.some((mark) => mark.name === name)
  const mark = (name: string, at: number) => {
    if (has(name)) return
    state.marks.push({ name, at })
    performance.mark(`webperf:${name}`, { startTime: at })
  }
  const visible = (element: Element | null | undefined) => {
    if (!element) return false
    const rect = element.getBoundingClientRect()
    return rect.width > 0 && rect.height > 0
  }
  const displayedSession = () => {
    for (const section of document.querySelectorAll<HTMLElement>('section[data-component="session-screen"]')) {
      const slot = section.closest<HTMLElement>("[data-workbench-content]")
      if (!slot || slot.dataset.stashed === "true" || slot.getAttribute("aria-hidden") === "true") continue
      if (visible(section)) return section
    }
    return undefined
  }
  const composer = () => displayedSession()?.querySelector<HTMLElement>('[data-component="prompt-input"][contenteditable="true"]') ?? undefined
  const sample = () => {
    const root = document.getElementById("root")
    const shell = !!root && [...root.children].some((child) => child instanceof HTMLElement && child.offsetHeight > 0)
    const railRows = [...document.querySelectorAll<HTMLElement>('[data-slot="session-navigation-row"]')].filter(visible).length
    const login = visible(document.querySelector('input[type="email"]'))
    const settings = visible(document.querySelector('[data-testid="settings-page"]'))
    const marketplace = visible(document.querySelector("[data-agent-plugin-card]"))
    const section = displayedSession()
    const sessionId = section?.dataset.sessionId
    const scroller = section?.querySelector<HTMLElement>(SCROLLER)
    const loading = !!section?.querySelector('[data-testid="session-messages-loading"]')
    const rows = scroller ? [...scroller.querySelectorAll<HTMLElement>('[data-timeline-row="AssistantPart"]')] : []
    const textLength = rows.reduce((sum, row) => sum + (row.textContent ?? "").trim().length, 0)
    const editable = !!composer()
    const composerLength = composer()?.textContent?.length ?? 0
    return {
      shell, railRows, login, settings, marketplace, sessionId, loading, textLength, editable, composerLength,
      rows: rows.length,
      scrollHeight: scroller?.scrollHeight ?? 0,
      clientHeight: scroller?.clientHeight ?? 0,
    }
  }
  const painted = (value: ReturnType<typeof sample>, at: number) => {
    state.frames += 1
    if (value.shell) mark("shell", at)
    if (value.railRows > 0) {
      if (!has("rail")) state.railRows = value.railRows
      mark("rail", at)
    }
    if (value.login) mark("login", at)
    if (value.settings) mark("settings", at)
    if (value.marketplace) mark("marketplace", at)
    if (value.sessionId) {
      const id = value.sessionId
      if (value.editable) mark(`composer:${id}`, at)
      if (!value.loading && value.textLength > 0) {
        mark(`session-text:${id}`, at)
        if (value.scrollHeight >= value.clientHeight && value.clientHeight > 0) mark(`session-fold:${id}`, at)
        if (value.scrollHeight >= 2 * value.clientHeight && value.clientHeight > 0) mark(`session-two-screens:${id}`, at)
        const signature = `${value.rows}:${value.textLength}:${value.scrollHeight}`
        const tracked = state.signatures.get(id)
        const stable = tracked && tracked.signature === signature ? tracked.stable + 1 : 1
        state.signatures.set(id, { signature, stable })
        if (stable >= 4) mark(`session-settled:${id}`, at)
      }
    }
    state.pendingKeys = state.pendingKeys.filter((pending) => {
      if (value.composerLength <= pending.length) return true
      state.keys.push({ at: pending.at, latencyMs: at - pending.at })
      return false
    })
  }
  const paintedFrames = window.__claxedoPaintedFrames
  if (!paintedFrames) throw new Error("installPaintedFrames has not run in this page")
  paintedFrames({ sample, painted })
  const onInput = (event: Event) => {
    if (!event.isTrusted || !state.armed) return
    state.armed = false
    state.inputs.push({ at: event.timeStamp, kind: event.type })
    performance.mark(`webperf:input:${state.inputs.length}`, { startTime: event.timeStamp })
  }
  window.addEventListener("pointerdown", onInput, { capture: true })
  window.addEventListener("keydown", onInput, { capture: true })
  window.addEventListener("keydown", (event) => {
    if (!event.isTrusted || event.key.length !== 1 || !composer()) return
    state.pendingKeys.push({ at: event.timeStamp, length: composer()?.textContent?.length ?? 0 })
  }, { capture: true })
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      if (entry.entryType === "paint" && entry.name === "first-contentful-paint") mark("fcp", entry.startTime)
      if (entry.entryType === "largest-contentful-paint") {
        const candidate = entry as PerformanceEntry & { size?: number; element?: Element | null }
        state.lcp = { at: entry.startTime, size: candidate.size ?? 0, element: candidate.element?.tagName.toLowerCase() ?? "" }
      }
      if (entry.entryType === "longtask") state.longTasks.push({ start: entry.startTime, duration: entry.duration })
      if (entry.entryType === "long-animation-frame") {
        const loaf = entry as PerformanceEntry & { blockingDuration?: number; scripts?: readonly { sourceURL?: string; sourceFunctionName?: string; sourceCharPosition?: number; duration: number; forcedStyleAndLayoutDuration?: number; invoker?: string }[] }
        state.loafs.push({
          start: loaf.startTime, duration: loaf.duration, blocking: loaf.blockingDuration ?? 0,
          scripts: (loaf.scripts ?? []).map((script) => ({ url: (script.sourceURL ?? "").split("/").pop() ?? "", fn: script.sourceFunctionName ?? "", char: script.sourceCharPosition ?? -1, duration: script.duration, forced: script.forcedStyleAndLayoutDuration ?? 0, invoker: script.invoker ?? "" })),
        })
      }
    }
  })
  for (const type of ["paint", "largest-contentful-paint", "longtask", "long-animation-frame"]) observer.observe({ type, buffered: true })
  window.__webPerf = {
    read: () => {
      const [entry] = performance.getEntriesByType("navigation") as PerformanceNavigationTiming[]
      return {
        timeOrigin: performance.timeOrigin,
        navigation: entry ? { fetchStart: entry.fetchStart, requestStart: entry.requestStart, responseStart: entry.responseStart, responseEnd: entry.responseEnd, domContentLoaded: entry.domContentLoadedEventEnd, loadEventEnd: entry.loadEventEnd, transferSize: entry.transferSize } : undefined,
        marks: [...state.marks], lcp: state.lcp, railRows: state.railRows, longTasks: [...state.longTasks], loafs: [...state.loafs], inputs: [...state.inputs], keys: [...state.keys], frames: state.frames,
      }
    },
    arm: () => {
      state.armed = true
      state.marks = state.marks.filter((entry) => !INTERACTION_SCOPED.test(entry.name))
      state.signatures.clear()
      state.pendingKeys = []
    },
  }
}
