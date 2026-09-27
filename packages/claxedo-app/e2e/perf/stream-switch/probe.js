;(() => {
  const state = { recording: false, frames: [], overtaken: [], inputs: [], loafs: [] }
  window.__switchProbe = state

  const painted = (element) => element.checkVisibility({ opacityProperty: true, visibilityProperty: true, contentVisibilityAuto: true })

  function pane(root) {
    const scroller = root.querySelector('[data-slot="session-timeline-scroll"] [data-scrollable]')
    const timeline = root.querySelector("[data-session-timeline-root]")
    const view = scroller?.getBoundingClientRect()
    let rows = 0
    let chars = 0
    if (timeline && view && painted(timeline)) {
      for (const row of root.querySelectorAll("[data-timeline-key]")) {
        const box = row.getBoundingClientRect()
        if (box.height <= 0 || box.bottom <= view.top || box.top >= view.bottom) continue
        rows += 1
        chars += row.textContent.length
      }
    }
    const slot = root.closest("[data-workbench-content]")
    const slotStyle = slot ? getComputedStyle(slot) : undefined
    return {
      id: root.dataset.sessionId ?? "",
      shown: painted(root),
      cv: slotStyle?.contentVisibility ?? "",
      vis: slotStyle?.visibility ?? "",
      presence: slot?.dataset.presence ?? (slot?.dataset.stashed ? "stashed" : "shown"),
      opacity: getComputedStyle(root).opacity,
      rows,
      chars,
      top: Math.round(scroller?.scrollTop ?? -1),
      fromEnd: scroller ? Math.round(scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop) : -1,
      height: scroller ? Math.round(scroller.scrollHeight) : -1,
      loading: root.querySelectorAll('[data-session-timeline-loading], [data-slot="skeleton"], [data-timeline-row="TurnLoading"]').length,
    }
  }

  let stopFrames = () => {}

  document.addEventListener(
    "pointerdown",
    (event) => {
      if (!state.recording) return
      const row = event.target.closest?.('[data-testid="rail-sidebar-session-row"]')
      state.inputs.push({ at: event.timeStamp, target: row?.dataset.sessionId ?? "" })
    },
    { capture: true },
  )

  new PerformanceObserver((list) => {
    if (!state.recording) return
    for (const entry of list.getEntries()) {
      state.loafs.push({
        start: entry.startTime,
        duration: entry.duration,
        blocking: entry.blockingDuration,
        renderStart: entry.renderStart,
        scripts: entry.scripts.map((script) => ({ duration: script.duration, invoker: script.invoker, fn: script.sourceFunctionName, url: script.sourceURL, char: script.sourceCharPosition })),
      })
    }
  }).observe({ type: "long-animation-frame", buffered: false })

  state.start = () => {
    state.recording = true
    state.frames = []
    state.overtaken = []
    state.inputs = []
    state.loafs = []
    stopFrames = window.__claxedoPaintedFrames({
      sample: () => ({
        rail: document.querySelector('[data-testid="rail-sidebar-session-row"][data-active="true"]')?.dataset.sessionId ?? "",
        url: location.pathname,
        panes: [...document.querySelectorAll('[data-testid="session-page-root"]')].map(pane),
      }),
      painted: (frame, at) => void state.frames.push({ ...frame, at }),
      overtaken: (_, at) => void state.overtaken.push(at),
    })
  }
  state.stop = () => {
    stopFrames()
    state.recording = false
    return { timeOrigin: performance.timeOrigin, frames: state.frames, overtaken: state.overtaken, inputs: state.inputs, loafs: state.loafs }
  }
})()
