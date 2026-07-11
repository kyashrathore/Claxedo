import { Show, createEffect, createMemo, createSignal, onCleanup, untrack, type JSX } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { ProviderIcon } from "@opencode-ai/ui/provider-icon"
import { Select } from "@opencode-ai/ui/select"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
import { ModelSelectorPopover, type PickerItem, type PickerState } from "@claxedo/components/dialogs/select-model"
import { HARNESS_DISPLAY_NAMES, type HarnessType } from "@claxedo/session-client/harness/profile"
import type { HarnessSelectionController } from "@claxedo/session-client/harness/controller"
import { panePreferenceScope } from "../../pane/store/pane-preferences"
import { createModelSelectionController, modelKeyFromPickerSelection } from "../../session-client/commands/model-selection"
const HARNESS_OPTIONS: HarnessType[] = ["claude-acp", "codex-acp", "cursor-acp", "claude-sdk", "codex-app-server", "cursor-sdk", "pi", "opencode"]
const HARNESS_OPTION_LABELS: Partial<Record<HarnessType, string>> = {
  "claude-sdk": "Claude",
  "codex-app-server": "Codex",
  "cursor-sdk": "Cursor",
}

function title(input: string) {
  return input
    .split(/[-_]/g)
    .filter(Boolean)
    .map((item) => item[0]?.toUpperCase() + item.slice(1))
    .join(" ")
}

function label(input: string) {
  return HARNESS_DISPLAY_NAMES[input] ?? title(input)
}

function harnessOptionLabel(input: HarnessType) {
  return HARNESS_OPTION_LABELS[input] ?? label(input)
}

function harnessOptionGroup(input: HarnessType) {
  if (input === "claude-acp" || input === "codex-acp" || input === "cursor-acp") return "ACP"
  if (input === "claude-sdk" || input === "codex-app-server" || input === "cursor-sdk") return "Native SDK"
  return "Direct"
}

type Item = {
  id: string
  name: string
  provider: {
    id: string
    name: string
  }
}

interface AgentHarnessSelectorProps {
  triggerStyle?: JSX.CSSProperties
  /** When true, the current session already exists — harness cannot be changed. */
  sessionLocked?: boolean
  directory?: string
  sessionId?: string
  surfaceId?: string
  draftId?: string
  active?: boolean
  harnessController: HarnessSelectionController
}

export function AgentHarnessSelector(props: AgentHarnessSelectorProps) {
  const sessionId = createMemo(() => {
    const next = props.sessionId
    return next
  })
  const directory = createMemo(() => {
    const next = props.directory
    return next
  })
  const surfaceId = createMemo(() => {
    const next = props.surfaceId
    return next
  })
  const draftId = createMemo(() => {
    return props.draftId
  })
  const sessionLocked = createMemo(() => {
    const next = !!props.sessionLocked
    return next
  })
  const scope = createMemo(() => {
    const next = panePreferenceScope({
      directory: directory(),
      sessionId: sessionId(),
      surfaceId: surfaceId(),
      draftId: draftId(),
    })
    return next
  })

  createEffect(() => {
    const nextScope = scope()
    const nextDirectory = directory()
    const nextSessionId = sessionId()
    if (props.active === false) {
      return
    }
    if (!nextDirectory) {
      return
    }
    const timer = setTimeout(() => untrack(() => {
      void props.harnessController.hydrate(nextScope, {
        directory: nextDirectory,
        sessionId: nextSessionId,
      })
    }), 50)
    onCleanup(() => clearTimeout(timer))
  })

  const style = (off: boolean) => {
    const base = props.triggerStyle
    const opacity = base?.opacity
    return {
      height: "28px",
      ...base,
      opacity: typeof opacity === "number" ? opacity * (off ? 0.45 : 1) : off ? 0.45 : opacity,
    }
  }

  const selection = createMemo(() => props.harnessController.read(scope()))
  const harness = createMemo(() => {
    return selection().harness
  })
  const isPolling = () => selection().readiness === "polling"
  const isError = () => selection().readiness === "error"
  const isStale = () => selection().optionsStale
  const optionsLoading = () => selection().optionsLoading
  const [switchingHarness, setSwitchingHarness] = createSignal<HarnessType | undefined>()
  const harnessSwitching = () => !!switchingHarness()
  const rows = createMemo<Item[]>(() => {
    const currentHarness = harness()
    return selection().models.map((item) => ({
      id: item.id,
      name: item.name,
      provider: { id: currentHarness, name: label(currentHarness) },
    }))
  })
  const picked = createMemo(() => {
    const selected = selection().selectedModel
    const next = rows().find((item) => item.id === selected)
    return next
  })
  const modelSelection = createMemo(() =>
    createModelSelectionController({
      write: (command) => {
        if (!command.model) return
        return props.harnessController.setModel(scope(), command.model.modelID, {
          directory: directory(),
          sessionId: sessionId(),
        })
      },
    })
  )
  const model = createMemo<PickerState>(() => ({
    list: () => rows() as PickerItem[],
    current: () => picked() as PickerItem | undefined,
    visible: () => true,
    set: (item) => {
      const modelKey = modelKeyFromPickerSelection(item)
      if (!modelKey) return
      const hit = rows().find((row) => row.id === modelKey.modelID)
      if (!hit) return
      const currentHarness = harness()
      void modelSelection().set({
        scope: {
          key: `harness:${scope()}`,
          current: () => {
            const selected = selection().selectedModel
            return selected ? { providerID: currentHarness, modelID: selected } : undefined
          },
        },
        model: { providerID: currentHarness, modelID: hit.id },
        source: "ui",
      })
    },
  }))

  // Disable harness switching after a session is created because backend migration is not supported.
  const harnessDisabled = createMemo(() => sessionLocked() || isPolling() || harnessSwitching())
  const harnessTriggerStyle = createMemo(() => {
    const disabled = harnessDisabled()
    const next = style(disabled)
    return next
  })
  const modelLoading = createMemo(() => {
    return optionsLoading()
  })
  const hasModelOptions = createMemo(() => {
    return selection().models.length > 0
  })
  const modelUnavailable = createMemo(() => {
    return !optionsLoading() && !hasModelOptions()
  })
  const modelOptionsFailed = createMemo(() => !!selection().configError && isStale() && !optionsLoading())
  const modelDisabled = createMemo(() => {
    return modelLoading() || isError() || modelUnavailable() || modelOptionsFailed()
  })
  const modelLabel = createMemo(() => {
    if (modelLoading()) return "Loading models"
    if (modelOptionsFailed()) return "Unavailable"
    if (picked()) return picked()?.name
    if (isError()) return "Unavailable"
    if (!hasModelOptions()) return selection().configError ?? "Select model"
    return selection().selectedModel || "Select model"
  })
  const modelTriggerStyle = createMemo(() => {
    const next = style(modelDisabled())
    return next
  })
  const modelTriggerProps = createMemo(() => ({
    variant: "ghost" as const,
    size: "normal" as const,
    disabled: modelDisabled(),
    style: modelTriggerStyle(),
    class: "min-w-0 max-w-[160px] max-md:max-w-[72px] text-13-regular group",
    "aria-label": "Select harness model",
    "data-action": "prompt-harness-model",
  }))
  const modelIssue = createMemo(() => {
    const message = selection().configError
    if (message) return message
    if (isStale()) return "Model list may be outdated"
  })
  const modelIssueIsError = createMemo(() => !!selection().configError && !optionsLoading())

  return (
    <>
      {/* Harness selector — disabled when current session has messages */}
      <Select
        size="normal"
        options={HARNESS_OPTIONS}
        current={harness()}
        label={(r) => harnessOptionLabel(r)}
        groupBy={(r) => harnessOptionGroup(r)}
        onSelect={(r) => {
          const current = harness()
          if (!r || harnessDisabled()) return
          if (r === current) {
            return
          }
          setSwitchingHarness(r)
          void Promise.resolve(
            props.harnessController.setHarness(scope(), r, {
              directory: directory(),
              sessionId: sessionId(),
            }),
          ).finally(() => {
            setSwitchingHarness((current) => current === r ? undefined : current)
          })
        }}
        class="min-w-0 max-w-[120px] max-md:max-w-[86px]"
        valueClass={harnessDisabled() ? "truncate text-13-regular text-text-weak" : "truncate text-13-regular"}
        triggerStyle={harnessTriggerStyle()}
        variant="ghost"
        disabled={harnessDisabled()}
      />
      <Show when={harnessSwitching()}>
        <span
          aria-hidden="true"
          class="size-3 shrink-0 animate-spin rounded-full border border-border-base border-t-transparent"
          title="Switching harness"
        />
      </Show>

      {/* Readiness indicator */}
      <Show when={isPolling()}>
        <span class="text-11-regular text-text-weak px-1.5 flex items-center" title="Connecting to agent runtime...">
          <span class="inline-block w-2 h-2 rounded-full bg-text-weak animate-pulse mr-1" />
          Connecting
        </span>
      </Show>
      <Show when={isError()}>
        <span
          class="text-11-regular text-text-on-critical-base px-1.5 flex items-center"
          title="Agent runtime unreachable after timeout"
        >
          <span class="inline-block w-2 h-2 rounded-full bg-surface-critical-strong mr-1" />
          Unavailable
        </span>
      </Show>

      {/* Model selector — non-opencode harnesses use grouped model popover */}
      <Show when={selection().isHarnessMode}>
        <ModelSelectorPopover
          model={model()}
          actions={false}
          tooltips={false}
          triggerAs={Button}
          triggerProps={modelTriggerProps()}
        >
          <Show when={picked()?.provider.id && !modelUnavailable() && !modelOptionsFailed()}>
            <ProviderIcon
              id={picked()!.provider.id}
              class="size-4 shrink-0 opacity-40 group-hover:opacity-100 transition-opacity duration-150"
            />
          </Show>
          <span
            class={
              modelDisabled()
                ? "truncate text-13-regular text-text-weak"
                : "truncate text-13-regular"
            }
          >
            {modelLabel()}
          </span>
          <Show when={!modelDisabled()}>
            <Icon name="chevron-down" size="small" class="shrink-0" />
          </Show>
        </ModelSelectorPopover>
        <Show when={modelIssue()}>
          <TooltipV2
            value={modelIssue()}
            placement="top"
            contentClass="max-w-[320px] text-11-regular"
          >
            <span
              role="img"
              tabIndex={0}
              class="text-11-regular px-1 outline-none"
              aria-label={modelIssue()}
              title={modelIssue()}
            >
              <span class={modelIssueIsError()
                ? "inline-block w-2 h-2 rounded-full bg-surface-critical-strong"
                : "inline-block w-2 h-2 rounded-full bg-surface-warning-strong"}
              />
            </span>
          </TooltipV2>
        </Show>
      </Show>

      {/* Config error — show when models failed to load entirely */}
      <Show when={selection().isHarnessMode && selection().configError && selection().models.length === 0}>
        <span
          class={
            optionsLoading()
              ? "text-11-regular text-text-weak px-1.5"
              : "text-11-regular text-text-on-critical-base px-1.5"
          }
        >
          {selection().configError}
        </span>
      </Show>
    </>
  )
}
