import { For, Match, Show, Switch, createMemo } from "solid-js"
import { ClaxedoIcon as Icon } from "@/ui/controls/claxedo-icon"
import { ClaxedoIconButton as IconButton } from "@/ui/controls/claxedo-icon-button"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import type { Process } from "@/features/processes/data/process"
import { AddProcessDialog } from "@/features/processes/ui/add-process-dialog"
import { PROCESS_STATUS_COLORS, PROCESS_STATUS_LABELS } from "./process-status-display"

type ProcessStatus = Process.Status

function statusFor(process: Process.ManagedProcess | undefined): ProcessStatus {
  return process?.status ?? "idle"
}

function activeStatus(status: ProcessStatus) {
  return status === "running" || status === "starting" || status === "restarting" || status === "stopping"
}

function ProcessStatusDot(props: { status: ProcessStatus }) {
  const isPulsing = () =>
    props.status === "running" || props.status === "starting" || props.status === "restarting"
  return (
    <Tooltip value={PROCESS_STATUS_LABELS[props.status] ?? props.status}>
      <span class="relative flex size-2 shrink-0 items-center justify-center">
        <Show when={isPulsing()}>
          <span
            class="absolute inline-flex size-2 animate-ping rounded-full opacity-40"
            style={{ "background-color": PROCESS_STATUS_COLORS[props.status] ?? "var(--icon-base)" }}
          />
        </Show>
        <span
          class="relative inline-flex size-2 rounded-full"
          style={{ "background-color": PROCESS_STATUS_COLORS[props.status] ?? "var(--icon-base)" }}
        />
      </span>
    </Tooltip>
  )
}

/**
 * Compact one-line subtitle: command preview when idle, port + URL when running,
 * exit code when crashed. Trades raw status word for actually-useful information,
 * since the status dot already conveys the lifecycle state visually.
 */
function ProcessSubtitle(props: {
  config: Process.ProcessConfig
  process: Process.ManagedProcess | undefined
}) {
  const status = () => props.process?.status ?? "idle"
  const commandPreview = () => {
    const args = props.config.args?.length ? ` ${props.config.args.join(" ")}` : ""
    return `${props.config.command}${args}`
  }
  const port = () => props.process?.assignedPort
  const namedUrl = () => props.process?.namedUrl
  const namedHost = () => {
    const url = namedUrl()
    if (!url) return undefined
    try {
      return new URL(url).host
    } catch {
      return url
    }
  }
  const launchError = () => props.process?.launchError

  return (
    <div class="truncate text-xs text-text-weaker">
      <Switch fallback={<span class="font-mono">{commandPreview()}</span>}>
        <Match when={status() === "running" || status() === "starting" || status() === "restarting"}>
          <Show when={namedHost()} fallback={<span class="font-mono">:{port() ?? "—"}</span>}>
            <span class="font-mono text-text-weak">{namedHost()}</span>
            <Show when={port()}>
              <span> · :{port()}</span>
            </Show>
          </Show>
        </Match>
        <Match when={status() === "crashed"}>
          <span style={{ color: "var(--surface-critical-strong)" }}>
            {launchError() ?? (props.process?.exitCode !== undefined ? `exit ${props.process.exitCode}` : "crashed")}
          </span>
          <span> · </span>
          <span class="font-mono">{commandPreview()}</span>
        </Match>
        <Match when={status() === "stopping"}>
          <span>Stopping…</span>
        </Match>
      </Switch>
    </div>
  )
}

export function WorkspaceProcessesNavigator(props: {
  directory: string
  activeProcessId?: string
  onProcessSelect: (processId: string) => void
  processPane: ProcessPaneApi
  request?: typeof fetch
}) {
  const processPane = props.processPane
  const dialog = useDialog()
  const configs = createMemo(() => processPane.configs())
  const hasRunning = createMemo(() => processPane.hasRunning())
  const canMutate = createMemo(() => processPane.canMutate())

  const openAddDialog = () => {
    if (!canMutate()) return
    dialog.show(() => (
      <AddProcessDialog
        directory={props.directory}
        request={props.request}
        onDone={() => processPane.refresh()}
      />
    ))
  }

  return (
    <div class="flex size-full min-w-0 flex-col bg-background-base">
      <div class="flex h-9 shrink-0 items-center gap-1 border-b border-border-weak-base px-2">
        <Icon name="console" size="small" />
        <div class="min-w-0 flex-1 truncate text-sm font-medium text-text-base">Processes</div>
        <Show when={canMutate() && configs().length > 0}>
          <Tooltip value={hasRunning() ? "Stop all processes" : "Start all processes"}>
            <IconButton
              icon={hasRunning() ? "stop" : "arrow-right"}
              variant="ghost"
              aria-label={hasRunning() ? "Stop all processes" : "Start all processes"}
              onClick={() => {
                if (hasRunning()) void processPane.stopAll()
                else void processPane.startAll()
              }}
            />
          </Tooltip>
        </Show>
        <Show when={canMutate()}>
          <Tooltip value="Add process">
            <IconButton
              icon="plus-small"
              variant="ghost"
              aria-label="Add process"
              onClick={openAddDialog}
            />
          </Tooltip>
        </Show>
      </div>

      <div class="min-h-0 flex-1 overflow-auto py-1">
        <Show
          when={processPane.loaded()}
          fallback={
            <div class="flex h-full items-center justify-center px-4 text-center text-sm text-text-weak">
              Loading processes...
            </div>
          }
        >
          <Show
            when={configs().length > 0}
            fallback={
              <div class="flex h-full flex-col items-center justify-center gap-3 px-4 text-center text-sm text-text-weak">
                <Icon name="console" size="medium" />
                <div>No processes configured.</div>
                <Show when={canMutate()}>
                  <button
                    type="button"
                    class="rounded bg-surface-base-hover px-3 py-1.5 text-sm font-medium text-text-base hover:bg-surface-base-active"
                    onClick={openAddDialog}
                  >
                    Add process
                  </button>
                </Show>
              </div>
            }
          >
            <For each={configs()}>
              {(config) => {
                const process = createMemo(() => processPane.processForConfig(config.id))
                const status = createMemo(() => statusFor(process()))
                const isActive = createMemo(() => props.activeProcessId === config.id)
                const canStop = createMemo(() => activeStatus(status()))
                const canStart = createMemo(() => !activeStatus(status()))

                return (
                  <button
                    type="button"
                    class="group flex w-full min-w-0 items-center gap-2 px-2 py-1.5 text-left text-sm text-text-weak transition-colors hover:bg-surface-base-hover hover:text-text-base"
                    classList={{
                      "bg-surface-base-hover text-text-base": isActive(),
                    }}
                    onClick={() => props.onProcessSelect(config.id)}
                  >
                    <ProcessStatusDot status={status()} />
                    <div class="min-w-0 flex-1">
                      <div class="flex items-baseline gap-1.5 min-w-0">
                        <span class="truncate font-medium">{config.name}</span>
                        <Show when={config.port?.name}>
                          <span class="shrink-0 text-2xs tabular-nums text-text-weaker">
                            {config.port!.name}
                          </span>
                        </Show>
                      </div>
                      <ProcessSubtitle config={config} process={process()} />
                    </div>
                    <div class="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                      <Show when={canMutate()}>
                      <Show when={canStart()}>
                        <Tooltip value="Start">
                          <IconButton
                            icon="arrow-right"
                            variant="ghost"
                            aria-label="Start process"
                            onClick={(event) => {
                              event.stopPropagation()
                              void processPane.start(config.id)
                            }}
                          />
                        </Tooltip>
                      </Show>
                      <Show when={canStop()}>
                        <Tooltip value="Stop">
                          <IconButton
                            icon="stop"
                            variant="ghost"
                            aria-label="Stop process"
                            onClick={(event) => {
                              event.stopPropagation()
                              void processPane.stop(config.id)
                            }}
                          />
                        </Tooltip>
                      </Show>
                      <Show when={!canStart() && status() !== "stopping"}>
                        <Tooltip value="Restart">
                          <IconButton
                            icon="enter"
                            variant="ghost"
                            aria-label="Restart process"
                            onClick={(event) => {
                              event.stopPropagation()
                              void processPane.restart(config.id)
                            }}
                          />
                        </Tooltip>
                      </Show>
                      </Show>
                    </div>
                  </button>
                )
              }}
            </For>
          </Show>
        </Show>
      </div>
    </div>
  )
}

export type ProcessPaneApi = {
  configs: () => Process.ProcessConfig[]
  loaded: () => boolean
  hasRunning: () => boolean
  canMutate: () => boolean
  refresh: () => void | Promise<unknown>
  startAll: () => void | Promise<unknown>
  stopAll: () => void | Promise<unknown>
  processForConfig: (id: string) => Process.ManagedProcess | undefined
  start: (id: string) => void | Promise<unknown>
  stop: (id: string) => void | Promise<unknown>
  restart: (id: string) => void | Promise<unknown>
}
