/**
 * ProcessPanePanel
 *
 * Individual process panel within the process pane strip.
 * Shows a title bar with process name, status dot, and controls,
 * plus a terminal area connected to the process's PTY via WebSocket.
 *
 * IMPORTANT: Never unmount terminal instances — use CSS hidden class
 * for visibility toggling to avoid expensive remounts.
 */

import { Show, createMemo } from "solid-js"
import { Terminal } from "@/components/terminal"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import type { LocalPTY } from "@/context/terminal"
import type { Process } from "../../opencode-patches/process/process"

type ProcessStatus = Process.Status

export type ProcessPanePanelProps = {
  config: Process.ProcessConfig
  process: Process.ManagedProcess | undefined
  /** Whether this panel is the last one (no right-edge drag handle) */
  isLast: boolean
  onStart: () => void
  onStop: () => void
  onRestart: () => void
  /** Open the edit dialog for this process config */
  onEdit?: () => void
  /** Right-edge resize handle callback */
  onResizeStart?: (event: PointerEvent) => void
}

const STATUS_COLORS: Record<ProcessStatus, string> = {
  idle: "#6b7280",      // gray-500
  starting: "#22c55e",  // green-500
  running: "#22c55e",   // green-500
  stopping: "#6b7280",  // gray-500
  stopped: "#6b7280",   // gray-500
  crashed: "#ef4444",   // red-500
  restarting: "#22c55e", // green-500
}

const STATUS_LABELS: Record<ProcessStatus, string> = {
  idle: "Idle",
  starting: "Starting",
  running: "Running",
  stopping: "Stopping",
  stopped: "Stopped",
  crashed: "Crashed",
  restarting: "Restarting",
}

function StatusDot(props: { status: ProcessStatus }) {
  const color = () => STATUS_COLORS[props.status] ?? "#6b7280"
  const isPulsing = () => props.status === "running" || props.status === "restarting" || props.status === "starting"

  return (
    <Tooltip value={STATUS_LABELS[props.status] ?? props.status}>
      <span class="relative flex shrink-0" style={{ width: "8px", height: "8px" }}>
        <Show when={isPulsing()}>
          <span
            class="absolute inline-flex rounded-full animate-ping"
            style={{
              width: "8px",
              height: "8px",
              "background-color": color(),
              opacity: 0.4,
            }}
          />
        </Show>
        <span
          class="relative inline-flex rounded-full"
          style={{
            width: "8px",
            height: "8px",
            "background-color": color(),
          }}
        />
      </span>
    </Tooltip>
  )
}

export function ProcessPanePanel(props: ProcessPanePanelProps) {
  const status = createMemo((): ProcessStatus => props.process?.status ?? "idle")
  const ptyId = createMemo(() => props.process?.ptyId)
  const hasTerminal = createMemo(() => !!ptyId())
  const isActive = createMemo(() => ["running", "starting", "restarting", "stopping"].includes(status()))
  const canStop = createMemo(() => hasTerminal() || isActive())
  const canStart = createMemo(() => !hasTerminal() && !isActive())
  const portlessUrl = createMemo(() => {
    if (!props.config.portless?.hostname) return undefined
    const h = props.config.portless.hostname.trim().toLowerCase()
    if (!h) return undefined
    return `http://${h.endsWith(".localhost") ? h : h + ".localhost"}:1355`
  })

  // Construct a LocalPTY object from the managed process data.
  // The Terminal component uses this to connect via WebSocket.
  const pty = createMemo((): LocalPTY | undefined => {
    const id = ptyId()
    if (!id) return undefined
    return {
      id,
      title: props.config.name,
      titleNumber: 0,
    }
  })

  return (
    <div class="flex flex-col h-full min-w-0 overflow-hidden bg-background-base relative">
      {/* Title bar */}
      <div class="shrink-0 h-8 flex items-center gap-2 px-2 border-b border-border-weaker-base/50 bg-background-stronger/80 backdrop-blur select-none">
        {/* Color indicator + name */}
        <Show when={props.config.color}>
          <span
            class="size-2 rounded-full shrink-0"
            style={{ "background-color": props.config.color }}
          />
        </Show>
        <StatusDot status={status()} />
        <span class="text-[12px] font-medium text-text-weak whitespace-nowrap overflow-hidden text-ellipsis flex-1 min-w-0 flex items-center gap-1.5">
          {props.config.name}
          <Show when={portlessUrl() && isActive()}>
            <a
              href={portlessUrl()!}
              target="_blank"
              rel="noopener noreferrer"
              class="text-[11px] text-accent hover:underline font-normal truncate"
              onClick={(e) => e.stopPropagation()}
            >
              {portlessUrl()}
            </a>
          </Show>
        </span>

        {/* Controls — mutually exclusive Start vs Stop/Restart, nothing during stopping */}
        <div class="flex items-center gap-0.5 shrink-0">
          <Show when={canStart()}>
            <Tooltip value="Start">
              <IconButton
                icon="arrow-right"
                variant="ghost"
                onClick={props.onStart}
                aria-label="Start process"
              />
            </Tooltip>
          </Show>
          <Show when={canStop() && status() !== "stopping"}>
            <Tooltip value="Stop">
              <IconButton
                icon="stop"
                variant="ghost"
                onClick={props.onStop}
                aria-label="Stop process"
              />
            </Tooltip>
          </Show>
          <Show when={!canStart() && status() !== "stopping"}>
            <Tooltip value="Restart">
              <IconButton
                icon="enter"
                variant="ghost"
                onClick={props.onRestart}
                aria-label="Restart process"
              />
            </Tooltip>
          </Show>
          <Show when={props.onEdit}>
            <Tooltip value="Edit process config">
              <IconButton
                icon="edit-small-2"
                variant="ghost"
                onClick={() => props.onEdit?.()}
                aria-label="Edit process"
              />
            </Tooltip>
          </Show>
        </div>
      </div>

      {/* Terminal area */}
      <div class="flex-1 min-h-0 relative">
        <Show
          when={pty()}
          fallback={
            <div class="absolute inset-0 flex flex-col items-center justify-center gap-3 text-text-weak bg-background-base cursor-default">
              <Show
                when={!isActive()}
                fallback={
                  <>
                    <span class="text-[18px] animate-pulse tracking-widest">...</span>
                    <span class="text-[12px]">{STATUS_LABELS[status()]}</span>
                  </>
                }
              >
                <Icon name="console" size="medium" />
                <span class="text-[12px]">
                  {status() === "crashed"
                    ? `Crashed (exit ${props.process?.exitCode ?? "?"})`
                    : "Process not running"}
                </span>
                <Show when={canStart()}>
                  <button
                    type="button"
                    class="px-3 py-1.5 rounded text-[12px] font-medium bg-surface-base-hover hover:bg-surface-base-active text-text-base transition-colors"
                    onClick={props.onStart}
                  >
                    Start
                  </button>
                </Show>
              </Show>
            </div>
          }
        >
          {(p) => (
            <Terminal pty={p()} />
          )}
        </Show>
      </div>

      {/* Right-edge drag handle */}
      <Show when={props.onResizeStart}>
        <div
          class="absolute top-0 right-0 w-[4px] h-full cursor-col-resize z-10 hover:bg-blue-500/30 transition-colors"
          onPointerDown={(e) => props.onResizeStart?.(e)}
        />
      </Show>
    </div>
  )
}
