import { storePath } from "solid-js"
import { createEffect } from "solid-js"
import { createSignal, onCleanup } from "solid-js"
import { createStore, flush, reconcile } from "solid-js"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Persist, persisted } from "@/platform/persistence/persist"
import { Process } from "@/features/processes/data"
import { createProcessClient } from "@/features/processes/data"
import { resolveWorkspaceRuntime } from "@/platform/runtime/workspace-runtime-record"
import { getClaxedoServerUrl } from "@/platform/api/api"
import type { ProcessOwnershipAPI, TerminalTabOps } from "./process-ownership"
import { createProcessPaneSync, isStaleProcessSnapshot } from "./process-pane-status"
import { createProcessEventHandlers, type ProcessPaneStore } from "./process-pane-events"
import { staleProcessTerminalIds } from "./process-pane-cleanup"
import { afterVisibleWork, createWakeDetector } from "./process-pane-scheduling"
import { AddProcessDialog } from "@/features/processes/ui"
import { fastSessionSwitchAnyNetworkQuiet } from "@/platform/runtime/session-switch"
import type { ProcessPaneSliceApi } from "@/features/processes/state/process-pane-slice"

type ProcessConfig = Process.ProcessConfig
type ManagedProcess = Process.ManagedProcess
type ProcessStatus = Process.Status
type LaunchResult = Process.LaunchResult

const DEFAULT_PANE_HEIGHT = 300
const MIN_PANE_HEIGHT = 100
const FETCH_TIMEOUT = 5_000
const POST_TIMEOUT = 10_000

type ProcessDirectory = string
type ProcessEventHandlers = ReturnType<typeof createProcessEventHandlers>

export type ProcessPaneSubscriptions = {
  started: (handler: ProcessEventHandlers["started"]) => VoidFunction
  stopped: (handler: ProcessEventHandlers["stopped"]) => VoidFunction
  crashed: (handler: ProcessEventHandlers["crashed"]) => VoidFunction
  status: (handler: ProcessEventHandlers["status"]) => VoidFunction
  configChanged: (handler: ProcessEventHandlers["configChanged"]) => VoidFunction
}

export type ProcessPaneProviderProps = {
  directory: ProcessDirectory
  workspaceId?: string
  request?: typeof fetch
  hostReady: () => boolean
  isOpen: () => boolean
  open: () => void
  close: () => void
  canMutate: () => boolean
  processPane: ProcessPaneSliceApi
  ownership: ProcessOwnershipAPI
  terminalTabs: TerminalTabOps
  removeStaleTerminals?: (terminalIds: Set<string>) => void
  subscriptions?: ProcessPaneSubscriptions
}

const processPaneContextInput = {
  name: "ProcessPane",
  gate: false,
  init: (props: ProcessPaneProviderProps) => {
    const claxedoServerUrl = getClaxedoServerUrl()
    const [loaded, setLoaded] = createSignal(false)

    const ownership = props.ownership
    const tabOps = props.terminalTabs
    let initialProcessPtyResolved = false
    const resolveInitialProcessPty = () => {
      if (initialProcessPtyResolved) return
      initialProcessPtyResolved = true
      ownership.resolveInitialProcessPty()
    }

    const dialog = useDialog()

    // Persisted UI state (height — NOT visibility)
    const [store, setStore, , ready] = persisted(
      Persist.scoped(props.directory, undefined, "process-pane"),
      createStore<ProcessPaneStore>({
        configs: [],
        processes: {},
        paneHeight: DEFAULT_PANE_HEIGHT,
      }),
    )
    const isProcessOpen = props.isOpen
    const requestProcessOpen = props.open
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

    const canMutateProcesses = props.canMutate

    const sync = createProcessPaneSync({
      // Drain first: callers sync() right after a store write, and Solid 2 stages
      // writes, so a plain read reconciles the flags from the previous process map
      // and a crash that just landed never lights the attention dot.
      processes: () => (flush(), store.processes),
      directory: () => props.directory,
      isProcessOpen,
      setRunning: props.processPane.setRunning,
      setCrashed: props.processPane.setCrashed,
      setCrashedWhileClosed: props.processPane.setCrashedWhileClosed,
    })

    const native = props.request ?? globalThis.fetch

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
      directory: props.directory,
      workspaceId: props.workspaceId,
      fetch,
      resolveWorkspaceRuntime: (input) =>
        resolveWorkspaceRuntime({
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

        void (() => {
          setStore(($store) => {
            reconcile(data.configs)($store.configs)
          })

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
          setStore(($store) => {
            reconcile(byId)($store.processes)
          })

          // Restore client-preserved ptyIds for crashed processes where the
          // server returned undefined (PTY-death crash clears ptyId server-side).
          for (const [configId, ptyId] of crashedPtyIds) {
            const proc = store.processes[configId]
            if (proc && proc.status === "crashed" && !proc.ptyId) {
              setStore(storePath("processes", configId, "ptyId", ptyId))
              ownership.ownProcess(configId, ptyId)
            }
          }
        })()
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
      // Guard against a stale HTTP-response snapshot clobbering a newer
      // crashed/stopped state already applied from an SSE event — see
      // isStaleProcessSnapshot above (BUG B).
      if (isStaleProcessSnapshot(store.processes[proc.configId], proc)) return
      setStore(
        storePath("processes", proc.configId, {
          ...proc,
          conflict: undefined,
          routeConflict: undefined,
          launchError: undefined,
        }),
      )
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
        setStore(
          storePath("processes", configId, {
            ...proc,
            status: settledStatus(proc, status),
            conflict: undefined,
            routeConflict: undefined,
            launchError: undefined,
          }),
        )
        sync()
        return
      }
      setStore(
        storePath("processes", configId, {
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
        }),
      )
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
      setStore(
        storePath("processes", configId, {
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
        }),
      )
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
      const stale = staleProcessTerminalIds(ownership.processOwnedPtyIds(), currentPtyIds)
      if (stale.size > 0) {
        props.removeStaleTerminals?.(stale)
      }
      tabOps.removeTerminalTabsByPtyIds(stale)
    }

    // Set of current process PTY IDs — updated by fetchProcesses, used by
    // the deferred effect to re-clean when ClaxedoLayout persistence loads late.
    let lastFetchedPtyIds = new Set<string>()

    // ── Tab integration ──────────────────────────────────────────────

    // Track configIds that should be opened in a tab once their ptyId
    // becomes available (i.e. after starting a stopped process).
    const pendingTabOpens = new Set<string>()

    function openTerminalTab(configId: string, ptyId: string) {
      const config = store.configs.find((c) => c.id === configId)
      const title = config?.name ?? "Process"
      const dir = props.directory
      if (!dir) return

      // Release process ownership so the tab system manages this PTY normally.
      ownership.disownProcess(ptyId)

      const surfaceId = tabOps.addTerminalTab(dir, ptyId, title)
      if (surfaceId) tabOps.setActiveTab(surfaceId)
    }

    // ── SSE event subscription ───────────────────────────────────────
    // Process events come from claxedo-server via claxedoBus (flat structure).
    // Subscribe via ClaxedoEventsProvider; fall back silently if unavailable.
    // Subscribed here (after openTerminalTab/pendingTabOpens are defined) so
    // the handler factory can close over them.
    if (props.subscriptions) {
      const handlers = createProcessEventHandlers({
        store,
        setStore,
        ownProcess: ownership.ownProcess,
        removeAutoCreatedTab: tabOps.removeAutoCreatedTab,
        sync,
        isProcessOpen,
        setCrashedWhileClosed: props.processPane.setCrashedWhileClosed,
        fetchProcesses: () => void fetchProcesses(),
        pendingTabOpens,
        openTerminalTab,
      })
      onCleanup(props.subscriptions.started(handlers.started))
      onCleanup(props.subscriptions.stopped(handlers.stopped))
      onCleanup(props.subscriptions.crashed(handlers.crashed))
      onCleanup(props.subscriptions.status(handlers.status))
      onCleanup(props.subscriptions.configChanged(handlers.configChanged))
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

    createEffect(isProcessOpen, (open) => {
      if (!open) resolveInitialProcessPty()
    })

    // hydrateProcesses writes loaded(), which the single-scope form also read.
    createEffect(
      () => isProcessOpen() && !loaded(),
      (hydrate) => (hydrate ? afterVisibleWork(() => void hydrateProcesses()) : undefined),
    )

    // ── Deferred stale tab cleanup ────────────────────────────────────
    // On desktop, the ClaxedoLayout store uses async persistence.
    // The terminalOwner map and groups (with tabs) may hydrate AFTER
    // fetchProcesses has already run. This deferred effect catches that:
    // when the ClaxedoLayout store becomes ready, re-run the stale cleanup
    // with the ptyIds from the last successful fetch.
    // Only host readiness re-triggers: cleanupStaleProcessTabs reads the terminal state it removes from.
    createEffect(
      () => props.hostReady(),
      (ready) => {
        if (!ready || lastFetchedPtyIds.size === 0) return
        cleanupStaleProcessTabs(lastFetchedPtyIds)
      },
    )

    // ── Wake detection ──────────────────────────────────────────────
    // Detect system sleep (interval time-gap) plus a visibilitychange
    // fast-path, and re-reconcile on wake (unless a fast session switch is
    // suppressing network, and only once the pane has loaded or is open).
    onCleanup(
      createWakeDetector({
        onWake: () => void fetchProcesses(),
        shouldReconcile: () => !fastSessionSwitchAnyNetworkQuiet() && (loaded() || isProcessOpen()),
      }),
    )

    // Keep the persisted badge aligned with what the user can currently see.
    // The toggle API covers explicit opens, but the workspace-panel navigator
    // takes a different path. Closing that navigator while a reconciled crash
    // remains must raise attention; opening it acknowledges and clears it.
    createEffect(
      () => (isProcessOpen() ? "open" : anyCrashed() ? "crashed" : "quiet"),
      (phase) => {
        // Several process providers can be mounted for one workspace (the review
        // surface and the navigator). Only a provider holding a real crash may
        // raise this shared flag; an empty sibling must not erase it.
        if (phase !== "quiet") props.processPane.setCrashedWhileClosed(phase === "crashed")
      },
    )

    // ── Exported API ─────────────────────────────────────────────────

    const api = {
      ready: () => ready(),
      loaded,

      isOpen: isProcessOpen,
      toggle: () => {
        if (isProcessOpen()) {
          props.close()
          return
        }
        requestProcessOpen()
        props.processPane.setCrashedWhileClosed(false)
      },

      configs: () => store.configs,

      paneHeight: () => Math.max(store.paneHeight, MIN_PANE_HEIGHT),
      setPaneHeight(height: number) {
        setStore(storePath("paneHeight", Math.max(height, MIN_PANE_HEIGHT)))
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
        setStore(
          storePath("processes", configId, {
            ...(existing ?? { configId, restartCount: 0 }),
            configId,
            status: "starting" as ProcessStatus,
            exitCode: undefined,
            exitedAt: undefined,
            conflict: undefined,
            routeConflict: undefined,
            launchError: undefined,
          }),
        )
        sync()
        // Tell the terminal system a process PTY is coming — prevents the
        // detection effect from creating a tab for the pty.created SSE that
        // arrives before process.started registers ownership.
        ownership.expectProcessPty()
        try {
          const startOpts =
            portConflict || routeConflict ? { portConflict, routeConflict, interactive: true } : { interactive: true }
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
          setStore(
            storePath("processes", configId, {
              ...existing,
              status: "stopping" as ProcessStatus,
              ptyId: undefined,
            }),
          )
          sync()
        }
        await run(() => client.stop(configId))
        // Belt-and-suspenders: the server's stop() waits for the PTY to exit,
        // so by the time the HTTP response arrives the process is definitely
        // stopped. Force the status in case the SSE event was missed.
        const current = store.processes[configId]
        if (current && current.status === "stopping") {
          setStore(
            storePath("processes", configId, {
              ...current,
              status: "stopped" as ProcessStatus,
            }),
          )
          sync()
        }
      },

      async restart(configId: string) {
        if (!canMutateProcesses()) return
        const existing = store.processes[configId]
        const alreadyStopped =
          !existing || existing.status === "idle" || existing.status === "stopped" || existing.status === "crashed"

        ownership.expectProcessPty()
        try {
          if (alreadyStopped) {
            // Process is not running — just start it directly.
            // Calling the server's /restart endpoint would emit a "stopping"
            // SSE event (from the internal stop() call) that overwrites our
            // optimistic state, causing a brief "Stopping..." flash.
            setStore(
              storePath("processes", configId, {
                ...(existing ?? { configId, restartCount: 0 }),
                configId,
                status: "starting" as ProcessStatus,
                ptyId: undefined,
                exitCode: undefined,
                exitedAt: undefined,
                conflict: undefined,
                routeConflict: undefined,
                launchError: undefined,
              }),
            )
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
          setStore(
            storePath("processes", configId, {
              ...existing,
              status: "restarting" as ProcessStatus,
              ptyId: undefined,
            }),
          )
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
        for (const config of store.configs) {
          const proc = store.processes[config.id]
          if (proc && proc.status === "stopping") {
            setStore(
              storePath("processes", config.id, {
                ...proc,
                status: "stopped" as ProcessStatus,
                ptyId: undefined,
              }),
            )
          }
        }
        sync()

        // Stop each running process individually with optimistic updates,
        // rather than a single /stop-all call that blocks sequentially.
        const toStop = store.configs.filter((config) => {
          const proc = store.processes[config.id]
          return proc && (proc.status === "running" || proc.status === "starting" || proc.status === "restarting")
        })
        // Optimistic: clear all ptyIds and mark as stopping immediately
        for (const config of toStop) {
          const existing = store.processes[config.id]
          if (existing) {
            setStore(
              storePath("processes", config.id, {
                ...existing,
                status: "stopping" as ProcessStatus,
                ptyId: undefined,
              }),
            )
          }
        }
        sync()
        // Fire individual stop calls concurrently
        await Promise.all(toStop.map((config) => run(() => client.stop(config.id))))
        // Belt-and-suspenders: force any still-stopping processes to stopped.
        for (const config of toStop) {
          const current = store.processes[config.id]
          if (current && current.status === "stopping") {
            setStore(
              storePath("processes", config.id, {
                ...current,
                status: "stopped" as ProcessStatus,
              }),
            )
          }
        }
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
      () => props.processPane.pendingAction(),
      (action) => {
        if (!action) return
        props.processPane.clearPendingAction()

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
              <AddProcessDialog directory={props.directory} request={native} onDone={() => fetchProcesses()} />
            ))
            break
        }
      },
    )

    onCleanup(() => {
      queueMicrotask(() => {
        props.processPane.setRunning(props.directory, false)
        // Do NOT reset `crashed` here. A crashed process must keep lighting the
        // toolbar attention dot after this provider unmounts (navigation away,
        // or a second same-directory provider instance tearing down). Clearing
        // it unconditionally clobbered the crash indicator — the transient flag
        // is re-derived by sync() when a provider remounts and reconciles.
      })
    })

    return api
  },
}
const processPaneContext = createSimpleContext<
  ReturnType<typeof processPaneContextInput.init>,
  ProcessPaneProviderProps
>(processPaneContextInput)
export function useProcessPane() {
  return processPaneContext.use()
}

export const ProcessPaneProvider = processPaneContext.provider
