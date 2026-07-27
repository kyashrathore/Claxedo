import { Show, createEffect, createMemo, createSignal, onCleanup, untrack, type JSX } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { ClaxedoIcon as Icon } from "@/ui/controls/claxedo-icon"
import { ProviderIcon } from "@opencode-ai/ui/provider-icon"
import { Select } from "@opencode-ai/ui/select"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { ModelSelectorPopover, type PickerItem, type PickerState } from "@/features/session/ui/model/select-model"
import { COMPOSER_HARNESS_MENU_CLASS, COMPOSER_MENU_CLASS } from "@/features/session/composer/ui/menu-metrics"
import { HARNESS_DISPLAY_NAMES, type HarnessType } from "@/features/session/harness/profile"
import type { HarnessSelectionController } from "@/features/session/harness/controller"
import { shouldApplyHarnessSelection } from "./agent-harness-selection-guard"
import { watchHarnessReprobe } from "@/features/session/harness/harness-reprobe"
import { panePreferenceScope } from "@/features/session/preferences/pane"
import { createModelSelectionController, modelKeyFromPickerSelection } from "@/features/session/commands/model-selection"
import { loadConnectProviderDialog, useProviders } from "@/features/session/app-ports"
import type { ModelKey } from "@/features/session/composer/model-strategy"
import type { DraftDefaultLabels } from "@/features/session/harness/draft-defaults"
import { resolveDraftDefault as resolveDraftDefaultPolicy } from "@/features/session/harness/draft-default-policy"
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

function HarnessOptionIcon(props: { harness: HarnessType }) {
  if (props.harness === "claude-acp" || props.harness === "claude-sdk") {
    return <Icon name="claude" size="small" class="shrink-0" />
  }
  if (props.harness === "codex-acp" || props.harness === "codex-app-server") {
    return <Icon name="openai" size="small" class="shrink-0" />
  }
  if (props.harness === "cursor-acp" || props.harness === "cursor-sdk") {
    return <Icon name="cursor" size="small" class="shrink-0" />
  }
  if (props.harness === "opencode") {
    return <Icon name="opencode" size="small" class="shrink-0" />
  }
  return <Icon name="pi" size="small" class="shrink-0" />
}

type Item = {
  id: string
  name: string
  description?: string
  provider: {
    id: string
    name: string
  }
  connected?: boolean
}

interface AgentHarnessSelectorProps {
  triggerStyle?: JSX.CSSProperties
  /** When true, the current session already exists — harness cannot be changed. */
  sessionLocked?: boolean
  /** When true, Pi has admitted its first prompt and its model is immutable. */
  modelLocked?: boolean
  directory?: string
  sessionId?: string
  surfaceId?: string
  draftId?: string
  active?: boolean
  harnessController: HarnessSelectionController
  openCodeModel?: () => ModelKey | undefined
  openCodeModelLabels?: () => DraftDefaultLabels | undefined
}

export function AgentHarnessSelector(props: AgentHarnessSelectorProps) {
  const dialog = useDialog()
  let disposed = false
  onCleanup(() => {
    disposed = true
  })
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
  const piProviders = useProviders("pi")
  const piCatalog = createMemo(() => {
    const connected = new Set(piProviders.connected().map((provider) => provider.id))
    const rows = [...piProviders.all().values()].flatMap((provider) =>
      Object.values(provider.models).map((item) => ({
        id: item.id,
        name: item.name,
        provider: { id: provider.id, name: provider.name },
        connected: connected.has(provider.id),
      })),
    )
    return {
      connected,
      rows,
      eligibleModels: rows
        .filter((item) => item.connected)
        .map((item) => ({ providerID: item.provider.id, modelID: item.id })),
    }
  })
  createEffect(() => {
    const current = selection()
    if (current.draftDefaultState !== undefined) return
    if (current.harness === "pi") {
      if (piProviders.loading() || piProviders.error()) return
      const catalog = piCatalog()
      props.harnessController.resolveDraftDefault(scope(), {
        supportedHarnesses: HARNESS_OPTIONS,
        eligibleModels: catalog.eligibleModels,
        openCodeModel: props.openCodeModel?.(),
        connectedProviderIDs: [...catalog.connected],
        providerDefaults: piProviders.default(),
      })
      return
    }
  })
  // Pi single-model auto-pick. The draft-default policy above only runs off a
  // SAVED preference (`resolveCurrentDraftDefault` no-ops without a stored
  // `draftDefault.harness`), so a pi harness that arrived purely from hydration
  // (`applyStatus` sets `harness: "pi"` + a bare model id, but no provider —
  // the harness-config probe carries no `modelProviderID`) is left with no
  // resolvable `selectedModelKey`: `harnessModelKeyForSubmit` requires an
  // explicit pi provider (why `picked()` excludes pi from the bare-id
  // fallback), so Send stays `no-model`-blocked and a fresh pi draft can never
  // dispatch. When the catalog resolves to exactly one connected model, adopt
  // it WITH its catalog provider — supplying the provider `picked()` refuses to
  // guess, rather than relaxing that guard. Ambiguous (0 or >1) catalogs still
  // fall through to an explicit choice.
  createEffect(() => {
    if (harness() !== "pi") return
    if (props.modelLocked || sessionLocked()) return
    if (piProviders.loading() || piProviders.error()) return
    // Already submit-ready (auto-picked here, saved-default-resolved, or user-picked).
    if (selection().selectedModelKey || picked()) return
    // A saved-but-unavailable model owns the surface (shows its own error) — don't override it.
    if (selection().draftDefaultState === "saved-model-unavailable") return
    const connectedModels = piCatalog().rows.filter((row) => row.connected)
    if (connectedModels.length !== 1) return
    const only = connectedModels[0]
    const dir = directory()
    if (!dir) return
    void props.harnessController.setModel(
      scope(),
      { providerID: only.provider.id, modelID: only.id },
      { directory: dir, sessionId: sessionId() },
      { provider: only.provider.name, model: only.name },
    )
  })
  // A coarse boolean memo: only notifies when the polling boundary is crossed,
  // never on unrelated store writes. The re-probe effect below depends on this
  // (not a raw `selection().readiness` read) so a re-probe that re-applies the
  // SAME "polling" status cannot re-run the effect and reset the attempt cap.
  const isPolling = createMemo(() => selection().readiness === "polling")
  const isError = () => selection().readiness === "error"

  // Bounded re-probe for a harness stuck Connecting. Hydration is one-shot, so
  // without this a genuinely slow harness (`ready:false`/`status:"applying"`)
  // would poll forever. While polling, re-probe on an interval; if it never
  // settles, transition to the terminal "Unavailable" state. onCleanup cancels
  // the loop on settle or scope/route change.
  watchHarnessReprobe({
    active: () => {
      if (props.active === false) return false
      // Track scope/directory/session so a route change restarts with a fresh cap.
      const nextScope = scope()
      const nextDirectory = directory()
      sessionId()
      return !!nextScope && !!nextDirectory && isPolling()
    },
    // reprobe/onExhausted fire from the loop's timer callback, outside any
    // reactive computation, so these reads create no tracked dependencies.
    reprobe: () => {
      const nextDirectory = directory()
      if (!nextDirectory) return
      void props.harnessController.reprobe(scope(), {
        directory: nextDirectory,
        sessionId: sessionId(),
      })
    },
    onExhausted: () => props.harnessController.markUnavailable(scope()),
  })
  const isStale = () => selection().optionsStale
  const optionsLoading = () => selection().optionsLoading
  const [switchingHarness, setSwitchingHarness] = createSignal<HarnessType | undefined>()
  const harnessSwitching = () => !!switchingHarness()
  // Tracks whether the harness menu was actually opened before a value change
  // arrived, so a stray typeahead-while-closed keystroke cannot silently switch
  // the harness. Reset after each selection is evaluated.
  let openedViaMenu = false
  const rows = createMemo<Item[]>(() => {
    const currentHarness = harness()
    if (currentHarness === "pi") return piCatalog().rows
    return selection().models.map((item) => ({
      id: item.id,
      name: item.name,
      ...(item.description ? { description: item.description } : {}),
      provider: { id: item.providerID ?? currentHarness, name: label(item.providerID ?? currentHarness) },
      connected: true,
    }))
  })
  const picked = createMemo(() => {
    const selected = selection().selectedModelKey
    const next = rows().find((item) => item.id === selected?.modelID && item.provider.id === selected.providerID)
      ?? (harness() === "pi" ? undefined : rows().find((item) => item.id === selection().selectedModel))
    return next
  })
  const modelSelection = createMemo(() =>
    createModelSelectionController({
      write: (command) => {
        if (!command.model) return
        const hit = rows().find((item) => item.id === command.model?.modelID && item.provider.id === command.model.providerID)
        return props.harnessController.setModel(scope(), command.model, {
          directory: directory(),
          sessionId: sessionId(),
        }, hit ? { provider: hit.provider.name, model: hit.name } : undefined)
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
      const hit = rows().find((row) => row.id === modelKey.modelID && row.provider.id === modelKey.providerID)
      if (!hit) return
      if (harness() === "pi" && !hit.connected) {
        const intended = { providerID: hit.provider.id, modelID: hit.id }
        const intendedScope = scope()
        const intendedDirectory = directory()
        const intendedSession = sessionId()
        const intendedHarness = harness()
        void loadConnectProviderDialog().then((module) => {
          if (
            disposed ||
            intendedHarness !== "pi" ||
            harness() !== intendedHarness ||
            scope() !== intendedScope ||
            directory() !== intendedDirectory ||
            sessionId() !== intendedSession
          ) return
          dialog.show(() => (
            <module.DialogConnectProvider
              provider={hit.provider.id}
              harness="pi"
              onConnected={() => {
                if (
                  disposed ||
                  harness() !== intendedHarness ||
                  scope() !== intendedScope ||
                  directory() !== intendedDirectory ||
                  sessionId() !== intendedSession
                ) return
                if (!piProviders.connected().some((item) => item.id === intended.providerID)) return
                if (!piProviders.all().get(intended.providerID)?.models[intended.modelID]) return
                return props.harnessController.setModel(intendedScope, intended, {
                  directory: intendedDirectory,
                  sessionId: intendedSession,
                }, { provider: hit.provider.name, model: hit.name })
              }}
            />
          ))
        })
        return
      }
      void modelSelection().set({
        scope: {
          key: `harness:${scope()}`,
          current: () => {
            return selection().selectedModelKey
          },
        },
        model: { providerID: hit.provider.id, modelID: hit.id },
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
  const modelLoading = createMemo(() => harness() === "pi" ? piProviders.loading() : optionsLoading())
  const hasModelOptions = createMemo(() => {
    return rows().length > 0
  })
  const modelUnavailable = createMemo(() => {
    return !modelLoading() && !hasModelOptions()
  })
  const modelOptionsFailed = createMemo(() => harness() === "pi"
    ? !!piProviders.error() && !modelLoading()
    : !!selection().configError && isStale() && !optionsLoading())
  const modelDisabled = createMemo(() => {
    return (harness() === "pi" && !!props.modelLocked) || modelLoading() || isError() || modelUnavailable() || modelOptionsFailed()
  })
  const modelLabel = createMemo(() => {
    if (modelLoading()) return "Loading models"
    if (modelOptionsFailed()) return "Unavailable"
    if (picked()) return picked()?.name
    if (selection().draftDefaultState === "saved-model-unavailable") {
      return selection().draftDefaultLabels?.model ?? selection().selectedModel
    }
    if (harness() === "pi" && selection().selectedModel) return selection().selectedModel
    if (isError()) return "Unavailable"
    if (!hasModelOptions()) return harness() === "pi" ? "No Pi models available" : selection().configError ?? "Select model"
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
    class: "composer-harness-model min-w-0 max-w-[160px] max-md:max-w-[104px] text-13-regular group",
    "aria-label": "Select harness model",
    "data-action": "prompt-harness-model",
  }))
  const modelIssue = createMemo(() => {
    if (harness() === "pi" && piProviders.error()) return piProviders.error()
    if (harness() === "pi" && props.modelLocked) return "Start a new Pi session to choose a different model"
    if (selection().draftDefaultState === "saved-model-unavailable") {
      const name = selection().draftDefaultLabels?.model ?? selection().selectedModel
      return `${name || "Saved model"} is unavailable. Reconnect its provider or choose another model.`
    }
    if (harness() === "pi" && selection().selectedModel && !picked()) return "This Pi model is no longer available; choose another model"
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
        onOpenChange={(open) => {
          if (open) openedViaMenu = true
        }}
        onSelect={(r) => {
          const current = harness()
          const apply = shouldApplyHarnessSelection({
            next: r,
            current,
            disabled: harnessDisabled(),
            openedViaMenu,
          })
          openedViaMenu = false
          if (!apply || !r) return
          setSwitchingHarness(r)
          const switchScope = scope()
          const switchDirectory = directory()
          const switchSession = sessionId()
          void Promise.resolve(
            props.harnessController.setHarness(switchScope, r, {
              directory: switchDirectory,
              sessionId: switchSession,
            }),
          ).then(async () => {
            if (r === "opencode") {
              if (scope() !== switchScope || directory() !== switchDirectory || sessionId() !== switchSession) return
              if (selection().readiness === "error") return
              const model = props.openCodeModel?.()
              if (!model) return
              props.harnessController.rememberDraftModel(switchScope, model, {
                directory: switchDirectory,
                sessionId: switchSession,
              }, props.openCodeModelLabels?.())
              return
            }
            if (r !== "pi") return
            await piProviders.refresh()
            if (scope() !== switchScope || directory() !== switchDirectory || sessionId() !== switchSession) return
            if (piProviders.error()) return
            const catalog = piCatalog()
            const result = resolveDraftDefaultPolicy({
              saved: { harness: "pi" },
              supportedHarnesses: HARNESS_OPTIONS,
              eligibleModels: catalog.eligibleModels,
              openCodeModel: props.openCodeModel?.(),
              connectedProviderIDs: [...catalog.connected],
              providerDefaults: piProviders.default(),
            })
            if (!result.model) return
            return props.harnessController.setModel(switchScope, result.model, {
              directory: switchDirectory,
              sessionId: switchSession,
            }, (() => {
              const hit = catalog.rows.find((item) => item.provider.id === result.model?.providerID && item.id === result.model.modelID)
              return hit ? { provider: hit.provider.name, model: hit.name } : undefined
            })())
          }).finally(() => {
            setSwitchingHarness((current) => current === r ? undefined : current)
          })
        }}
        class="min-w-[112px] max-w-[140px] max-md:min-w-[104px] max-md:max-w-[112px]"
        valueClass={harnessDisabled() ? "truncate text-13-regular text-text-weak" : "truncate text-13-regular"}
        contentClass={COMPOSER_HARNESS_MENU_CLASS}
        triggerStyle={harnessTriggerStyle()}
        triggerProps={{ "data-action": "prompt-harness" }}
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
          // Same surface as the `+` menu and the context-row pickers it sits
          // beside. Without this the harness model popover opened at its own
          // width and row rhythm — and harness mode is the DEFAULT, so this was
          // the most visible instance of the inconsistency, not an edge case.
          contentClass={COMPOSER_MENU_CLASS}
          actions={harness() === "pi"}
          connectHarness={harness() === "pi" ? "pi" : undefined}
          tooltips={false}
          triggerAs={Button}
          triggerProps={modelTriggerProps()}
        >
          <Icon name="brain" size="small" class="composer-compact-only shrink-0 text-v2-icon-icon-base" />
          <Show when={picked()?.provider.id && !modelUnavailable() && !modelOptionsFailed()}>
            <ProviderIcon
              id={picked()!.provider.id}
              class="composer-model-provider size-4 shrink-0 opacity-40 group-hover:opacity-100 transition-opacity duration-150"
            />
          </Show>
          <span
            data-slot="composer-control-label"
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
        <Show when={modelOptionsFailed()}>
          <Button
            variant="ghost"
            size="normal"
            aria-label={harness() === "pi" ? "Retry loading Pi models" : "Retry loading harness models"}
            onClick={() => {
              if (harness() === "pi") {
                void piProviders.refresh()
                return
              }
              void props.harnessController.reprobe(scope(), {
                directory: directory(),
                sessionId: sessionId(),
              })
            }}
          >
            Retry
          </Button>
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
