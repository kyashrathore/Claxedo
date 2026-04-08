/**
 * ProcessStatusIndicator
 *
 * Compact status indicator for the workspace bar showing process state.
 * Lives at the app level (outside DirectoryScope) so it subscribes to SSE
 * events directly via useGlobalSDK().event.on() rather than using the
 * ProcessPaneProvider context.
 *
 * Shows:
 * - Green dot if any process is running
 * - Red dot (with pulse) if any process has crashed
 * - Gray/hidden if no configs exist
 * - Count badge: "3/5" (running/total)
 * - Click to toggle process pane
 */

import { createEffect, createMemo, on, onCleanup, Show } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { useGlobalSDK } from "@opencode-ai/claxedo-app"
import { usePlatform } from "@/context/platform"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import type { Process } from "@claxedo/process/process"

type ProcessConfig = Process.ProcessConfig
type ManagedProcess = Process.ManagedProcess
type ProcessStatus = Process.Status

type ProcessStatusStore = {
  configs: ProcessConfig[]
  processes: Record<string, ManagedProcess>
}

export type ProcessStatusIndicatorProps = {
  /** Active workspace directory — used to scope SSE events and API calls */
  directory: () => string | undefined
  /** Server URL for fetching process state */
  serverUrl: () => string | undefined
  /** Callback when indicator is clicked (toggle process pane) */
  onToggle: () => void
}

export function ProcessStatusIndicator(props: ProcessStatusIndicatorProps) {
  const globalSDK = useGlobalSDK()
  const platform = usePlatform()
  const fetchFn = platform.fetch ?? globalThis.fetch

  const [store, setStore] = createStore<ProcessStatusStore>({
    configs: [],
    processes: {},
  })

  // Fetch initial state when directory changes
  createEffect(
    on(
      () => [props.directory(), props.serverUrl()] as const,
      async ([dir, url]) => {
        if (!dir || !url) {
          setStore({ configs: [], processes: {} })
          return
        }

        try {
          const res = await fetchFn(`${url}/process`, {
            headers: {
              "Content-Type": "application/json",
              "x-opencode-directory": dir,
            },
          })
          if (!res.ok) return
          const data = (await res.json()) as {
            configs: ProcessConfig[]
            processes: ManagedProcess[]
          }
          const byId: Record<string, ManagedProcess> = {}
          for (const p of data.processes) {
            byId[p.configId] = p
          }
          setStore({ configs: data.configs, processes: byId })
        } catch {
          // Server may not support processes yet
        }
      },
    ),
  )

  // Subscribe to SSE events for process state changes
  createEffect(() => {
    const dir = props.directory()
    if (!dir) return

    const unsub = globalSDK.event.on(dir, (event: any) => {
      const type = event.type as string
      const ep = event.properties as Record<string, any> | undefined
      if (!ep) return

      switch (type) {
        case "process.started": {
          const configId = ep.configId as string
          setStore("processes", configId, {
            configId,
            ptyId: ep.ptyId as string,
            status: "running" as ProcessStatus,
            restartCount: store.processes[configId]?.restartCount ?? 0,
            startedAt: Date.now(),
            exitedAt: undefined,
            exitCode: undefined,
          })
          break
        }
        case "process.stopped": {
          const configId = ep.configId as string
          setStore(
            "processes",
            configId,
            produce((p: ManagedProcess) => {
              p.status = "stopped"
              p.exitCode = ep.exitCode as number
              p.exitedAt = Date.now()
            }),
          )
          break
        }
        case "process.crashed": {
          const configId = ep.configId as string
          setStore(
            "processes",
            configId,
            produce((p: ManagedProcess) => {
              p.status = "crashed"
              p.exitCode = ep.exitCode as number
              p.restartCount = ep.restartCount as number
              p.exitedAt = Date.now()
            }),
          )
          break
        }
        case "process.status": {
          const configId = ep.configId as string
          const status = ep.status as ProcessStatus
          if (!store.processes[configId]) {
            setStore("processes", configId, { configId, status, restartCount: 0 })
          } else {
            setStore(
              "processes",
              configId,
              produce((p: ManagedProcess) => {
                p.status = status
              }),
            )
          }
          break
        }
        case "process.config.changed": {
          const configs = ep.configs as ProcessConfig[]
          const configIds = new Set(configs.map((c) => c.id))
          setStore("configs", configs)
          const next: Record<string, ManagedProcess> = {}
          for (const id of Object.keys(store.processes)) {
            if (configIds.has(id)) next[id] = store.processes[id]!
          }
          setStore("processes", next)
          break
        }
      }
    })

    onCleanup(unsub)
  })

  const totalCount = createMemo(() => store.configs.length)

  const runningCount = createMemo(() => {
    return Object.values(store.processes).filter(
      (p) => p && (p.status === "running" || p.status === "starting" || p.status === "restarting"),
    ).length
  })

  const hasCrashed = createMemo(() => {
    return Object.values(store.processes).some((p) => p && p.status === "crashed")
  })

  const hasRunning = createMemo(() => runningCount() > 0)

  const statusColor = createMemo(() => {
    if (hasCrashed()) return "#ef4444" // red-500
    if (hasRunning()) return "#22c55e" // green-500
    return "#6b7280" // gray-500
  })

  const tooltipText = createMemo(() => {
    const total = totalCount()
    const running = runningCount()
    if (total === 0) return "No processes configured"
    if (hasCrashed()) return `Processes: ${running}/${total} running (some crashed)`
    return `Processes: ${running}/${total} running`
  })

  return (
    <Tooltip value={`${tooltipText()} (Cmd+Shift+P)`}>
      <button
        type="button"
        class="flex items-center gap-1.5 px-2 py-1 rounded-sm hover:bg-surface-base-hover transition-colors h-[24px]"
        onClick={props.onToggle}
        aria-label={tooltipText()}
      >
        {/* Status dot */}
        <span class="relative flex shrink-0" style={{ width: "8px", height: "8px" }}>
          <Show when={hasCrashed()}>
            <span
              class="absolute inline-flex rounded-full animate-ping"
              style={{
                width: "8px",
                height: "8px",
                "background-color": "#ef4444",
                opacity: 0.5,
              }}
            />
          </Show>
          <span
            class="relative inline-flex rounded-full"
            style={{
              width: "8px",
              height: "8px",
              "background-color": statusColor(),
            }}
          />
        </span>

        {/* Count badge: running/total — only show when there are configs */}
        <Show when={totalCount() > 0}>
          <span class="text-[11px] font-medium text-text-weak">
            {runningCount()}/{totalCount()}
          </span>
        </Show>
      </button>
    </Tooltip>
  )
}
