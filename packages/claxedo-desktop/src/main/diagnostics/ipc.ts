import { LocalDiagnostics } from "@claxedo/app/process-diagnostics-contract"
import type { Profiler } from "./profiler"

export type DiagnosticsIpcRouter = {
  handle(channel: string, handler: (event: unknown, input?: unknown) => unknown): void
  removeHandler?(channel: string): void
}

type DiagnosticsFrame = {
  url: string
}

export type DiagnosticsWebContents = {
  id: number
  mainFrame: DiagnosticsFrame
  getURL(): string
  isDestroyed(): boolean
  send(channel: string, value: unknown): void
  on(event: string, listener: (...args: unknown[]) => void): unknown
  off(event: string, listener: (...args: unknown[]) => void): unknown
}

type SenderEvent = {
  sender: DiagnosticsWebContents
  senderFrame: DiagnosticsFrame | null
}

const channels = [
  "process-diagnostics:get-snapshot",
  "process-diagnostics:subscribe",
  "process-diagnostics:unsubscribe",
  "process-diagnostics:stop",
  "process-diagnostics:kill",
] as const

export function registerProcessDiagnosticsIpc(
  router: DiagnosticsIpcRouter,
  options: {
    profiler: Profiler
    isAllowedUrl(url: string): boolean
    confirmAction(input: {
      webContents: DiagnosticsWebContents
      action: LocalDiagnostics.ActionKind
      ownerLabel: string
    }): Promise<boolean>
  },
) {
  type State = {
    webContents: DiagnosticsWebContents
    generation: number
    documentReady: boolean
    subscribedGeneration?: number
    lastSnapshot?: LocalDiagnostics.RetainedSnapshot
    unsubscribe?: () => void
    onNavigation: (...args: unknown[]) => void
    onRendererGone: (...args: unknown[]) => void
    onLoadFinished: (...args: unknown[]) => void
    onDestroyed: (...args: unknown[]) => void
  }
  const states = new Map<number, State>()

  const stateFor = (input: unknown) => {
    const event = input as Partial<SenderEvent>
    if (!event.sender || !event.senderFrame) throw new Error("Untrusted diagnostics sender")
    const state = states.get(event.sender.id)
    if (!state || state.webContents !== event.sender || event.sender.isDestroyed()) {
      throw new Error("Unregistered diagnostics sender")
    }
    if (!state.documentReady) throw new Error("Diagnostics navigation is not ready")
    if (event.senderFrame !== event.sender.mainFrame) throw new Error("Diagnostics IPC is main-frame only")
    if (event.senderFrame.url !== event.sender.getURL()) throw new Error("Stale diagnostics navigation")
    if (!options.isAllowedUrl(event.senderFrame.url)) throw new Error("Untrusted diagnostics origin")
    return state
  }

  router.handle("process-diagnostics:get-snapshot", (event) => {
    stateFor(event)
    return LocalDiagnostics.RetainedSnapshot.parse(options.profiler.getSnapshot())
  })
  router.handle("process-diagnostics:subscribe", (event) => {
    const state = stateFor(event)
    if (state.subscribedGeneration === state.generation) {
      throw new Error("Diagnostics already subscribed for this navigation")
    }
    revoke(state)
    const generation = state.generation
    state.subscribedGeneration = generation
    const initial = LocalDiagnostics.RetainedSnapshot.parse(options.profiler.getSnapshot())
    state.lastSnapshot = initial
    state.unsubscribe = options.profiler.subscribe((snapshot) => {
      if (state.generation !== generation || state.webContents.isDestroyed()) return
      if (!options.isAllowedUrl(state.webContents.getURL())) {
        revoke(state)
        return
      }
      const previous = state.lastSnapshot
      const update: LocalDiagnostics.SnapshotUpdate =
        previous && previous.generation === snapshot.generation
          ? { kind: "delta", delta: snapshotDelta(previous, snapshot) }
          : { kind: "full", snapshot }
      try {
        state.webContents.send("process-diagnostics:snapshot", update)
        state.lastSnapshot = snapshot
      } catch {
        revoke(state)
      }
    })
    return { kind: "full" as const, snapshot: initial }
  })
  router.handle("process-diagnostics:unsubscribe", (event) => {
    revoke(stateFor(event))
    return { ok: true as const }
  })
  router.handle("process-diagnostics:stop", (event, input) =>
    dispatchAction(event, LocalDiagnostics.StopRequest.parse(input)))
  router.handle("process-diagnostics:kill", (event, input) =>
    dispatchAction(event, LocalDiagnostics.KillRequest.parse(input)))

  async function dispatchAction(event: unknown, request: LocalDiagnostics.ActionRequest) {
    const state = stateFor(event)
    const navigationGeneration = state.generation
    const profilerGeneration = options.profiler.getGeneration()
    const prepared = options.profiler.prepareAction(request)
    if (!prepared.ok) return LocalDiagnostics.ActionResult.parse(prepared.result)
    const confirmed = await options.confirmAction({
      webContents: state.webContents,
      action: prepared.claim.action,
      ownerLabel: prepared.claim.ownerLabel,
    })
    if (!confirmed) {
      return LocalDiagnostics.ActionResult.parse(options.profiler.cancelAction(prepared.claim))
    }
    if (
      state.generation !== navigationGeneration ||
      !state.documentReady ||
      state.webContents.isDestroyed() ||
      !options.isAllowedUrl(state.webContents.getURL()) ||
      options.profiler.getGeneration() !== profilerGeneration
    ) {
      return LocalDiagnostics.ActionResult.parse(
        options.profiler.cancelAction(prepared.claim, "stale-generation"),
      )
    }
    return LocalDiagnostics.ActionResult.parse(await options.profiler.executeAction(prepared.claim))
  }

  function registerWebContents(webContents: DiagnosticsWebContents) {
    if (states.has(webContents.id)) return
    const state: State = {
      webContents,
      generation: 0,
      documentReady: options.isAllowedUrl(webContents.getURL()),
      onNavigation: (...args: unknown[]) => {
        const details = args[0] as { isMainFrame?: boolean; isSameDocument?: boolean }
        const isMainFrame = details.isMainFrame ?? args[3] === true
        const isSameDocument = details.isSameDocument ?? args[2] === true
        if (!isMainFrame || isSameDocument) return
        state.generation++
        state.documentReady = false
        revoke(state)
      },
      onRendererGone: () => {
        state.generation++
        state.documentReady = false
        revoke(state)
      },
      onLoadFinished: () => {
        state.documentReady = options.isAllowedUrl(webContents.getURL())
      },
      onDestroyed: () => {
        revoke(state)
        states.delete(webContents.id)
      },
    }
    states.set(webContents.id, state)
    webContents.on("did-start-navigation", state.onNavigation)
    webContents.on("render-process-gone", state.onRendererGone)
    webContents.on("did-finish-load", state.onLoadFinished)
    webContents.on("destroyed", state.onDestroyed)
  }

  function revoke(state: {
    unsubscribe?: () => void
    subscribedGeneration?: number
    lastSnapshot?: LocalDiagnostics.RetainedSnapshot
  }) {
    state.unsubscribe?.()
    state.unsubscribe = undefined
    state.subscribedGeneration = undefined
    state.lastSnapshot = undefined
  }

  return {
    registerWebContents,
    dispose() {
      states.forEach((state) => {
        revoke(state)
        state.webContents.off("did-start-navigation", state.onNavigation)
        state.webContents.off("render-process-gone", state.onRendererGone)
        state.webContents.off("did-finish-load", state.onLoadFinished)
        state.webContents.off("destroyed", state.onDestroyed)
      })
      states.clear()
      channels.forEach((channel) => router.removeHandler?.(channel))
    },
  }
}

export function snapshotDelta(
  previous: LocalDiagnostics.RetainedSnapshot,
  current: LocalDiagnostics.RetainedSnapshot,
): LocalDiagnostics.RetainedSnapshotDelta {
  const previousSamples = new Map(previous.samples.map((sample) => [sampleKey(sample), sample]))
  const currentSamples = new Map(current.samples.map((sample) => [sampleKey(sample), sample]))
  const previousMarkers = new Map(previous.markers.map((marker) => [marker.id, marker]))
  const currentMarkers = new Map(current.markers.map((marker) => [marker.id, marker]))
  return {
    version: 1,
    generation: current.generation,
    baseCapturedAt: previous.capturedAt,
    capturedAt: current.capturedAt,
    retainedFromAt: current.retainedFromAt,
    targetWindowMs: current.targetWindowMs,
    retention: current.retention,
    owners: current.owners,
    processes: current.processes,
    sources: current.sources,
    interval: current.interval,
    sampleUpserts: current.samples.filter((sample) => !previousSamples.has(sampleKey(sample))),
    sampleRemovals: previous.samples.flatMap((sample) =>
      currentSamples.has(sampleKey(sample))
        ? []
        : [{ at: sample.at, processId: sample.processId }]),
    markerUpserts: current.markers.filter((marker) => {
      const prior = previousMarkers.get(marker.id)
      return !prior || JSON.stringify(prior) !== JSON.stringify(marker)
    }),
    markerRemovals: previous.markers.flatMap((marker) =>
      currentMarkers.has(marker.id) ? [] : [marker.id]),
  }
}

function sampleKey(sample: Pick<LocalDiagnostics.MetricPoint, "at" | "processId">) {
  return `${String(sample.at)}\0${sample.processId}`
}
