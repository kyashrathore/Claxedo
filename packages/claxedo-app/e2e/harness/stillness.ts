import type { Page } from "@playwright/test"

export type StillFrame = { readonly at: number; readonly scrollTop: number; readonly scrollHeight: number; readonly clientHeight: number; readonly ready: boolean; readonly opened: number }

export type ScrollEvent = { readonly at: number; readonly scrollTop: number; readonly framesBefore: number }

export type TranscriptMutation = { readonly at: number; readonly framesBefore: number; readonly target: string }

export type SessionRead = { readonly at: number; readonly kind: "first" | "outline" | "page" | "part" | "message" | "queue" | "row" | "open" | "other"; readonly path: string }

export type Stillness = {
  readonly frames: readonly StillFrame[]
  readonly scrolls: readonly ScrollEvent[]
  readonly reads: readonly SessionRead[]
  readonly mutations: readonly TranscriptMutation[]
}

type StillnessWindow = Window & { __claxedoStillness?: { frames: StillFrame[]; scrolls: ScrollEvent[]; reads: SessionRead[]; mutations: TranscriptMutation[] } }

const SCROLLER = '[data-slot="session-timeline-scroll"] [data-scrollable]'

function installStillness({ sessionId, marker, scroller: inner }: { readonly sessionId: string; readonly marker: string; readonly scroller: string }) {
  const scroller = `[data-session-id="${CSS.escape(sessionId)}"] ${inner}`
  const state = { frames: [] as StillFrame[], scrolls: [] as ScrollEvent[], reads: [] as SessionRead[], mutations: [] as TranscriptMutation[] }
  ;(window as StillnessWindow).__claxedoStillness = state
  const kindOf = (url: URL): SessionRead["kind"] | undefined => {
    const prefix = `/session/${sessionId}`
    const at = url.pathname.indexOf(prefix)
    if (at < 0) return undefined
    const rest = url.pathname.slice(at + prefix.length)
    if (rest !== "" && !rest.startsWith("/")) return undefined
    if (rest === "/outline") return url.searchParams.has("rows") ? "first" : "outline"
    if (rest === "/page") return "page"
    if (/^\/message\/[^/]+\/part\/[^/]+$/.test(rest)) return "part"
    if (rest === "/message") return "message"
    if (rest === "/queue") return "queue"
    if (rest === "") return url.searchParams.get("view") === "open" ? "open" : "row"
    return "other"
  }
  const send = window.fetch.bind(window)
  window.fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), location.href)
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase()
    const kind = method === "GET" ? kindOf(url) : undefined
    if (kind) state.reads.push({ at: performance.now(), kind, path: `${url.pathname}${url.search}` })
    return send(input, init)
  }
  const timeline = `[data-session-id="${CSS.escape(sessionId)}"] [data-session-timeline-root]`
  const describe = (element: Element) => [element.tagName.toLowerCase(), ...["data-component", "data-slot"].map((name) => element.getAttribute(name)).filter(Boolean)].join(" ")
  new MutationObserver((records) => {
    for (const record of records) {
      const element = record.target instanceof Element ? record.target : record.target.parentElement
      if (!element?.matches(`${timeline}, ${timeline} *`)) continue
      state.mutations.push({ at: performance.now(), framesBefore: state.frames.length, target: `${record.type} ${describe(element)}` })
    }
  }).observe(document, { childList: true, characterData: true, subtree: true })
  let ready = false
  let watched: Element | undefined
  const sample = () => {
    const found = document.querySelector<HTMLElement>(scroller)
    const element = found?.checkVisibility({ opacityProperty: true, visibilityProperty: true }) ? found : undefined
    if (element && element !== watched) {
      watched = element
      element.addEventListener("scroll", () => state.scrolls.push({ at: performance.now(), scrollTop: element.scrollTop, framesBefore: state.frames.length }), { passive: true })
    }
    ready ||= !!element && (element.textContent ?? "").includes(marker)
    if (element) state.frames.push({ at: performance.now(), scrollTop: element.scrollTop, scrollHeight: element.scrollHeight, clientHeight: element.clientHeight, ready, opened: element.querySelectorAll('[aria-expanded="true"]').length })
    requestAnimationFrame(sample)
  }
  requestAnimationFrame(sample)
}

export async function recordStillness(app: Page, input: { readonly sessionId: string; readonly marker: string }) {
  await app.addInitScript(installStillness, { ...input, scroller: SCROLLER })
}

export async function stillnessAfter(app: Page, quietMs: number): Promise<Stillness> {
  return app.evaluate(async (ms) => {
    await new Promise((resolve) => setTimeout(resolve, ms))
    const state = (window as StillnessWindow).__claxedoStillness
    if (!state) throw new Error("recordStillness has not run in this page")
    return { frames: [...state.frames], scrolls: [...state.scrolls], reads: [...state.reads], mutations: [...state.mutations] }
  }, quietMs)
}

export function sinceFirstReady(stillness: Stillness, from = 0) {
  const firstIndex = stillness.frames.findIndex((frame) => frame.ready && frame.at >= from)
  const first = stillness.frames[firstIndex]
  if (!first) throw new Error("the transcript never showed its marker")
  const after = stillness.frames.slice(firstIndex)
  const scrolls = stillness.scrolls.filter((scroll) => scroll.framesBefore > firstIndex)
  const firstFrameScrollReport = scrolls.find((scroll) => scroll.framesBefore === firstIndex + 1 && scroll.scrollTop === first.scrollTop)
  return {
    first,
    scrolls: scrolls.filter((scroll) => scroll !== firstFrameScrollReport).length,
    scrollTopDelta: Math.max(...after.map((frame) => Math.abs(frame.scrollTop - first.scrollTop))),
    scrollHeightDelta: Math.max(...after.map((frame) => Math.abs(frame.scrollHeight - first.scrollHeight))),
    readsAfter: stillness.reads.filter((read) => read.at >= first.at).map((read) => read.kind),
    mutations: stillness.mutations.filter((mutation) => mutation.framesBefore > firstIndex).map((mutation) => mutation.target),
    readsSince: stillness.reads.filter((read) => read.at >= from).map((read) => read.kind),
    watchedMs: Math.round((after.at(-1)?.at ?? first.at) - first.at),
  }
}
