/**
 * ProcessPanePanel
 *
 * Individual process panel within the workspace process side panel.
 * Shows a title bar with process name, status dot, and controls,
 * plus a terminal area connected to the process's PTY via WebSocket.
 *
 * Process terminals stay dormant while their tab is in the background.
 */

import { Show, createMemo } from "solid-js"
import { Terminal } from "@/components/terminal"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import type { LocalPTY } from "@/context/terminal"
import type { Process } from "@claxedo/process/process"

type ProcessStatus = Process.Status

export type ProcessPanePanelProps = {
  config: Process.ProcessConfig
  active?: boolean
  process: Process.ManagedProcess | undefined
  onStart: () => void
  onStop: () => void
  onRestart: () => void
  onResolveConflict?: (strategy: "kill-existing" | "pick-new") => void
  onResolveRouteConflict?: (strategy: "kill-existing" | "pick-new") => void
  /** Open the edit dialog for this process config */
  onEdit?: () => void
}

const STATUS_COLORS: Record<ProcessStatus, string> = {
  idle: "var(--icon-base)",
  starting: "var(--surface-success-strong)",
  running: "var(--surface-success-strong)",
  stopping: "var(--icon-base)",
  stopped: "var(--icon-base)",
  crashed: "var(--surface-critical-strong)",
  restarting: "var(--surface-success-strong)",
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
  const live = createMemo(() => props.active ?? true)
  const isActive = createMemo(() => ["running", "starting", "restarting", "stopping"].includes(status()))
  const canStop = createMemo(() => hasTerminal() || isActive())
  const canStart = createMemo(() => !hasTerminal() && !isActive())
  const localUrl = createMemo(() => {
    const port = props.process?.assignedPort
    if (!port) return undefined
    return `http://localhost:${port}`
  })
  const namedUrl = createMemo(() => props.process?.namedUrl)
  const primaryUrl = createMemo(() => namedUrl() ?? localUrl())
  const showLocalSecondary = createMemo(() => !!namedUrl() && !!localUrl())
  const conflict = createMemo(() => props.process?.conflict)
  const hit = createMemo(() => conflict())
  const routeConflict = createMemo(() => props.process?.routeConflict)
  const routeHit = createMemo(() => routeConflict())
  const launchError = createMemo(() => props.process?.launchError)
  const commandLine = createMemo(() => {
    const args = props.config.args?.length ? ` ${props.config.args.join(" ")}` : ""
    return `${props.config.command}${args}`
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
  const visiblePty = createMemo(() => {
    const next = pty()
    if (!live()) return undefined
    return next
  })

  return (
    <div
      class="flex flex-col h-full min-w-0 overflow-hidden bg-background-base relative"
      data-component="process-pane-panel"
      data-process-id={props.config.id}
      data-process-name={props.config.name}
      data-testid="process-pane-panel"
    >
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
          <Show when={primaryUrl() && isActive()}>
            <a
              href={primaryUrl()!}
              target="_blank"
              rel="noopener noreferrer"
              class="text-[11px] text-text-interactive-base hover:underline font-normal truncate"
              onClick={(e) => e.stopPropagation()}
            >
              {primaryUrl()}
            </a>
            <Show when={showLocalSecondary()}>
              <span
                class="text-[10px] text-text-weak font-normal tabular-nums truncate"
                title="Local port (raw)"
              >
                {localUrl()}
              </span>
            </Show>
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
                data-process-action="start"
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
                data-process-action="stop"
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
                data-process-action="restart"
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
          when={visiblePty()}
          keyed
          fallback={
            <div class="absolute inset-0 flex items-center justify-center bg-background-base cursor-default px-6">
              <Show
                when={!isActive()}
                fallback={
                  <div class="flex flex-col items-center gap-4 text-text-weak max-w-md w-full">
                    <span class="text-[18px] animate-pulse tracking-widest">…</span>
                    <span class="text-[12px]">{live() ? STATUS_LABELS[status()] : "Inactive"}</span>
                    <Show when={live() && commandLine()}>
                      <code class="px-3 py-1.5 rounded bg-surface-base-hover text-[11px] font-mono text-text-weaker truncate max-w-full">
                        {commandLine()}
                      </code>
                    </Show>
                  </div>
                }
              >
                <div class="flex flex-col items-center gap-4 text-text-weak max-w-md w-full">
                  <Show
                    when={!live()}
                    fallback={
                      <Show
                        when={status() === "crashed"}
                        fallback={
                          <>
                            <Icon name="console" size="medium" />
                            <div class="flex flex-col items-center gap-1.5">
                              <span class="text-[13px] text-text-base font-medium">{props.config.name}</span>
                              <span class="text-[11px] text-text-weaker">Process not running</span>
                            </div>
                            <Show when={commandLine()}>
                              <code class="px-3 py-1.5 rounded bg-surface-base-hover text-[11px] font-mono text-text-weaker truncate max-w-full">
                                {commandLine()}
                              </code>
                            </Show>
                            <Show when={props.config.port?.name}>
                              <div class="text-[10px] text-text-weaker tabular-nums">
                                port: <span class="font-mono">{props.config.port!.name}</span>
                                <Show when={props.config.port?.preferred}>
                                  <span> · preferred {props.config.port!.preferred}</span>
                                </Show>
                              </div>
                            </Show>
                            <Show when={canStart() && live()}>
                              <button
                                type="button"
                                class="mt-1 inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-[12px] font-medium bg-surface-base-hover hover:bg-surface-base-active text-text-base transition-colors"
                                onClick={props.onStart}
                                data-process-action="start-fallback"
                              >
                                <Icon name="arrow-right" size="small" />
                                Start
                              </button>
                            </Show>
                          </>
                        }
                      >
                        <div class="flex flex-col items-center gap-1.5">
                          <span class="text-[13px] font-medium" style={{ color: "var(--surface-critical-strong)" }}>
                            {launchError() ? "Failed to start" : "Crashed"}
                            <Show when={props.process?.exitCode !== undefined}>
                              <span class="text-text-weaker font-normal"> · exit {props.process?.exitCode}</span>
                            </Show>
                          </span>
                          <span class="text-[11px] text-text-weaker">{props.config.name}</span>
                        </div>
                        <Show when={launchError()}>
                          <span class="max-w-full truncate text-[11px] text-text-weaker" title={launchError()}>
                            {launchError()}
                          </span>
                        </Show>
                        <Show when={commandLine()}>
                          <code class="px-3 py-1.5 rounded bg-surface-base-hover text-[11px] font-mono text-text-weaker truncate max-w-full">
                            {commandLine()}
                          </code>
                        </Show>
                        <Show when={canStart() && live()}>
                          <button
                            type="button"
                            class="mt-1 inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-[12px] font-medium bg-surface-base-hover hover:bg-surface-base-active text-text-base transition-colors"
                            onClick={props.onStart}
                            data-process-action="start-fallback"
                          >
                            <Icon name="arrow-right" size="small" />
                            Restart
                          </button>
                        </Show>
                      </Show>
                    }
                  >
                    <Icon name="console" size="medium" />
                    <span class="text-[12px]">Process hidden while tab is inactive</span>
                  </Show>
                </div>
              </Show>
            </div>
          }
        >
          {(pty) => <Terminal pty={pty} />}
        </Show>
        <Show when={hit()}>
          <div class="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 text-text-weak bg-background-base cursor-default px-6 max-w-md mx-auto">
            <span class="text-[12px]">
              Port <span class="font-mono font-medium text-text-base">{hit()!.port}</span> is in use
            </span>
            <Show
              when={props.config.port?.inject}
              fallback={
                <>
                  <p class="text-[11px] text-text-weaker text-center max-w-xs">
                    This process has no <code class="font-mono text-text-weak">port.inject</code> in its config,
                    so Claxedo can't tell the command which port to use.
                    Add a <code class="font-mono text-text-weak">port</code> block (env var or flag) in
                    <code class="font-mono text-text-weak"> .claxedo/processes.jsonc</code> to enable
                    automatic resolution.
                  </p>
                  <button
                    type="button"
                    class="text-[11px] text-text-weaker hover:text-text-weak transition-colors cursor-pointer"
                    onClick={props.onStart}
                  >
                    Try again
                  </button>
                </>
              }
            >
              <button
                type="button"
                class="px-3 py-1.5 rounded text-[12px] font-medium bg-surface-base-hover hover:bg-surface-base-active text-text-base transition-colors cursor-pointer"
                onClick={() => props.onResolveConflict?.("pick-new")}
              >
                Use another port
              </button>
              <button
                type="button"
                class="text-[11px] text-text-weaker hover:text-text-weak transition-colors cursor-pointer"
                onClick={() => props.onResolveConflict?.("kill-existing")}
              >
                Kill process &amp; reclaim
              </button>
            </Show>
          </div>
        </Show>
        <Show when={routeHit() && !hit()}>
          <div class="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 text-text-weak bg-background-base cursor-default">
            <span class="text-[12px]">
              Route <span class="font-mono font-medium text-text-base">{routeHit()!.hostname}</span> is in use
            </span>
            <button
              type="button"
              class="px-3 py-1.5 rounded text-[12px] font-medium bg-surface-base-hover hover:bg-surface-base-active text-text-base transition-colors cursor-pointer"
              onClick={() => props.onResolveRouteConflict?.("pick-new")}
            >
              Use another name
            </button>
            <button
              type="button"
              class="text-[11px] text-text-weaker hover:text-text-weak transition-colors cursor-pointer"
              onClick={() => props.onResolveRouteConflict?.("kill-existing")}
            >
              Kill process &amp; reclaim
            </button>
          </div>
        </Show>
      </div>

    </div>
  )
}
