import { Show, createEffect, createMemo, type JSX } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { ProviderIcon } from "@opencode-ai/ui/provider-icon"
import { Select } from "@opencode-ai/ui/select"
import { useParams } from "@solidjs/router"
import { base64Decode } from "@opencode-ai/util/encode"
import { ModelSelectorPopover, type PickerItem, type PickerState } from "@/components/dialog-select-model"
import { useSessionParams } from "@claxedo/claxedo-ui/context/session-params"
import { ACP_DISPLAY_NAMES, useAcpConfig, type RunnerType } from "@claxedo/claxedo-ui/context/acp-config"
import { panePreferenceScope } from "../../pane/store/pane-preferences"

const RUNNER_OPTIONS: RunnerType[] = ["claude-acp", "codex-acp", "cursor-acp", "pi", "opencode"]
const RUNNER_LABELS: Record<RunnerType, string> = {
  "claude-acp": "Claude",
  "codex-acp": "Codex",
  "cursor-acp": "Cursor",
  "pi": "Pi (central)",
  "opencode": "OpenCode",
}

function split(input: string) {
  const idx = input.indexOf("/")
  if (idx < 1 || idx === input.length - 1) return
  return {
    provider: input.slice(0, idx),
    model: input.slice(idx + 1),
  }
}

function title(input: string) {
  return input
    .split(/[-_]/g)
    .filter(Boolean)
    .map((item) => item[0]?.toUpperCase() + item.slice(1))
    .join(" ")
}

function label(input: string) {
  return ACP_DISPLAY_NAMES[input] ?? title(input)
}

function provider(input: string, runner: RunnerType) {
  if (runner !== "pi") return ""
  return split(input)?.provider ?? "pi"
}

type Item = {
  id: string
  name: string
  provider: {
    id: string
    name: string
  }
}

interface AgentRunnerSelectorProps {
  triggerStyle?: JSX.CSSProperties
  /** When true, the current session already exists — runner cannot be changed. */
  sessionLocked?: boolean
  directory?: string
  sessionId?: string
  surfaceId?: string
  draftId?: string
}

export function AgentRunnerSelector(props: AgentRunnerSelectorProps) {
  const acp = useAcpConfig()
  const route = useParams()
  let sessionParams: ReturnType<typeof useSessionParams> | undefined
  try {
    sessionParams = useSessionParams()
  } catch {
    /* not in split mode */
  }

  const sessionId = createMemo(() => props.sessionId ?? sessionParams?.sessionId() ?? route.id)
  const directory = createMemo(() => props.directory ?? sessionParams?.directory() ?? (route.dir ? base64Decode(route.dir) : undefined))
  const surfaceId = createMemo(() => props.surfaceId ?? sessionParams?.surfaceId?.())
  const draftId = createMemo(() => props.draftId)
  const scope = createMemo(() =>
    panePreferenceScope({
      directory: directory(),
      sessionId: sessionId(),
      surfaceId: surfaceId(),
      draftId: draftId(),
    }),
  )

  createEffect(() => {
    if (!directory()) return
    void acp.hydrate(scope(), {
      directory: directory(),
      sessionId: sessionId(),
    })
  })

  const style = (off: boolean) => {
    const opacity = props.triggerStyle?.opacity
    return {
      height: "28px",
      ...props.triggerStyle,
      opacity: typeof opacity === "number" ? opacity * (off ? 0.45 : 1) : off ? 0.45 : opacity,
    }
  }

  const isPolling = () => acp.readiness(scope()) === "polling"
  const isError = () => acp.readiness(scope()) === "error"
  const isStale = () => acp.optionsStale(scope())
  const optionsLoading = () => acp.optionsLoading(scope())
  const rows = createMemo<Item[]>(() => {
    const runner = acp.runner(scope())
    return acp.models(scope()).map((item) => {
      const id = provider(item.id, runner)
      return {
        id: item.id,
        name: item.name,
        provider: {
          id,
          name: id ? label(id) : "",
        },
      }
    })
  })
  const picked = createMemo(() => rows().find((item) => item.id === acp.selectedModel(scope())))
  const model = createMemo<PickerState>(() => ({
    list: () => rows() as PickerItem[],
    current: () => picked() as PickerItem | undefined,
    visible: () => true,
    set: (item) => {
      if (!item) return
      void acp.setModel(scope(), item.modelID, {
        directory: directory(),
        sessionId: sessionId(),
      })
    },
  }))

  // Disable runner switching after a session is created — backend migration is not supported
  const runnerLocked = () => !!props.sessionLocked
  const runnerDisabled = () => runnerLocked() || isPolling()

  return (
    <>
      {/* Runner selector — disabled when current session has messages */}
      <Select
        size="normal"
        options={RUNNER_OPTIONS}
        current={acp.runner(scope())}
        label={(r) => RUNNER_LABELS[r as RunnerType] ?? r}
        onSelect={(r) => {
          if (!r || runnerDisabled()) return
          void acp.setRunner(scope(), r as RunnerType, {
            directory: directory(),
            sessionId: sessionId(),
          })
        }}
        class="max-w-[120px]"
        valueClass={runnerDisabled() ? "truncate text-13-regular text-text-weak" : "truncate text-13-regular"}
        triggerStyle={style(runnerDisabled())}
        variant="ghost"
        disabled={runnerDisabled()}
      />

      {/* Readiness indicator */}
      <Show when={isPolling()}>
        <span class="text-11-regular text-text-weak px-1.5 flex items-center" title="Connecting to agent runtime...">
          <span class="inline-block w-2 h-2 rounded-full bg-text-weak animate-pulse mr-1" />
          Connecting
        </span>
      </Show>
      <Show when={isError()}>
        <span class="text-11-regular text-text-on-critical-base px-1.5 flex items-center" title="Agent runtime unreachable after timeout">
          <span class="inline-block w-2 h-2 rounded-full bg-surface-critical-strong mr-1" />
          Unavailable
        </span>
      </Show>

      {/* Model selector — non-opencode runners use grouped model popover */}
      <Show when={acp.isAcpMode(scope()) && acp.models(scope()).length > 0 && !isError()}>
        <ModelSelectorPopover
          model={model()}
          actions={false}
          tooltips={false}
          triggerAs={Button}
          triggerProps={{
            variant: "ghost",
            size: "normal",
            disabled: optionsLoading() && acp.models(scope()).length === 0,
            style: style(optionsLoading() && acp.models(scope()).length === 0),
            class: "min-w-0 max-w-[160px] text-13-regular group",
          }}
        >
          <Show when={picked()?.provider.id}>
            <ProviderIcon
              id={picked()!.provider.id}
              class="size-4 shrink-0 opacity-40 group-hover:opacity-100 transition-opacity duration-150"
            />
          </Show>
          <span class={optionsLoading() && acp.models(scope()).length === 0 ? "truncate text-13-regular text-text-weak" : "truncate text-13-regular"}>
            {picked()?.name ?? "Select model"}
          </span>
          <Icon name="chevron-down" size="small" class="shrink-0" />
        </ModelSelectorPopover>
        <Show when={isStale()}>
          <span class="text-11-regular text-text-on-warning-base px-1" title={acp.configError(scope()) ?? "Model list may be outdated"}>
            <span class="inline-block w-2 h-2 rounded-full bg-surface-warning-strong" />
          </span>
        </Show>
      </Show>

      {/* Config error — show when models failed to load entirely */}
      <Show when={acp.isAcpMode(scope()) && acp.configError(scope()) && acp.models(scope()).length === 0}>
        <span class={optionsLoading() ? "text-11-regular text-text-weak px-1.5" : "text-11-regular text-text-on-critical-base px-1.5"}>
          {acp.configError(scope())}
        </span>
      </Show>

    </>
  )
}
