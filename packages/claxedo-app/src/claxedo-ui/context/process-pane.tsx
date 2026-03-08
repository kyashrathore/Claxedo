/**
 * ProcessPane Context Provider
 *
 * Manages the process pane UI state and acts as the bridge between the
 * server-side process management (HTTP routes + SSE events) and the
 * frontend reactive store.
 *
 * Lives inside DirectoryScope, outside GroupContentRenderer.
 */

import { batch, createEffect, createRenderEffect, createSignal, on, onCleanup, onMount } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { useSDK } from "@/context/sdk"
import { useGlobalSDK } from "@/context/global-sdk"
import { usePlatform } from "@/context/platform"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Persist, persisted } from "@/utils/persist"
import { useOptionalTerminal } from "@/context/terminal"
import type { Process } from "../../opencode-patches/process/process"
import { createProcessClient } from "../../opencode-patches/process/client"
import { useClaxedoLayout } from "./claxedo-layout"
import { createProcessOwnership, createTerminalTabOps } from "../stores/process-ownership"
import { AddProcessDialog } from "../components/add-process-dialog"
import { PortConflictDialog } from "../components/port-conflict-dialog"
import { createDebugLogger } from "../../overrides/utils/debug"

// ── Types ──────────────────────────────────────────────────────────────

type ProcessConfig = Process.ProcessConfig
type ManagedProcess = Process.ManagedProcess
type ProcessStatus = Process.Status
type LaunchResult = Process.LaunchResult

type ProcessPaneStore = {
  configs: ProcessConfig[]
  processes: Record<string, ManagedProcess>
  paneHeight: number
}

// ── Helpers ────────────────────────────────────────────────────────────

const DEFAULT_PANE_HEIGHT = 300
const MIN_PANE_HEIGHT = 100
const FETCH_TIMEOUT = 5_000
const POST_TIMEOUT = 10_000

// ── Context ────────────────────────────────────────────────────────────

export const { use: useProcessPane, provider: ProcessPaneProvider } = createSimpleContext({
  name: "ProcessPane",
  gate: false,
  init: (props: { tabId?: string }) => {
    const sdk = useSDK()
    const globalSDK = useGlobalSDK()
    const platform = usePlatform()
    const claxedo = useClaxedoLayout()
    const debug = createDebugLogger("layout.process", "layout:process", {
      legacyKey: "opencode.debug.terminal",
    })
    const inst = Math.random().toString(36).slice(2, 7)
    const seed = {
      tabId: props?.tabId ?? null,
      dir: sdk.directory,
    }
    const terminalCtx = useOptionalTerminal()
    const [loaded, setLoaded] = createSignal(false)

    // Create ownership + tab-ops adapters.  These delegate to the current
    // ClaxedoLayout terminal state.  When the global terminal store (T2) lands,
    // only the adapter factory needs to change — callers stay the same.
    const ownership = createProcessOwnership(claxedo as any)
    const tabOps = createTerminalTabOps(claxedo as any)

    const dialog = useDialog()

    // Persisted UI state (height — NOT visibility)
    const [store, setStore, , ready] = persisted(
      Persist.workspace(sdk.directory, "process-pane"),
      createStore<ProcessPaneStore>({
        configs: [],
        processes: {},
        paneHeight: DEFAULT_PANE_HEIGHT,
      }),
    )
    const sig = () =>
      Object.values(store.processes)
        .map((proc) => `${proc.configId}:${proc.status}:${proc.ptyId ?? "-"}`)
        .sort()
        .join("|")
    const snap = () => {
      const tabId = props?.tabId ?? null
      const groupId = tabId ? (claxedo.findTabGroup(tabId) ?? null) : null
      const group = groupId ? claxedo.groupTabs(groupId) : undefined
      const tab = tabId ? group?.items().find((item) => item.id === tabId) : undefined
      return {
        inst,
        seedTabId: seed.tabId,
        seedDir: seed.dir,
        dir: sdk.directory,
        tabId,
        groupId,
        hasTab: !!tab,
        tabType: tab?.type ?? null,
        activeId: group?.activeId() ?? null,
        ready: ready(),
        loaded: loaded(),
        configs: store.configs.length,
        procSig: sig(),
        leaves: tabId
          ? claxedo.select.multiPaneLeafView(tabId).map((leaf) => ({
              id: leaf.id,
              type: leaf.content?.type ?? null,
              processId: leaf.content?.type === "process" ? (leaf.content.processId ?? null) : null,
            }))
          : [],
      }
    }

    onMount(() => {
      debug.verbose("provider mount", snap())
    })
    createEffect(
      on(
        () => [sdk.directory, props?.tabId ?? "", claxedo.findTabGroup(props?.tabId ?? "") ?? null] as const,
        ([dir, tabId, groupId], prev) => {
          debug.verbose("provider anchor", {
            inst,
            prev: prev
              ? {
                  dir: prev[0] || null,
                  tabId: prev[1] || null,
                  groupId: prev[2],
                }
              : null,
            next: {
              dir: dir || null,
              tabId: tabId || null,
              groupId,
            },
          })
        },
        { defer: true },
      ),
    )

    // Process tab visibility: the process tab is "open" when it's the active tab.
    // We no longer need a signal — the tab active state handles it.

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

    const sync = () => {
      claxedo.processPane.setRunning(sdk.directory, anyRunning())
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
      baseUrl: sdk.url,
      directory: sdk.directory,
      fetch,
    })

    // ── HTTP helpers ─────────────────────────────────────────────────

    async function fetchProcesses(): Promise<boolean> {
      try {
        debug.verbose("fetch start", {
          dir: sdk.directory,
          tabId: props?.tabId,
          persistedReady: ready(),
          loaded: loaded(),
        })
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

        debug.log("fetch ok", {
          dir: sdk.directory,
          tabId: props?.tabId,
          configs: data.configs.length,
          processes: data.processes.length,
        })
        return true
      } catch (e) {
        debug.log("fetch error", {
          dir: sdk.directory,
          tabId: props?.tabId,
          error: e instanceof Error ? e.message : String(e),
        })
        console.error("[process-pane] Failed to fetch processes", e)
        return false
      }
    }

    async function run<T>(label: string, task: () => Promise<T>) {
      try {
        return await task()
      } catch (e) {
        console.error(`[process-pane] ${label} failed`, e)
        return undefined
      }
    }

    /** Update a single process entry in the store from a server response. */
    function applyProcess(proc: ManagedProcess | undefined) {
      if (!proc) return
      setStore("processes", proc.configId, proc)
      // Mark the PTY as process-owned so the terminal detection effect
      // skips it (existing `owner` check) and the close effect won't kill it.
      if (proc.ptyId) {
        ownership.ownProcess(proc.configId, proc.ptyId)
        tabOps.removeAutoCreatedTab(proc.ptyId)
      }
      sync()
    }

    function restore(configId: string, proc?: ManagedProcess, status?: ProcessStatus) {
      if (proc) {
        setStore("processes", configId, {
          ...proc,
          status: status ?? proc.status,
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
      })
      sync()
    }

    function show(configId: string, conflict: Process.PortConflictInfo, proc?: ManagedProcess) {
      restore(configId, proc)
      dialog.show(() => (
        <PortConflictDialog
          conflict={conflict}
          configId={configId}
          onResolve={(strategy) => {
            dialog.close()
            void api.start(configId, strategy)
          }}
          onCancel={() => dialog.close()}
        />
      ))
    }

    function read(
      configId: string,
      out: LaunchResult,
      proc?: ManagedProcess,
      status?: ProcessStatus,
      prompt = true,
    ) {
      if (out.kind === "started" || out.kind === "already_running") {
        applyProcess(out.process)
        return out.process
      }
      if (out.kind === "port_conflict") {
        if (prompt) {
          show(configId, out.conflict, proc)
          return
        }
        restore(configId, proc, status)
        return
      }
      if (out.kind === "failed") {
        if (out.process) {
          applyProcess(out.process)
          return out.process
        }
        restore(configId, proc, status)
        return
      }
      restore(configId, proc, status)
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

    createRenderEffect(() => {
      const dir = sdk.directory
      if (!dir) return

      const unsub = globalSDK.event.on(dir, (event: any) => {
        const type = event.type as string
        const props = event.properties as Record<string, any> | undefined
        if (!props) return

        switch (type) {
          case "process.started": {
            const configId = props.configId as string
            const ptyId = props.ptyId as string
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
            break
          }

          case "process.stopped": {
            const configId = props.configId as string
            const exitCode = props.exitCode as number
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
            break
          }

          case "process.crashed": {
            // Fires when the PTY itself dies OR when the inner command exits
            // inside the interactive shell (detected via OSC process-exit marker).
            // Preserve existing ptyId via spread, and also accept ptyId from the
            // event itself (command-exit crashes include it) so even if the client
            // store was cleared (e.g. during mount), the ptyId is recovered.
            const configId = props.configId as string
            const exitCode = props.exitCode as number
            const restartCount = props.restartCount as number
            const eventPtyId = props.ptyId as string | undefined
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
            // Alert workspace dot indicator when process tab is not active
            if (!claxedo.processPane.isActive()) {
              claxedo.processPane.setCrashedWhileClosed(true)
            }
            break
          }

          case "process.status": {
            const configId = props.configId as string
            const status = props.status as ProcessStatus
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
              break
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
            break
          }

          case "process.config.changed": {
            const configs = props.configs as ProcessConfig[]
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
                    status: "idle" as ProcessStatus,
                    restartCount: 0,
                  }
                }
              }
              setStore("processes", reconcile(next))
            })
            break
          }
        }
        sync()
      })

      onCleanup(unsub)
    })

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

      const tabId = tabOps.addTerminalTab(dir, ptyId, title)
      if (tabId) tabOps.setActiveTab(tabId)
    }

    // ── Initial fetch ────────────────────────────────────────────────

    // Reset stale runtime state from localStorage — the server is the
    // source of truth. After system sleep the persisted processes may
    // be stuck in "stopping"/"running" with dead ptyIds, causing
    // hasStopping() to disable Start All permanently if the fetch fails.
    setStore("processes", {})
    sync()

    // The terminal detection counter starts at 1 (set in terminal.ts) to
    // block tab creation until this provider resolves. We keep that initial
    // count active during the fetch window and resolve it when done.
    // For additional start/restart actions we use expect/resolve pairs.

    // Retry on init: gateway may still be waking up after system sleep.
    // 3 attempts with exponential backoff (1s, 2s, 4s).
    void (async () => {
      let ok = false
      try {
        for (let attempt = 0; attempt < 3; attempt++) {
          ok = await fetchProcesses()
          if (ok) return
          await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, attempt)))
        }
      } finally {
        setLoaded(true)
        debug.log("boot settled", {
          dir: sdk.directory,
          tabId: props?.tabId,
          ok,
          configs: store.configs.length,
          processes: Object.keys(store.processes).length,
          persistedReady: ready(),
        })
        ownership.resolveInitialProcessPty()
      }
    })()

    // ── Deferred stale tab cleanup ────────────────────────────────────
    // On desktop (Tauri), the ClaxedoLayout store uses async persistence.
    // The terminalOwner map and groups (with tabs) may hydrate AFTER
    // fetchProcesses has already run. This deferred effect catches that:
    // when the ClaxedoLayout store becomes ready, re-run the stale cleanup
    // with the ptyIds from the last successful fetch.
    createRenderEffect(
      on(
        () => claxedo.ready(),
        (isReady) => {
          if (!isReady) return
          if (lastFetchedPtyIds.size === 0) return
          cleanupStaleProcessTabs(lastFetchedPtyIds)
        },
      ),
    )

    // ── Wake detection ──────────────────────────────────────────────

    // Detect system sleep via setInterval time-gap (works in both web
    // and Tauri). Add visibilitychange as fast-path for browser tab switching.
    let lastTick = Date.now()
    const TICK_INTERVAL = 10_000 // check every 10s
    const SLEEP_THRESHOLD = 30_000 // >30s gap = sleep detected

    const wakeTimer = setInterval(() => {
      const now = Date.now()
      const gap = now - lastTick
      lastTick = now
      if (gap > SLEEP_THRESHOLD) {
        void fetchProcesses()
      }
    }, TICK_INTERVAL)

    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void fetchProcesses()
      }
    }
    document.addEventListener("visibilitychange", onVisibilityChange)

    onCleanup(() => {
      clearInterval(wakeTimer)
      document.removeEventListener("visibilitychange", onVisibilityChange)
    })

    // ── Dynamic leaf sync ─────────────────────────────────────────────
    // Watch configs and sync multi-pane leaves to match.
    // Each process config gets its own leaf in the process tab's multi-pane tree.

    const findProcessTabId = (): string | undefined => {
      const tabId = props?.tabId
      if (!tabId) return undefined
      const groupId = claxedo.findTabGroup(tabId)
      if (!groupId) return undefined
      const tab = claxedo.groupTabs(groupId).items().find((item) => item.id === tabId)
      if (!tab || tab.type !== "process") return undefined
      return tabId
    }

    createEffect(
      on(
        () => {
          const tabId = findProcessTabId()
          const configSig = store.configs.map((c) => `${c.id}:${c.name}`).join("|")
          const leafSig = tabId
            ? claxedo.select.multiPaneLeafView(tabId).map((leaf) => {
                const content = leaf.content
                if (!content || content.type !== "process") return `${leaf.id}:`
                return `${leaf.id}:${content.processId ?? ""}:${content.title ?? ""}:${content.directory ?? ""}`
              }).join("|")
            : ""
          return [tabId, sdk.directory, configSig, leafSig, loaded()] as const
        },
        ([tabId, dir, _configSig, _leafSig, isLoaded]) => {
          if (!tabId) return
          if (!isLoaded && store.configs.length === 0) return

          const configEntries = store.configs.map((c) => ({ id: c.id, name: c.name }))
          const leaves = claxedo.select.multiPaneLeafView(tabId)

          debug.verbose("leaf sync", {
            tabId,
            dir,
            loaded: isLoaded,
            configs: configEntries.map((c) => c.id),
            leaves: leaves.map((leaf) => ({
              id: leaf.id,
              type: leaf.content?.type,
              processId: leaf.content?.type === "process" ? leaf.content.processId ?? null : null,
            })),
          })

          // Build maps: processId → leafId, leafId → processId
          const processIdToLeaf = new Map<string, string>()
          const leafToProcessId = new Map<string, string>()
          let placeholderLeafId: string | undefined

          for (const leaf of leaves) {
            const content = leaf.content
            if (!content || content.type !== "process") continue
            if (content.processId) {
              processIdToLeaf.set(content.processId, leaf.id)
              leafToProcessId.set(leaf.id, content.processId)
              continue
            }
            placeholderLeafId = leaf.id
          }

          const configIds = new Set(configEntries.map((c) => c.id))

          batch(() => {
            // Handle first load: replace placeholder with first config
            if (placeholderLeafId && configEntries.length > 0) {
              const first = configEntries[0]
              claxedo.multiPane.setContent(tabId, placeholderLeafId, {
                type: "process",
                directory: dir,
                processId: first.id,
                title: first.name,
              })
              debug.log("leaf placeholder promoted", {
                tabId,
                dir,
                leafId: placeholderLeafId,
                processId: first.id,
              })
              processIdToLeaf.set(first.id, placeholderLeafId)
              leafToProcessId.set(placeholderLeafId, first.id)
              placeholderLeafId = undefined
            }

            // Add new configs
            for (const config of configEntries) {
              if (processIdToLeaf.has(config.id)) continue
              const existingLeafId = processIdToLeaf.values().next().value ?? placeholderLeafId
              if (!existingLeafId) {
                claxedo.multiPane.initTabWithContent(tabId, {
                  type: "process",
                  directory: dir,
                  processId: config.id,
                  title: config.name,
                })
                debug.log("leaf sync reinit", {
                  tabId,
                  dir,
                  processId: config.id,
                })
                return
              }
              const newLeafId = claxedo.multiPane.splitLeaf(tabId, "v", existingLeafId, {
                type: "process",
                directory: dir,
                processId: config.id,
                title: config.name,
              })
              if (!newLeafId) continue
              debug.log("leaf added", {
                tabId,
                dir,
                leafId: newLeafId,
                processId: config.id,
              })
              processIdToLeaf.set(config.id, newLeafId)
            }

            // Remove leaves for deleted configs
            for (const [leafId, processId] of leafToProcessId) {
              if (configIds.has(processId)) continue
              claxedo.multiPane.closeLeaf(tabId, leafId)
              debug.log("leaf removed", {
                tabId,
                dir,
                leafId,
                processId,
              })
            }

            // Update titles for existing leaves
            for (const config of configEntries) {
              const leafId = processIdToLeaf.get(config.id)
              if (!leafId) continue
              const leaf = leaves.find((l) => l.id === leafId)
              if (!leaf?.content || leaf.content.title === config.name) continue
              claxedo.multiPane.setContent(tabId, leafId, {
                ...leaf.content,
                title: config.name,
              })
            }
          })
        },
        { defer: true },
      ),
    )

    // ── Exported API ─────────────────────────────────────────────────

    const api = {
      ready: () => ready(),
      loaded,

      // Convenience wrappers — delegates to claxedo layout's tab-based process pane state
      isOpen: () => claxedo.processPane.isActive(),
      toggle: () => {
        claxedo.processPane.requestToggle()
        // Clear the crash indicator when the pane opens
        if (claxedo.processPane.isActive()) {
          claxedo.processPane.setCrashedWhileClosed(false)
        }
      },

      // Config accessors
      configs: () => store.configs,

      // Pane sizing (no longer drives height — tab fills available space)
      paneHeight: () => Math.max(store.paneHeight, MIN_PANE_HEIGHT),
      setPaneHeight(height: number) {
        setStore("paneHeight", Math.max(height, MIN_PANE_HEIGHT))
      },

      // Derived state
      hasRunning: () => {
        return anyRunning()
      },

      hasStopping: () => {
        return states().some((status) => status === "stopping")
      },

      hasCrashed: () => {
        return states().some((status) => status === "crashed")
      },

      processForConfig(configId: string): ManagedProcess | undefined {
        return store.processes[configId]
      },

      // Lifecycle actions — read HTTP responses so we don't depend solely on SSE
      async start(configId: string, portConflict?: Process.PortConflictStrategy) {
        // Optimistic: mark as starting
        const existing = store.processes[configId]
        setStore("processes", configId, {
          ...(existing ?? { configId, restartCount: 0 }),
          configId,
          status: "starting" as ProcessStatus,
          exitCode: undefined,
          exitedAt: undefined,
        })
        sync()
        // Tell the terminal system a process PTY is coming — prevents the
        // detection effect from creating a tab for the pty.created SSE that
        // arrives before process.started registers ownership.
        ownership.expectProcessPty()
        try {
          const out = await run(
            `start ${configId}`,
            () =>
              client.start(
                configId,
                portConflict ? { portConflict } : { interactive: true },
              ),
          )
          const proc = out ? read(configId, out, existing) : restore(configId, existing)
          // Auto-activate the process tab so the user sees the terminal
          if (proc?.ptyId && !claxedo.processPane.isActive()) {
            claxedo.processPane.requestOpen()
          }
        } finally {
          ownership.resolveProcessPty()
        }
      },

      async stop(configId: string) {
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
        await run(`stop ${configId}`, () => client.stop(configId))
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
            })
            sync()
            const out = await run(`restart ${configId}`, () => client.start(configId, { interactive: true }))
            const proc = out ? read(configId, out, existing) : restore(configId, existing)
            if (proc?.ptyId && !claxedo.processPane.isActive()) {
              claxedo.processPane.requestOpen()
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
          const out = await run(`restart ${configId}`, () => client.restart(configId))
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
        // Start every config (not just autoStart — that's for server bootstrap)
        // Use pick-new for batch start — don't prompt per process
        ownership.expectProcessPty()
        try {
          for (const config of store.configs) {
            const existing = store.processes[config.id]
            if (existing && (existing.status === "running" || existing.status === "starting")) continue
            const out = await run(`start ${config.id}`, () => client.start(config.id, { interactive: false }))
            if (out) read(config.id, out, existing, undefined, false)
            else restore(config.id, existing)
          }
        } finally {
          ownership.resolveProcessPty()
        }
      },

      async stopAll() {
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
        await Promise.all(toStop.map((config) => run(`stop ${config.id}`, () => client.stop(config.id))))
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

      // Tab integration
      openInTab(configId: string) {
        const proc = store.processes[configId]
        if (proc?.ptyId) {
          // Process is running with a pty — open the tab immediately
          openTerminalTab(configId, proc.ptyId)
          return
        }
        // Start the process, read response to get ptyId, then open tab
        ownership.expectProcessPty()
        pendingTabOpens.add(configId)
        void (async () => {
          try {
            const out = await run(`open ${configId}`, () => client.start(configId, { interactive: true }))
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

      // Refresh from server
      refresh: fetchProcesses,
    }

    // ── Action bridge ────────────────────────────────────────────────
    // Consume pending actions from the tab bar buttons.
    createEffect(
      on(
        () => claxedo.processPane.pendingAction(),
        (action) => {
          if (!action) return
          claxedo.processPane.clearPendingAction()

          switch (action) {
            case "startAll":
              void api.startAll()
              break
            case "stopAll":
              void api.stopAll()
              break
            case "add":
              dialog.show(() => (
                <AddProcessDialog
                  onDone={() => fetchProcesses()}
                />
              ))
              break
          }
        },
      ),
    )

    createEffect(
      on(
        () => [props?.tabId ?? "", loaded(), ready(), store.configs.length, sig()] as const,
        () => {
          debug.verbose("provider state", snap())
        },
        { defer: true },
      ),
    )

    onCleanup(() => {
      debug.log("provider cleanup", snap())
      queueMicrotask(() => {
        claxedo.processPane.setRunning(sdk.directory, false)
        debug.verbose("provider cleanup settled", snap())
      })
    })

    return api
  },
})
