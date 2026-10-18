(() => {
  if (window.__mainThread) return
  const RAIL = '[data-slot="session-navigation-row"]'
  const ROW = "[data-timeline-row]"
  const blank = () => ({ railRows: 0, timelineRows: 0, elements: 0, removed: 0, attributes: 0, text: 0 })
  const probe = { counts: blank(), lastMutationAt: 0, inputAt: undefined, armed: undefined }
  const countIn = (node, selector) => (node.matches(selector) ? 1 : 0) + node.querySelectorAll(selector).length
  const census = (records) => {
    for (const record of records) {
      if (record.type === "attributes") probe.counts.attributes += 1
      else if (record.type === "characterData") probe.counts.text += 1
      else {
        probe.counts.removed += record.removedNodes.length
        for (const node of record.addedNodes) {
          if (node.nodeType !== 1) {
            probe.counts.text += 1
            continue
          }
          probe.counts.elements += 1 + node.getElementsByTagName("*").length
          probe.counts.railRows += countIn(node, RAIL)
          probe.counts.timelineRows += countIn(node, ROW)
        }
      }
    }
  }
  const options = { subtree: true, childList: true, attributes: true, characterData: true }
  const observer = new MutationObserver((records) => {
    probe.lastMutationAt = performance.now()
    if (window.__mainThreadCensus) census(records)
  })
  const observe = () => observer.observe(document, options)
  if (document.documentElement) observe()
  else document.addEventListener("readystatechange", observe, { once: true })
  addEventListener("pointerdown", (event) => {
    if (event.isTrusted) probe.inputAt = event.timeStamp
  }, true)

  const screenOf = (sessionId) => {
    const section = document.querySelector(`section[data-component="session-screen"][data-session-id="${CSS.escape(sessionId)}"]`)
    const slot = section?.closest("[data-workbench-content]")
    if (!section || !slot || slot.dataset.stashed === "true" || slot.getAttribute("aria-hidden") === "true") return null
    return section
  }
  const sessionReady = (target) => {
    const screen = screenOf(target.sessionId)
    if (!screen) return false
    const active = [...document.querySelectorAll('[data-slot="session-navigation-row"][data-active="true"]')]
    if (active.length !== 1 || active[0].dataset.sessionId !== target.sessionId) return false
    if (screen.querySelector('[data-session-timeline-loading], [data-testid="session-messages-loading"]')) return false
    if (screen.querySelector('[data-component="prompt-input"]')?.getAttribute("contenteditable") !== "true") return false
    const replies = new Set(target.replyIds)
    return [...screen.querySelectorAll('[data-timeline-row="AssistantPart"]')].some((row) => replies.has(row.dataset.contentMessageId ?? ""))
  }
  const textReady = (target) => {
    const screen = screenOf(target.sessionId)
    const scroll = screen?.querySelector('[data-slot="session-timeline-scroll"]')
    return !!scroll && (scroll.textContent ?? "").includes(target.text)
  }

  const armText = (target, startAt, resolve) => {
    const timer = setInterval(() => {
      if (!textReady(target)) return
      clearInterval(timer)
      const readyAt = performance.now()
      probe.armed.readyAt = readyAt
      performance.mark("mt:ready")
      resolve({ startAt, readyAt, markNow: readyAt })
    }, 250)
    probe.armed.stop = () => clearInterval(timer)
  }
  const arm = (target) => {
    const startAt = target.start === "navigation" ? 0 : performance.now()
    probe.inputAt = undefined
    probe.counts = blank()
    const rail = []
    let resolve
    const done = new Promise((settle) => (resolve = settle))
    probe.armed = { target, startAt, rail, done, readyAt: undefined }
    if (target.kind === "text") return armText(target, startAt, resolve)
        const tracksRail = target.start === "navigation"
    const stop = window.__claxedoPaintedFrames({
      sample: () => ({ ready: probe.armed.readyAt === undefined && sessionReady(target), rail: tracksRail ? document.querySelectorAll(RAIL).length : 0 }),
      painted: (value, paintedAt) => {
        if (tracksRail && rail.at(-1)?.count !== value.rail) rail.push({ at: paintedAt, count: value.rail })
        if (probe.armed.readyAt !== undefined) return !tracksRail
        if (!value.ready) return false
        probe.armed.readyAt = paintedAt
        const markNow = performance.now()
        performance.mark("mt:ready")
        resolve({ startAt: target.start === "pointerdown" ? probe.inputAt ?? startAt : startAt, readyAt: paintedAt, markNow })
        return false
      },
    })
    probe.armed.stop = stop
  }
  const finish = () => {
    probe.armed?.stop?.()
    const result = { rail: probe.armed?.rail ?? [], counts: probe.counts }
    probe.armed = undefined
    return result
  }
  window.__mainThread = {
    arm,
    done: () => probe.armed.done,
    finish,
    quietFor: () => performance.now() - probe.lastMutationAt,
  }
  if (window.__mainThreadBoot && document.contentType === "text/html") arm(window.__mainThreadBoot)
})()
