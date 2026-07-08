import { batch, createEffect, createRenderEffect, createSignal, on, onCleanup } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { useSDK } from "@/context/sdk"
import { usePlatform } from "@claxedo/context/platform"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Persist, persisted } from "@/utils/persist"
import { useOptionalTerminal } from "@/context/terminal"
import { Process } from "@claxedo/process/process"
import { createProcessClient } from "@claxedo/process/client"
import { resolveWorkspaceRuntime } from "../../cloud/runtime/workspace-runtime-store"
import { can } from "../../shell/auth/role"
import { workspacePlacement } from "../../shell/workspace/workspace-connection"
import { getClaxedoServerUrl } from "../../utils/api"
import { useClaxedoEventsOptional } from "../../providers/claxedo-events"
import { useClaxedoState } from "../state"
import { createProcessOwnership, createTerminalTabOps } from "./process-ownership"
import { AddProcessDialog } from "../components/add-process-dialog"
import { fastSessionSwitchAnyNetworkQuiet } from "../../session/store/fast-session-switch"

type ProcessConfig = Process.ProcessConfig
type ManagedProcess = Process.ManagedProcess
type ProcessStatus = Process.Status
type LaunchResult = Process.LaunchResult

function decodeProcessStatus(value: string): ProcessStatus | undefined {
  const status = Process.Status.safeParse(value)
  return status.success ? status.data : undefined
}

function decodeProcessConfigs(values: unknown[]) {
  return values.map((value) => Process.ProcessConfig.safeParse(value)).flatMap((parsed) => parsed.success ? [parsed.data] : [])
}

type ProcessPaneStore = {
  configs: ProcessConfig[]
  processes: Record<string, ManagedProcess>
  paneHeight: number
}

const DEFAULT_PANE_HEIGHT = 300
const MIN_PANE_HEIGHT = 100
const FETCH_TIMEOUT = 5_000
const POST_TIMEOUT = 10_000

function afterVisibleWork(callback: () => void) {
  let cancelled = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let frame: ReturnType<typeof requestAnimationFrame> | undefined
  let idle: ReturnType<typeof requestIdleCallback> | undefined

  frame = requestAnimationFrame(() => {
    frame = undefined
    if (cancelled) return
    const schedule = () => {
      if (cancelled) return
      callback()
    }
    if (typeof requestIdleCallback === "function") {
      idle = requestIdleCallback(schedule, { timeout: 1_200 })
      return
    }
    timer = setTimeout(schedule, 120)
  })

  return () => {
    cancelled = true
    if (frame !== undefined) cancelAnimationFrame(frame)
    if (idle !== undefined && typeof cancelIdleCallback === "function") cancelIdleCallback(idle)
    if (timer) clearTimeout(timer)
  }
}

const processPaneContextInput = {
  name: "ProcessPane",
  gate: false,
  init: (props: { surfaceId?: string }) => {
    const sdk = useSDK()
    const platform = usePlatform()
    const claxedoServerUrl = getClaxedoServerUrl()
    const claxedoEvents = useClaxedoEventsOptional()
    const state = useClaxedoState()
    const terminalCtx = useOptionalTerminal()
    const [loaded, setLoaded] = createSignal(false)

    const ownership = createProcessOwnership(state)
    const tabOps = createTerminalTabOps(state)
    let initialProcessPtyResolved = false
    const resolveInitialProcessPty = () => {
      if (initialProcessPtyResolved) return
      initialProcessPtyResolved = true
      ownership.resolveInitialProcessPty()
    }

    const dialog = useDialog()

    // Persisted UI state (height — NOT visibility)
    const [store, setStore, , ready] = persisted(
      Persist.scoped(sdk.directory, undefined, "process-pane"),
      createStore<ProcessPaneStore>({
        configs: [],
        processes: {},
        paneHeight: DEFAULT_PANE_HEIGHT,
      }),
    )
    const isProcessOpen = () => {
      if (props?.surfaceId) return state.wb.selectors.focusedContent() === props.surfaceId
      const panel = state.workspacePanel.state()
      return panel.open && panel.navigator === "processes" && panel.workspaceDir === sdk.directory
    }
    const requestProcessOpen = () => {
      if (props?.surfaceId) {
        state.layout.showContent(props.surfaceId)
        return
      }
      state.workspacePanel.open({
        workspaceDir: sdk.directory,
        navigator: "processes",
      })
    }
    const states = () => {
      const list: Array<ProcessStatus | undefined> = []
      for (const id in store.processes) {
        list.push(store.processes[id]?.status)
      }
      return list
    }

    const anyRunning = () => {
      return states().some((status) => status === "running" || status === "starting" || status === "restarting")
    }

    const anyCrashed = () => {
      return states().some((status) => status === "crashed")
    }

    const workspaceId = () => sdk.workspace?.(sdk.directory)?.workspaceId
    const canMutateProcesses = () => {
      const id = workspaceId()
      return !id || can("mutate.workspace", workspacePlacement(id))
    }

    const sync = () => {
      const crashed = anyCrashed()
      state.processPane.setRunning(sdk.directory, anyRunning())
      state.processPane.setCrashed(sdk.directory, crashed)
      if (!crashed) {
        state.processPane.setCrashedWhileClosed(false)
      }
    }

    const native = platform.fetch ?? globalThis.fetch

    async function fetch(input: RequestInfo | URL, init?: RequestInit) {
      const ms = (init?.method ?? "GET") === "GET" ? FETCH_TIMEOUT : POST_TIMEOUT
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), ms)
      try {
        const signal = init?.signal ? AbortSignal.any([ctrl.signal, init.signal]) : ctrl.signal
        return await native(input, {
          ...init,
          signal,
        })
      } finally {
        clearTimeout(timer)
      }
    }

    const client = createProcessClient({
      baseUrl: claxedoServerUrl,
      directory: sdk.directory,
      workspaceId: sdk.workspace?.(sdk.directory)?.workspaceId,
      fetch,
      resolveWorkspaceRuntime: (input) => resolveWorkspaceRuntime({
        baseUrl: claxedoServerUrl,
        request: fetch,
        directory: input.directory,
      }),
    })

    async function fetchProcesses(): Promise<boolean> {
      try {
        const data = await client.list()

        // Build the set of current process PTY IDs from server data.
        const currentPtyIds = new Set<string>()
        for (const p of data.processes) {
          if (p.ptyId) currentPtyIds.add(p.ptyId)
        }

        batch(() => {
          setStore("configs", reconcile(data.configs, { key: "id" }))

          // Save crashed ptyIds before reconcile — the server clears ptyId
          // on PTY-death crashes, but we want to keep the client-side value
          // so the Terminal component stays mounted showing crash output.
          const crashedPtyIds = new Map<string, string>()
          for (const configId of Object.keys(store.processes)) {
            const proc = store.processes[configId]
            if (proc?.status === "crashed" && proc.ptyId) {
              crashedPtyIds.set(configId, proc.ptyId)
            }
          }

          const byId: Record<string, ManagedProcess> = {}
          for (const p of data.processes) {
            byId[p.configId] = p
            // Own process PTYs so the terminal detection effect skips them
            // and doesn't create competing tabs/WebSocket connections.
            if (p.ptyId) {
              ownership.ownProcess(p.configId, p.ptyId)
              tabOps.removeAutoCreatedTab(p.ptyId)
            }
          }
          setStore("processes", reconcile(byId))

          // Restore client-preserved ptyIds for crashed processes where the
          // server returned undefined (PTY-death crash clears ptyId server-side).
          for (const [configId, ptyId] of crashedPtyIds) {
            const proc = store.processes[configId]
            if (proc && proc.status === "crashed" && !proc.ptyId) {
              setStore("processes", configId, "ptyId", ptyId)
              ownership.ownProcess(configId, ptyId)
            }
          }
        })
        sync()

        // After owning all CURRENT process PTYs, clean up stale ones.
        // On reload, the persisted terminalOwner map has OLD ptyIds from
        // the previous session. These are no longer valid, and their
        // persisted terminal tabs should be removed.
        lastFetchedPtyIds = currentPtyIds
        cleanupStaleProcessTabs(currentPtyIds)

        return true
      } catch {
        return false
      }
    }

    async function run<T>(task: () => Promise<T>) {
      try {
        return await task()
      } catch {
        return undefined
      }
    }

    /** Update a single process entry in the store from a server response. */
    function applyProcess(proc: ManagedProcess | undefined) {
      if (!proc) return
      setStore("processes", proc.configId, {
        ...proc,
        conflict: undefined,
        routeConflict: undefined,
        launchError: undefined,
      })
      // Mark the PTY as process-owned so the terminal detection effect
      // skips it (existing `owner` check) and the close effect won't kill it.
      if (proc.ptyId) {
        ownership.ownProcess(proc.configId, proc.ptyId)
        tabOps.removeAutoCreatedTab(proc.ptyId)
      }
      sync()
    }

    function settledStatus(proc?: ManagedProcess, status?: ProcessStatus) {
      if (status) return status
      if (!proc) return "idle" as ProcessStatus
      if (proc.status === "starting" || proc.status === "restarting") {
        return proc.ptyId ? ("running" as ProcessStatus) : ("stopped" as ProcessStatus)
      }
      if (proc.status === "stopping") return "stopped" as ProcessStatus
      return proc.status
    }

    function restore(configId: string, proc?: ManagedProcess, status?: ProcessStatus) {
      if (proc) {
        setStore("processes", configId, {
          ...proc,
          status: settledStatus(proc, status),
          conflict: undefined,
          routeConflict: undefined,
          launchError: undefined,
        })
        sync()
        return
      }
      setStore("processes", configId, {
        configId,
        status: status ?? ("idle" as ProcessStatus),
        restartCount: 0,
        ptyId: undefined,
        exitCode: undefined,
        exitedAt: undefined,
        startedAt: undefined,
        assignedPort: undefined,
        conflict: undefined,
        routeConflict: undefined,
        launchError: undefined,
      })
      sync()
    }

    function applyCrash(
      configId: string,
      proc: ManagedProcess | undefined,
      fields: {
        conflict?: Process.PortConflictInfo
        routeConflict?: Process.RouteConflictInfo
        launchError?: string
      },
    ) {
      setStore("processes", configId, {
        ...(proc ?? { configId, restartCount: 0 }),
        configId,
        status: "crashed" as ProcessStatus,
        ptyId: undefined,
        exitCode: undefined,
        exitedAt: Date.now(),
        startedAt: proc?.startedAt,
        assignedPort: undefined,
        conflict: fields.conflict,
        routeConflict: fields.routeConflict,
        launchError: fields.launchError,
      })
      sync()
      if (!isProcessOpen()) requestProcessOpen()
    }

    function failLaunch(configId: string, error: string, proc?: ManagedProcess) {
      applyCrash(configId, proc, { launchError: error })
    }

    function clash(configId: string, conflict: Process.PortConflictInfo, proc?: ManagedProcess) {
      applyCrash(configId, proc, { conflict })
    }

    function routeClash(configId: string, conflict: Process.RouteConflictInfo, proc?: ManagedProcess) {
      applyCrash(configId, proc, { routeConflict: conflict })
    }

    function read(
      configId: string,
      out: LaunchResult,
      proc?: ManagedProcess,
      status?: ProcessStatus,
      prompt = true,
    ): ManagedProcess | undefined {
      if (out.kind === "started" || out.kind === "already_running") {
        applyProcess(out.process)
        return out.process
      }
      if (out.kind === "port_conflict") {
        if (prompt) {
          clash(configId, out.conflict, proc)
          return undefined
        }
        restore(configId, proc, status)
        return undefined
      }
      if (out.kind === "route_conflict") {
        if (prompt) {
          routeClash(configId, out.conflict, proc)
          return undefined
        }
        restore(configId, proc, status)
        return undefined
      }
      if (out.kind === "failed") {
        if (out.process) {
          applyProcess(out.process)
          return out.process
        }
        failLaunch(configId, out.error, proc)
        return undefined
      }
      if (out.kind === "not_found") {
        failLaunch(configId, out.error, proc)
        return undefined
      }
      restore(configId, proc, status)
      return undefined
    }

    /**
     * Clean up stale process-owned terminals from previous sessions.
     *
     * On reload, the persisted stores have:
     * - `terminalOwner` entries mapping OLD ptyIds → "process:configId"
     * - `terminal.all()` entries for those OLD ptyIds (upstream terminal store)
     * - `groups` with terminal tabs referencing those OLD ptyIds
     *
     * After fetchProcesses owns all CURRENT ptyIds, any "process:*" owned
     * ptyId NOT in the current set is stale. We:
     * 1. Remove the old entries from `terminal.all()` — this is the primary
     *    defense. Without entries in `terminal.all()`, terminal tab
     *    reconciliation can't revive stale PTYs.
     * 2. Remove any persisted tabs referencing those PTYs.
     * 3. Keep the `terminalOwner` entries as belt-and-suspenders — the
     *    `owner` check in the detection effect is a secondary defense.
     */
    function cleanupStaleProcessTabs(currentPtyIds: Set<string>) {
      const allProcessOwned = ownership.processOwnedPtyIds()
      const stale = new Set<string>()
      for (const id of allProcessOwned) {
        if (!currentPtyIds.has(id)) {
          stale.add(id)
        }
      }
      if (stale.size > 0) {
        terminalCtx?.removeStale?.(stale)
      }
      tabOps.removeTerminalTabsByPtyIds(stale)
    }

    // Set of current process PTY IDs — updated by fetchProcesses, used by
    // the deferred effect to re-clean when ClaxedoLayout persistence loads late.
    let lastFetchedPtyIds = new Set<string>()

    // ── SSE event subscription ───────────────────────────────────────
    // Process events now come from claxedo-server via claxedoBus (flat structure).
    // Subscribe via ClaxedoEventsProvider; fall back silently if unavailable.

    if (claxedoEvents) {
      const unsubStarted = claxedoEvents.on("process.started", (event) => {
        const { configId, ptyId } = event
        // Own the PTY before updating the store — the detection
        // effect's existing `owner` check will skip it.
        if (ptyId) {
          ownership.ownProcess(configId, ptyId)
          tabOps.removeAutoCreatedTab(ptyId)
        }
        setStore("processes", configId, {
          configId,
          ptyId,
          status: "running" as ProcessStatus,
          restartCount: store.processes[configId]?.restartCount ?? 0,
          startedAt: Date.now(),
          exitedAt: undefined,
          exitCode: undefined,
        })
        // If openInTab was called before the process was running,
        // open the terminal tab now that we have a ptyId.
        if (pendingTabOpens.has(configId) && ptyId) {
          pendingTabOpens.delete(configId)
          openTerminalTab(configId, ptyId)
        }
        sync()
      })
      onCleanup(unsubStarted)

      const unsubStopped = claxedoEvents.on("process.stopped", (event) => {
        const { configId, exitCode } = event
        const existing = store.processes[configId]
        if (existing) {
          setStore("processes", configId, {
            ...existing,
            status: "stopped" as ProcessStatus,
            ptyId: undefined,
            exitCode,
            exitedAt: Date.now(),
          })
        }
        sync()
      })
      onCleanup(unsubStopped)

      const unsubCrashed = claxedoEvents.on("process.crashed", (event) => {
        // Fires when the PTY itself dies OR when the inner command exits
        // inside the interactive shell (detected via OSC process-exit marker).
        // Preserve existing ptyId via spread, and also accept ptyId from the
        // event itself (command-exit crashes include it) so even if the client
        // store was cleared (e.g. during mount), the ptyId is recovered.
        const { configId, exitCode, restartCount, ptyId: eventPtyId } = event
        const existing = store.processes[configId]
        const ptyId = existing?.ptyId ?? eventPtyId
        if (ptyId) {
          ownership.ownProcess(configId, ptyId)
        }
        setStore("processes", configId, {
          ...(existing ?? { configId }),
          status: "crashed" as ProcessStatus,
          ptyId,
          exitCode,
          restartCount,
          exitedAt: Date.now(),
        })
        // Alert workspace dot indicator when the process panel is not active.
        if (!isProcessOpen()) {
          state.processPane.setCrashedWhileClosed(true)
        }
        sync()
        void fetchProcesses()
      })
      onCleanup(unsubCrashed)

      const unsubStatus = claxedoEvents.on("process.status", (event) => {
        const { configId } = event
        const status = decodeProcessStatus(event.status)
        if (!status) return
        const existing = store.processes[configId]
        // Guard: reject stale "stopping" events for processes already
        // in a terminal state. Once confirmed stopped/crashed (via
        // belt-and-suspenders or process.stopped/crashed SSE), only
        // "starting" (explicit user action) should transition out.
        if (
          existing &&
          status === "stopping" &&
          (existing.status === "stopped" || existing.status === "crashed")
        ) {
          return
        }
        if (existing) {
          setStore("processes", configId, {
            ...existing,
            status,
          })
        } else {
          setStore("processes", configId, {
            configId,
            status,
            restartCount: 0,
          })
        }
        sync()
        // Port-conflict crashes only emit process.status (not process.crashed).
        // Re-fetch to pick up the full state including the conflict field so
        // the inline overlay can render.
        if (status === "crashed") {
          void fetchProcesses()
        }
      })
      onCleanup(unsubStatus)

      const unsubConfigChanged = claxedoEvents.on("process.config.changed", (event) => {
        const configs = decodeProcessConfigs(event.configs)
        const configIds = new Set(configs.map((c) => c.id))
        batch(() => {
          setStore("configs", reconcile(configs, { key: "id" }))
          // Reconcile process entries: keep existing for known configs,
          // create idle entries for new configs, drop removed ones.
          const next: Record<string, ManagedProcess> = {}
          for (const id of configIds) {
            if (store.processes[id]) {
              next[id] = store.processes[id]!
            } else {
              next[id] = {
                configId: id,
                status: "idle",
                restartCount: 0,
              }
            }
          }
          setStore("processes", reconcile(next))
        })
        sync()
      })
      onCleanup(unsubConfigChanged)
    }

    // ── Tab integration ──────────────────────────────────────────────

    // Track configIds that should be opened in a tab once their ptyId
    // becomes available (i.e. after starting a stopped process).
    const pendingTabOpens = new Set<string>()

    function openTerminalTab(configId: string, ptyId: string) {
      const config = store.configs.find((c) => c.id === configId)
      const title = config?.name ?? "Process"
      const dir = sdk.directory
      if (!dir) return

      // Release process ownership so the tab system manages this PTY normally.
      ownership.disownProcess(ptyId)

      const surfaceId = tabOps.addTerminalTab(dir, ptyId, title)
      if (surfaceId) tabOps.setActiveTab(surfaceId)
    }

    // ── Initial fetch ────────────────────────────────────────────────

    // The terminal detection counter starts at 1 (set in terminal.ts) to
    // block tab creation until this provider resolves. We keep that initial
    // count active during the fetch window and resolve it when done.
    // For additional start/restart actions we use expect/resolve pairs.

    // Retry when visible: gateway may still be waking up after system sleep.
    // Keep this out of review/session switch mount so process APIs do not
    // join the chat first-fold hot path.
    const hydrateProcesses = async () => {
      if (fastSessionSwitchAnyNetworkQuiet()) return
      let ok = false
      try {
        for (let attempt = 0; attempt < 3; attempt++) {
          ok = await fetchProcesses()
          if (ok) return
          await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, attempt)))
        }
      } finally {
        setLoaded(true)
        resolveInitialProcessPty()
      }
    }

    createEffect(() => {
      if (isProcessOpen()) return
      resolveInitialProcessPty()
    })

    createEffect(() => {
      if (!isProcessOpen()) return
      if (loaded()) return
      const stop = afterVisibleWork(() => void hydrateProcesses())
      onCleanup(stop)
    })

    // ── Deferred stale tab cleanup ────────────────────────────────────
    // On desktop, the ClaxedoLayout store uses async persistence.
    // The terminalOwner map and groups (with tabs) may hydrate AFTER
    // fetchProcesses has already run. This deferred effect catches that:
    // when the ClaxedoLayout store becomes ready, re-run the stale cleanup
    // with the ptyIds from the last successful fetch.
    createRenderEffect(
      on(
        () => state.ready(),
        (isReady) => {
          if (!isReady) return
          if (lastFetchedPtyIds.size === 0) return
          cleanupStaleProcessTabs(lastFetchedPtyIds)
        },
      ),
    )

    // ── Wake detection ──────────────────────────────────────────────

    // Detect system sleep via setInterval time-gap (works in both web
    // and desktop shells). Add visibilitychange as fast-path for browser tab switching.
    let lastTick = Date.now()
    const TICK_INTERVAL = 10_000 // check every 10s
    const SLEEP_THRESHOLD = 30_000 // >30s gap = sleep detected

    const wakeTimer = setInterval(() => {
      const now = Date.now()
      const gap = now - lastTick
      lastTick = now
      if (gap > SLEEP_THRESHOLD && !fastSessionSwitchAnyNetworkQuiet() && (loaded() || isProcessOpen())) {
        void fetchProcesses()
      }
    }, TICK_INTERVAL)

    const onVisibilityChange = () => {
      if (document.visibilityState === "visible" && !fastSessionSwitchAnyNetworkQuiet() && (loaded() || isProcessOpen())) {
        void fetchProcesses()
      }
    }
    document.addEventListener("visibilitychange", onVisibilityChange)

    onCleanup(() => {
      clearInterval(wakeTimer)
      document.removeEventListener("visibilitychange", onVisibilityChange)
    })

    // Clear the "crashed while closed" attention badge whenever the pane
    // becomes visible. The toggle() API resets this for explicit open paths,
    // but the workspace panel button (rail-layout) takes a different path,
    // so we watch isProcessOpen() directly.
    createEffect(() => {
      if (isProcessOpen()) {
        state.processPane.setCrashedWhileClosed(false)
      }
    })

    // ── Exported API ─────────────────────────────────────────────────

    const api = {
      ready: () => ready(),
      loaded,

      isOpen: isProcessOpen,
      toggle: () => {
        if (isProcessOpen()) {
          state.workspacePanel.close()
          return
        }
        requestProcessOpen()
        state.processPane.setCrashedWhileClosed(false)
      },

      configs: () => store.configs,

      paneHeight: () => Math.max(store.paneHeight, MIN_PANE_HEIGHT),
      setPaneHeight(height: number) {
        setStore("paneHeight", Math.max(height, MIN_PANE_HEIGHT))
      },

      canMutate: canMutateProcesses,

      hasRunning: () => {
        return anyRunning()
      },

      hasStopping: () => {
        return states().some((status) => status === "stopping")
      },

      hasCrashed: () => {
        return anyCrashed()
      },

      processForConfig(configId: string): ManagedProcess | undefined {
        return store.processes[configId]
      },

      resolveConflict(configId: string, strategy: Process.PortConflictStrategy) {
        if (!canMutateProcesses()) return
        const proc = store.processes[configId]
        if (!proc?.conflict) return
        void api.start(configId, { portConflict: strategy })
      },

      resolveRouteConflict(configId: string, strategy: Process.PortConflictStrategy) {
        if (!canMutateProcesses()) return
        const proc = store.processes[configId]
        if (!proc?.routeConflict) return
        void api.start(configId, { routeConflict: strategy })
      },

      async start(
        configId: string,
        opts?: { portConflict?: Process.PortConflictStrategy; routeConflict?: Process.PortConflictStrategy },
      ) {
        if (!canMutateProcesses()) return
        const portConflict = opts?.portConflict
        const routeConflict = opts?.routeConflict
        // Optimistic: mark as starting
        const existing = store.processes[configId]
        setStore("processes", configId, {
          ...(existing ?? { configId, restartCount: 0 }),
          configId,
          status: "starting" as ProcessStatus,
          exitCode: undefined,
          exitedAt: undefined,
          conflict: undefined,
          routeConflict: undefined,
          launchError: undefined,
        })
        sync()
        // Tell the terminal system a process PTY is coming — prevents the
        // detection effect from creating a tab for the pty.created SSE that
        // arrives before process.started registers ownership.
        ownership.expectProcessPty()
        try {
          const startOpts = portConflict || routeConflict
            ? { portConflict, routeConflict, interactive: true }
            : { interactive: true }
          const out = await run(() => client.start(configId, startOpts))
          const proc = out ? read(configId, out, existing) : restore(configId, existing)
          // Open the process panel so the user sees the terminal.
          if (proc?.ptyId && !isProcessOpen()) {
            requestProcessOpen()
          }
        } finally {
          ownership.resolveProcessPty()
        }
      },

      async stop(configId: string) {
        if (!canMutateProcesses()) return
        // Optimistic: clear ptyId immediately so the terminal unmounts
        // and mark as stopping. The server will confirm via process.stopped SSE.
        const existing = store.processes[configId]
        if (existing) {
          setStore("processes", configId, {
            ...existing,
            status: "stopping" as ProcessStatus,
            ptyId: undefined,
          })
          sync()
        }
        await run(() => client.stop(configId))
        // Belt-and-suspenders: the server's stop() waits for the PTY to exit,
        // so by the time the HTTP response arrives the process is definitely
        // stopped. Force the status in case the SSE event was missed.
        const current = store.processes[configId]
        if (current && current.status === "stopping") {
          setStore("processes", configId, {
            ...current,
            status: "stopped" as ProcessStatus,
          })
          sync()
        }
      },

      async restart(configId: string) {
        if (!canMutateProcesses()) return
        const existing = store.processes[configId]
        const alreadyStopped =
          !existing ||
          existing.status === "idle" ||
          existing.status === "stopped" ||
          existing.status === "crashed"

        ownership.expectProcessPty()
        try {
          if (alreadyStopped) {
            // Process is not running — just start it directly.
            // Calling the server's /restart endpoint would emit a "stopping"
            // SSE event (from the internal stop() call) that overwrites our
            // optimistic state, causing a brief "Stopping..." flash.
            setStore("processes", configId, {
              ...(existing ?? { configId, restartCount: 0 }),
              configId,
              status: "starting" as ProcessStatus,
              ptyId: undefined,
              exitCode: undefined,
              exitedAt: undefined,
              conflict: undefined,
              routeConflict: undefined,
              launchError: undefined,
            })
            sync()
            const out = await run(() => client.start(configId, { interactive: true }))
            const proc = out ? read(configId, out, existing) : restore(configId, existing)
            if (proc?.ptyId && !isProcessOpen()) {
              requestProcessOpen()
            }
            return
          }

          // Running process: mark as restarting and clear ptyId so the Terminal
          // unmounts — when the new PTY arrives, it'll remount fresh.
          const prev = existing
            ? {
                ...existing,
                ptyId: undefined,
              }
            : undefined
          setStore("processes", configId, {
            ...existing,
            status: "restarting" as ProcessStatus,
            ptyId: undefined,
          })
          sync()
          const out = await run(() => client.restart(configId))
          if (out) {
            read(configId, out, prev, "stopped" as ProcessStatus, false)
          } else {
            restore(configId, prev, "stopped" as ProcessStatus)
          }
        } finally {
          ownership.resolveProcessPty()
        }
      },

      async startAll() {
        if (!canMutateProcesses()) return
        // Start every config (not just autoStart — that's for server bootstrap)
        // Use interactive: true so port conflicts prompt the user instead of
        // silently picking a new port.
        ownership.expectProcessPty()
        try {
          for (const config of store.configs) {
            const existing = store.processes[config.id]
            if (existing && (existing.status === "running" || existing.status === "starting")) continue
            const out = await run(() => client.start(config.id, { interactive: true }))
            if (out) read(config.id, out, existing)
            else restore(config.id, existing)
          }
        } finally {
          ownership.resolveProcessPty()
        }
      },

      async stopAll() {
        if (!canMutateProcesses()) return
        // Force-recover any processes already stuck in "stopping" — no HTTP
        // needed; they're either already stopped server-side (SSE missed) or
        // the server is unreachable. This breaks the dead-lock where stopping
        // processes hide all buttons and stopAll's filter would skip them.
        batch(() => {
          for (const config of store.configs) {
            const proc = store.processes[config.id]
            if (proc && proc.status === "stopping") {
              setStore("processes", config.id, {
                ...proc,
                status: "stopped" as ProcessStatus,
                ptyId: undefined,
              })
            }
          }
        })
        sync()

        // Stop each running process individually with optimistic updates,
        // rather than a single /stop-all call that blocks sequentially.
        const toStop = store.configs.filter((config) => {
          const proc = store.processes[config.id]
          return proc && (proc.status === "running" || proc.status === "starting" || proc.status === "restarting")
        })
        // Optimistic: clear all ptyIds and mark as stopping immediately
        batch(() => {
          for (const config of toStop) {
            const existing = store.processes[config.id]
            if (existing) {
              setStore("processes", config.id, {
                ...existing,
                status: "stopping" as ProcessStatus,
                ptyId: undefined,
              })
            }
          }
        })
        sync()
        // Fire individual stop calls concurrently
        await Promise.all(toStop.map((config) => run(() => client.stop(config.id))))
        // Belt-and-suspenders: force any still-stopping processes to stopped.
        batch(() => {
          for (const config of toStop) {
            const current = store.processes[config.id]
            if (current && current.status === "stopping") {
              setStore("processes", config.id, {
                ...current,
                status: "stopped" as ProcessStatus,
              })
            }
          }
        })
        sync()
      },

      openInTab(configId: string) {
        const proc = store.processes[configId]
        if (proc?.ptyId) {
          // Process is running with a pty — open the tab immediately
          openTerminalTab(configId, proc.ptyId)
          return
        }
        // Start the process, read response to get ptyId, then open tab
        if (!canMutateProcesses()) return
        ownership.expectProcessPty()
        pendingTabOpens.add(configId)
        void (async () => {
          try {
            const out = await run(() => client.start(configId, { interactive: true }))
            const started = out ? read(configId, out, store.processes[configId]) : undefined
            if (started?.ptyId) {
              pendingTabOpens.delete(configId)
              openTerminalTab(configId, started.ptyId)
            } else if (!out || (out.kind !== "started" && out.kind !== "already_running")) {
              pendingTabOpens.delete(configId)
            }
          } finally {
            ownership.resolveProcessPty()
          }
        })()
      },

      refresh: fetchProcesses,
    }

    createEffect(
      on(
        () => state.processPane.pendingAction(),
        (action) => {
          if (!action) return
          state.processPane.clearPendingAction()

          switch (action) {
            case "startAll":
              if (canMutateProcesses()) void api.startAll()
              break
            case "stopAll":
              if (canMutateProcesses()) void api.stopAll()
              break
            case "add":
              if (!canMutateProcesses()) break
              void dialog.show(() => (
                <AddProcessDialog
                  directory={sdk.directory}
                  onDone={() => fetchProcesses()}
                />
              ))
              break
          }
        },
      ),
    )

    onCleanup(() => {
      queueMicrotask(() => {
        state.processPane.setRunning(sdk.directory, false)
        state.processPane.setCrashed(sdk.directory, false)
      })
    })

    return api
  },
}
const processPaneContext = createSimpleContext<ReturnType<typeof processPaneContextInput.init>, { surfaceId?: string }>(processPaneContextInput)

export function useProcessPane() {
  return processPaneContext.use()
}

export const ProcessPaneProvider = processPaneContext.provider
