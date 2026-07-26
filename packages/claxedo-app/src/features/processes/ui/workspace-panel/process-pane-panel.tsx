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
import type { JSX } from "solid-js"
import { Portal } from "solid-js/web"
import { ClaxedoIcon as Icon } from "@/ui/controls/claxedo-icon"
import { ClaxedoIconButton as IconButton } from "@/ui/controls/claxedo-icon-button"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import type { Process } from "@/features/processes/data/process"
import { processToolbarSlot } from "@/ui/controls/portal-slot"
import { PROCESS_STATUS_COLORS, PROCESS_STATUS_LABELS } from "./process-status-display"

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
  portalHeader?: boolean
  renderTerminal?: (terminal: ProcessTerminal) => JSX.Element
}

export type ProcessTerminal = {
  id: string
  title: string
  titleNumber: number
}

function StatusDot(props: { status: ProcessStatus }) {
  const color = () => PROCESS_STATUS_COLORS[props.status] ?? "#6b7280"
  const isPulsing = () => props.status === "running" || props.status === "restarting" || props.status === "starting"

  return (
    <Tooltip value={PROCESS_STATUS_LABELS[props.status] ?? props.status}>
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
  const pty = createMemo((): ProcessTerminal | undefined => {
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
  const renderHeader = (portaled: boolean) => (
    <div
      data-testid="process-pane-header"
      class="shrink-0 flex items-center gap-2 select-none"
      classList={{
        "h-full min-w-0 flex-1": portaled,
        "h-8 px-2 border-b border-border-weaker-base/50 bg-background-stronger/80 backdrop-blur": !portaled,
      }}
    >
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
            href={primaryUrl()}
            target="_blank"
            rel="noopener noreferrer"
            class="text-[11px] text-text-interactive-base hover:underline font-normal truncate"
            onClick={(event) => event.stopPropagation()}
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

      <div class="flex items-center gap-0.5 shrink-0">
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
  )

  return (
    <div
      class="flex flex-col h-full min-w-0 overflow-hidden bg-background-base relative"
      data-component="process-pane-panel"
      data-process-id={props.config.id}
      data-process-name={props.config.name}
      data-testid="process-pane-panel"
    >
      <Show
        when={props.portalHeader && processToolbarSlot()}
        fallback={renderHeader(false)}
      >
        {(host) => <Portal mount={host()}>{renderHeader(true)}</Portal>}
      </Show>

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
                    <span class="text-[12px]">{live() ? PROCESS_STATUS_LABELS[status()] : "Inactive"}</span>
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
          {(pty) => props.renderTerminal?.(pty)}
        </Show>
        <Show when={hit()}>
          <div class="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 text-text-weak bg-background-base cursor-default px-6 max-w-md mx-auto">
            <span class="text-[12px]">
              Port <span class="font-mono font-medium text-text-base">{hit()!.port}</span> is in use
            </span>
            <Show when={!props.config.port?.inject}>
              <p class="text-[11px] text-text-weaker text-center max-w-xs">
                This process has no <code class="font-mono text-text-weak">port.inject</code> in its config.
                Add a <code class="font-mono text-text-weak">port</code> block in
                <code class="font-mono text-text-weak"> .workspace-runtime/processes.jsonc</code> if the command
                needs the selected port passed through.
              </p>
            </Show>
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
