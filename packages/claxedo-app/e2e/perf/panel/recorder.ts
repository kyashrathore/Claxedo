export type Predicate =
  | { readonly kind: "panel-open-files" }
  | { readonly kind: "panel-closed" }
  | { readonly kind: "navigator"; readonly navigator: "files" | "changes" }
  | { readonly kind: "file-tab"; readonly path: string }
  | { readonly kind: "review"; readonly openCount?: number }
  | { readonly kind: "session"; readonly sessionId: string; readonly panel?: "files" | "changes" | "closed" }
  | { readonly kind: "maximized"; readonly maximized: boolean }

export type Loaf = {
  readonly start: number
  readonly duration: number
  readonly blocking: number
  readonly renderStart: number
  readonly styleAndLayoutStart: number
  readonly scripts: readonly { readonly url: string; readonly fn: string; readonly char: number; readonly duration: number; readonly forced: number; readonly invoker: string }[]
}

export type Recording = {
  readonly inputAt: number
  readonly actAt: number | undefined
  readonly readyAt: number | undefined
  readonly readyFrame: number | undefined
  readonly settledAt: number | undefined
  readonly shellSettledAt: number | undefined
  readonly frames: readonly number[]
  readonly loafs: readonly Loaf[]
  readonly longTasks: readonly { readonly start: number; readonly duration: number }[]
  readonly signatures: readonly string[]
  readonly timeOrigin: number
}

declare global {
  interface Window {
    __panelRec?: {
      arm: (predicate: Predicate) => void
      done: () => Promise<Recording>
    }
  }
}

export function installRecorder() {
  type State = {
    predicate: Predicate | undefined
    inputAt: number | undefined
    handledAt: number | undefined
    actAt: number | undefined
    readyAt: number | undefined
    readyFrame: number | undefined
    settledAt: number | undefined
    shellSettledAt: number | undefined
    frames: number[]
    loafs: Loaf[]
    longTasks: { start: number; duration: number }[]
    signatures: string[]
    stable: number
    previous: string
    resolve: ((recording: Recording) => void) | undefined
    reject: ((error: Error) => void) | undefined
    deadline: number
  }
  const state: State = {
    predicate: undefined, inputAt: undefined, handledAt: undefined, actAt: undefined, readyAt: undefined, readyFrame: undefined, settledAt: undefined, shellSettledAt: undefined,
    frames: [], loafs: [], longTasks: [], signatures: [], stable: 0, previous: "", resolve: undefined, reject: undefined, deadline: 0,
  }
  const visible = (element: Element | null | undefined) => {
    if (!element) return false
    const rect = element.getBoundingClientRect()
    const style = getComputedStyle(element)
    return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden"
  }
  const shell = () => document.querySelector<HTMLElement>("[data-testid='workspace-panel-shell']")
  const filesReady = () => {
    const navigator = [...document.querySelectorAll<HTMLElement>("[data-testid='workspace-files-navigator'][data-mode='files']")].find(visible)
    const rows = navigator?.querySelectorAll("[data-file-tree-path]").length ?? 0
    const ready = !!navigator && navigator.dataset.fileTreeDataReady === "true" && rows > 0 && !navigator.querySelector("[data-file-tree-loading], [aria-label='Loading files']")
    return { ready, signature: ready ? `files:${rows}:${navigator?.innerText.length}` : "", debug: `files:nav=${!!navigator}:ready=${navigator?.dataset.fileTreeDataReady}:rows=${rows}:h=${navigator?.getBoundingClientRect().height}` }
  }
  const changesReady = () => {
    const overlay = document.querySelector<HTMLElement>("[data-testid='workspace-navigator-overlay'][data-navigator-kind='changes'][data-open='true']")
    const view = overlay?.querySelector<HTMLElement>("[data-testid='source-control-view']")
    const rows = view?.querySelectorAll("[data-testid='source-control-row']").length ?? 0
    const ready = !!overlay && visible(view) && !view?.querySelector("[data-testid='source-control-loading']") && (rows > 0 || !!view?.querySelector("[data-testid='source-control-empty']"))
    return { ready, signature: ready ? `changes:${rows}:${view?.innerText.length}` : "" }
  }
  const reviewReady = (openCount: number | undefined) => {
    const root = document.querySelector<HTMLElement>("[data-testid='review-pane-root']")
    const corpus = root?.querySelector<HTMLElement>("[data-review-total-files]")
    const stateHost = root?.querySelector<HTMLElement>("[data-review-diff-style]")
    const rendered = Number(corpus?.dataset.reviewRenderedFiles ?? 0)
    const total = Number(corpus?.dataset.reviewTotalFiles ?? -1)
    const loaded = Number(stateHost?.dataset.reviewLoadedDiffCount ?? -1)
    const open = Number(stateHost?.dataset.reviewOpenDiffCount ?? -1)
    const hunks = Number(stateHost?.dataset.reviewRenderedHunks ?? 0)
    const rows = [...(root?.querySelectorAll<HTMLElement>("[data-review-file]") ?? [])].filter((row) => row.getBoundingClientRect().height > 0)
    const expandedRows = rows.filter((row) => row.querySelector("[aria-expanded='true']"))
    const viewport = root?.querySelector<HTMLElement>("[data-slot='session-review-scroll']")?.getBoundingClientRect()
    const visibleExpanded = expandedRows.filter((row) => {
      const rect = row.getBoundingClientRect()
      return !!viewport && rect.height > 0 && rect.bottom > viewport.top && rect.top < viewport.bottom
    })
    const painted = visibleExpanded.filter((row) => row.getBoundingClientRect().height > 60 && hasLine(row))
    const expansion = openCount === undefined || (open === openCount && (openCount === 0 ? expandedRows.length === 0 : visibleExpanded.length > 0 && painted.length === visibleExpanded.length && hunks > 0))
    const ready = visible(root) && rows.length > 0 && expansion && !root?.querySelector("[data-testid='review-pane-loading'], [data-testid='workspace-review-pending']")
    const signature = `review:${rendered}/${total}:${loaded}:${open}:${expandedRows.length}:${visibleExpanded.length}:${painted.length}:${hunks}:${root?.innerText.length}`
    return { ready, signature: ready ? signature : "", debug: signature }
  }
  const hasLine = (row: Element): boolean => {
    const deep = (node: Element | ShadowRoot, depth: number): boolean => {
      if (node.querySelector("[data-line]")) return true
      if (depth > 4) return false
      for (const child of node.querySelectorAll("*")) if (child.shadowRoot && deep(child.shadowRoot, depth + 1)) return true
      return false
    }
    return (row.shadowRoot ? deep(row.shadowRoot, 1) : false) || deep(row, 0)
  }
  const fileTabReady = (path: string) => {
    const root = [...document.querySelectorAll<HTMLElement>("[data-testid='tab-file-root']")].find((element) => element.dataset.tabFilePath === path && visible(element))
    const body = !!root && (hasLine(root) || !!root.querySelector("img, [data-component='markdown']"))
    const ready = body && root.dataset.tabFileState === "ready"
    return { ready, signature: ready ? `file:${path}:${root?.dataset.tabFileRenderState}:${root?.innerText.length}` : "", debug: `file:${path}:${root?.dataset.tabFileState}:${root?.dataset.tabFileRenderState}:${body}` }
  }
  const sessionReady = (sessionId: string) => {
    const roots = [...document.querySelectorAll<HTMLElement>("[data-testid='session-page-root']")].filter(visible)
    const root = roots.find((element) => element.dataset.sessionId === sessionId)
    const rows = root?.querySelectorAll("[data-timeline-key]").length ?? 0
    const rail = document.querySelector<HTMLElement>("[data-testid='rail-sidebar-session-row'][data-active='true']")?.dataset.sessionId
    const body = shell()?.querySelector<HTMLElement>("[data-workspace-panel-session-id]")
    const ready = roots.length === 1 && !!root && rows > 0 && rail === sessionId && !!root.querySelector("[data-component='prompt-input']") && !root.querySelector("[data-session-timeline-loading], [data-slot='skeleton'], [data-timeline-row='TurnLoading']")
    return { ready, signature: ready ? `session:${sessionId}:${rows}:${body?.dataset.workspacePanelSessionId}` : "" }
  }
  const evaluate = (predicate: Predicate): { ready: boolean; signature: string; debug?: string } => {
    const host = shell()
    switch (predicate.kind) {
      case "panel-open-files": {
        const files = filesReady()
        const ready = host?.dataset.open === "true" && visible(host) && files.ready
        return { ready, signature: ready ? `${files.signature}:${getComputedStyle(host!).transform}` : "", debug: `open=${host?.dataset.open}:display=${host?.style.display}:vis=${visible(host)} ${files.debug}` }
      }
      case "panel-closed": {
        const rect = host?.getBoundingClientRect()
        const ready = !host || (host.dataset.open === "false" && !!rect && (rect.left >= innerWidth - 1 || (rect.width === 0 && rect.height === 0)))
        return { ready, signature: ready ? `closed:${rect?.left}` : "" }
      }
      case "navigator":
        return predicate.navigator === "files" ? filesReady() : changesReady()
      case "file-tab":
        return fileTabReady(predicate.path)
      case "review":
        return reviewReady(predicate.openCount)
      case "session": {
        const session = sessionReady(predicate.sessionId)
        const body = host?.querySelector<HTMLElement>("[data-workspace-panel-session-id]")
        const own = body?.dataset.workspacePanelSessionId === predicate.sessionId
        const panel = predicate.panel === "files" ? filesReady() : predicate.panel === "changes" ? changesReady() : predicate.panel === "closed" ? evaluate({ kind: "panel-closed" }) : { ready: true, signature: "" }
        const ready = session.ready && panel.ready && (predicate.panel === undefined || predicate.panel === "closed" || (own && host?.dataset.open === "true"))
        return { ready, signature: ready ? `${session.signature}|${panel.signature}` : "" }
      }
      case "maximized": {
        const column = document.querySelector<HTMLElement>("[data-testid='workbench-column']")
        const available = host?.parentElement?.clientWidth ?? 0
        const width = host?.getBoundingClientRect().width ?? 0
        const ready = predicate.maximized ? column?.dataset.floatingHost !== undefined && Math.abs(width - available) < 1 : column?.dataset.floatingHost === undefined && width < available - 100
        return { ready, signature: ready ? `max:${width}:${column?.style.marginRight}` : "" }
      }
    }
  }
  const finish = () => {
    const recording: Recording = {
      inputAt: state.inputAt ?? -1, actAt: state.actAt, readyAt: state.readyAt, readyFrame: state.readyFrame, settledAt: state.settledAt, shellSettledAt: state.shellSettledAt,
      frames: state.frames, loafs: state.loafs, longTasks: state.longTasks, signatures: state.signatures, timeOrigin: performance.timeOrigin,
    }
    const resolve = state.resolve
    state.predicate = undefined
    state.resolve = undefined
    state.reject = undefined
    resolve?.(recording)
  }
  const sample = () => {
    if (!state.predicate) return undefined
    if (state.inputAt === undefined) {
      if (performance.now() > state.deadline) {
        state.reject?.(new Error("no trusted input arrived"))
        state.predicate = undefined
      }
      return undefined
    }
    const host = shell()
    return { ...evaluate(state.predicate), shellSettled: !host || host.dataset.shellSettled === "true", shellPresent: !!host }
  }
  const painted = (frame: ReturnType<typeof sample>, at: number) => {
    if (!frame || !state.predicate || state.inputAt === undefined) return
    state.frames.push(at)
    const index = state.frames.length
    if (state.shellSettledAt === undefined && frame.shellPresent && frame.shellSettled && at > state.inputAt + 20) state.shellSettledAt = at
    const { ready, signature, debug } = frame
    if (!ready && debug && state.readyAt === undefined) state.signatures.push(`f${index}:${debug}`)
    if (ready && state.readyAt === undefined) {
      state.readyAt = at
      state.readyFrame = index
      performance.mark("rec:ready")
    }
    state.stable = ready && signature === state.previous ? state.stable + 1 : ready ? 1 : 0
    state.previous = signature
    if (state.signatures.at(-1) !== signature) state.signatures.push(signature)
    if (state.stable >= 4 && state.settledAt === undefined) {
      state.settledAt = at
      performance.mark("rec:settled")
    }
    if (state.settledAt !== undefined && frame.shellSettled && at >= state.settledAt + 200) return finish()
    if (performance.now() > state.deadline) {
      state.reject?.(new Error(`predicate not ready: ${JSON.stringify(state.predicate)} last=${state.signatures.slice(-3).join(" | ")} debug=${(evaluate(state.predicate) as { debug?: string }).debug ?? ""}`))
      state.predicate = undefined
    }
  }
  const paintedFrames = window.__claxedoPaintedFrames
  if (!paintedFrames) throw new Error("installPaintedFrames has not run in this page")
  const overtaken = (startedAt: number, at: number) => {
    if (state.predicate && state.handledAt !== undefined && startedAt > state.handledAt) state.frames.push(at)
  }
  paintedFrames({ sample, painted, overtaken })
  const onInput = (event: Event) => {
    if (!event.isTrusted || !state.predicate || state.inputAt !== undefined) return
    state.inputAt = event.timeStamp
    state.handledAt = performance.now()
    performance.mark("rec:input")
  }
  const onAct = (event: Event) => {
    if (!event.isTrusted || !state.predicate || state.inputAt === undefined || state.actAt !== undefined) return
    state.actAt = event.timeStamp
    performance.mark("rec:act")
  }
  window.addEventListener("pointerdown", onInput, { capture: true })
  window.addEventListener("keydown", onInput, { capture: true })
  window.addEventListener("click", onAct, { capture: true })
  window.addEventListener("keydown", onAct, { capture: true })
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      if (entry.entryType === "longtask") {
        state.longTasks.push({ start: entry.startTime, duration: entry.duration })
        continue
      }
      const loaf = entry as PerformanceEntry & { blockingDuration?: number; renderStart?: number; styleAndLayoutStart?: number; scripts?: readonly { sourceURL?: string; sourceFunctionName?: string; sourceCharPosition?: number; duration: number; forcedStyleAndLayoutDuration?: number; invoker?: string }[] }
      state.loafs.push({
        start: loaf.startTime, duration: loaf.duration, blocking: loaf.blockingDuration ?? 0, renderStart: loaf.renderStart ?? loaf.startTime, styleAndLayoutStart: loaf.styleAndLayoutStart ?? loaf.startTime,
        scripts: (loaf.scripts ?? []).map((script) => ({ url: (script.sourceURL ?? "").split("/").slice(-1)[0] ?? "", fn: script.sourceFunctionName ?? "", char: script.sourceCharPosition ?? -1, duration: script.duration, forced: script.forcedStyleAndLayoutDuration ?? 0, invoker: script.invoker ?? "" })),
      })
    }
  })
  observer.observe({ type: "long-animation-frame", buffered: false })
  observer.observe({ type: "longtask", buffered: false })
  window.__panelRec = {
    arm: (predicate) => {
      state.predicate = predicate
      state.inputAt = undefined
      state.handledAt = undefined
      state.actAt = undefined
      state.readyAt = undefined
      state.readyFrame = undefined
      state.settledAt = undefined
      state.shellSettledAt = undefined
      state.frames = []
      state.loafs = []
      state.longTasks = []
      state.signatures = []
      state.stable = 0
      state.previous = ""
      state.deadline = performance.now() + 30_000
    },
    done: () => new Promise<Recording>((resolve, reject) => {
      state.resolve = resolve
      state.reject = reject
    }),
  }
}
