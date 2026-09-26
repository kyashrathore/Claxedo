;(() => {
  const state = {
    recording: false,
    startedAt: 0,
    stoppedAt: 0,
    mutations: 0,
    lastMutationAt: 0,
    arrivals: 0,
    pending: [],
    latencies: [],
    frames: [],
    loafs: [],
    gaps: [],
  }
  window.__streamProbe = state

  new MutationObserver(() => {
    state.mutations += 1
    state.lastMutationAt = performance.now()
  }).observe(document, { subtree: true, childList: true, characterData: true })

  const channel = new MessageChannel()
  channel.port1.onmessage = () => {
    const now = performance.now()
    state.pending = state.pending.filter((item) => {
      if (state.mutations === item.mutations) return true
      state.latencies.push(now - item.at)
      return false
    })
  }
  let last = 0
  function frame(at) {
    if (!state.recording) return
    if (last) state.frames.push(at - last)
    last = at
    if (state.frames.length % 30 === 0) state.gaps.push(followGap())
    channel.port2.postMessage(0)
    requestAnimationFrame(frame)
  }

  function followGap() {
    const row = document.querySelector("[data-index]")
    let scroller = row?.parentElement
    while (scroller && scroller.scrollHeight <= scroller.clientHeight + 1) scroller = scroller.parentElement
    return scroller ? Math.round(scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight) : -1
  }
  state.followGap = followGap

  new PerformanceObserver((list) => {
    if (!state.recording) return
    for (const entry of list.getEntries()) {
      state.loafs.push({
        duration: entry.duration,
        blockingDuration: entry.blockingDuration,
        renderStart: entry.renderStart,
        styleAndLayoutStart: entry.styleAndLayoutStart,
        startTime: entry.startTime,
        scripts: entry.scripts.map((script) => ({
          duration: script.duration,
          forcedStyleAndLayoutDuration: script.forcedStyleAndLayoutDuration,
          invoker: script.invoker,
          invokerType: script.invokerType,
          sourceURL: script.sourceURL,
          sourceFunctionName: script.sourceFunctionName,
          sourceCharPosition: script.sourceCharPosition,
        })),
      })
    }
  }).observe({ type: "long-animation-frame", buffered: false })

  state.start = () => {
    state.recording = true
    state.startedAt = performance.now()
    state.latencies = []
    state.frames = []
    state.loafs = []
    state.pending = []
    state.gaps = []
    state.arrivals = 0
    last = 0
    requestAnimationFrame(frame)
  }
  state.stop = () => {
    state.recording = false
    state.stoppedAt = performance.now()
  }

  const original = window.fetch
  window.fetch = async function (...args) {
    const response = await original.apply(this, args)
    const input = args[0]
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    if (!url.includes("/events") || !response.body) return response
    const decoder = new TextDecoder()
    const tap = new TransformStream({
      transform(chunk, controller) {
        if (state.recording && /delta/i.test(decoder.decode(chunk, { stream: true }))) {
          state.arrivals += 1
          state.pending.push({ at: performance.now(), mutations: state.mutations })
        }
        controller.enqueue(chunk)
      },
    })
    return new Response(response.body.pipeThrough(tap), { status: response.status, statusText: response.statusText, headers: response.headers })
  }
})()
