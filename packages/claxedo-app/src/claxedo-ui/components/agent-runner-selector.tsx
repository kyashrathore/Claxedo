import { Show, createEffect, createMemo } from "solid-js"
import { Select } from "@opencode-ai/ui/select"
import { useParams } from "@solidjs/router"
import { base64Decode } from "@opencode-ai/util/encode"
import { useSessionParams } from "@claxedo/claxedo-ui/context/session-params"
import { acpScope, useAcpConfig, type RunnerType } from "@claxedo/claxedo-ui/context/acp-config"

const RUNNER_OPTIONS: RunnerType[] = ["claude-acp", "codex-acp", "cursor-acp", "opencode"]
const RUNNER_LABELS: Record<RunnerType, string> = {
  "claude-acp": "Claude",
  "codex-acp": "Codex",
  "cursor-acp": "Cursor",
  "opencode": "OpenCode",
}

interface AgentRunnerSelectorProps {
  triggerStyle?: Record<string, string | number>
  /** When true, the current session already exists — runner cannot be changed. */
  sessionLocked?: boolean
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

  const sessionId = createMemo(() => sessionParams?.sessionId() ?? route.id)
  const directory = createMemo(() => sessionParams?.directory() ?? (route.dir ? base64Decode(route.dir) : undefined))
  const tabId = createMemo(() => sessionParams?.tabId?.())
  const scope = createMemo(() => acpScope({ directory: directory(), sessionId: sessionId(), tabId: tabId() }))

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
        <span class="text-11-regular text-danger-text px-1.5 flex items-center" title="Agent runtime unreachable after timeout">
          <span class="inline-block w-2 h-2 rounded-full bg-danger-text mr-1" />
          Unavailable
        </span>
      </Show>

      {/* Model selector — ACP only (opencode uses its own ModelSelectorPopover) */}
      <Show when={acp.isAcpMode(scope()) && acp.models(scope()).length > 0 && !isError()}>
        <Select
          size="normal"
          options={acp.models(scope()).map((m) => m.id)}
          current={acp.selectedModel(scope())}
          label={(id) => {
            const name = acp.models(scope()).find((m) => m.id === id)?.name ?? id
            return isStale() ? `${name} (stale)` : name
          }}
          onSelect={(id) => {
            if (!id) return
            void acp.setModel(scope(), id, {
              directory: directory(),
              sessionId: sessionId(),
            })
          }}
          class="max-w-[160px]"
          valueClass={optionsLoading() && acp.models(scope()).length === 0 ? "truncate text-13-regular text-text-weak" : "truncate text-13-regular"}
          triggerStyle={style(optionsLoading() && acp.models(scope()).length === 0)}
          variant="ghost"
          disabled={optionsLoading() && acp.models(scope()).length === 0}
        />
        <Show when={isStale()}>
          <span class="text-11-regular text-warning-text px-1" title={acp.configError(scope()) ?? "Model list may be outdated"}>
            <span class="inline-block w-2 h-2 rounded-full bg-warning-text" />
          </span>
        </Show>
      </Show>

      {/* Config error — show when models failed to load entirely */}
      <Show when={acp.isAcpMode(scope()) && acp.configError(scope()) && acp.models(scope()).length === 0}>
        <span class={optionsLoading() ? "text-11-regular text-text-weak px-1.5" : "text-11-regular text-danger-text px-1.5"}>
          {acp.configError(scope())}
        </span>
      </Show>

    </>
  )
}
