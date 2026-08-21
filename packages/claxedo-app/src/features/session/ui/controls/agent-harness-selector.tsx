import { Show, createEffect, createMemo, createSignal, onCleanup, untrack, type JSX } from "solid-js"
import { ClaxedoIcon as Icon } from "@/ui/controls/claxedo-icon"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { type PickerItem, type PickerState } from "@/features/session/ui/model/select-model"
import { HarnessModelPicker } from "@/features/session/composer/ui/harness-model-picker"
import { publishComposerNotice, type ComposerNotice } from "@/features/session/composer/ui/composer-notice"
import { resolveHarnessNotice } from "@/features/session/composer/ui/harness-notice"
import { HARNESS_DISPLAY_NAMES, harnessDisplayLabel, type HarnessType } from "@/features/session/harness/profile"
import { isAcpConnectionHarnessId } from "@/platform/identity/session-ref"
import type { HarnessSelectionController } from "@/features/session/harness/controller"
import type { SessionRef } from "@/platform/identity/session-ref"
import { shouldApplyHarnessSelection } from "./agent-harness-selection-guard"
import { watchHarnessReprobe } from "@/features/session/harness/harness-reprobe"
import { panePreferenceScope } from "@/features/session/preferences/pane"
import { createModelSelectionController, modelKeyFromPickerSelection } from "@/features/session/commands/model-selection"
import { loadConnectProviderDialog, useProviders } from "@/features/session/app-ports"
import type { ModelKey } from "@/features/session/composer/model-strategy"
import type { DraftDefaultLabels } from "@/features/session/harness/draft-defaults"
import { resolveDraftDefault as resolveDraftDefaultPolicy } from "@/features/session/harness/draft-default-policy"
import { capture as phCapture, identityProps } from "@/platform/telemetry/analytics"
// The static picker portion: the finite built-ins. Claude, Codex, and Cursor
// appear once each (Native SDK); the ACP group is no longer a hard-coded
// vendor trio — it is populated from the server's sanitized discovery rows
// (operator-configured connections), so adding another ACP agent changes the
// picker without changing app source. Historical first-party ACP sessions
// still decode and display; they are just not offered for NEW sessions.
const BUILTIN_HARNESS_OPTIONS: HarnessType[] = ["claude-sdk", "codex-app-server", "cursor-sdk", "pi", "opencode"]
const HARNESS_OPTION_LABELS: Partial<Record<HarnessType, string>> = {
  "claude-sdk": "Claude",
  "codex-app-server": "Codex",
  "cursor-sdk": "Cursor",
}

function label(input: string) {
  return HARNESS_DISPLAY_NAMES[input] ?? harnessDisplayLabel(input)
}

function harnessOptionGroup(input: HarnessType) {
  if (isAcpConnectionHarnessId(input)) return "ACP"
  if (input === "claude-acp" || input === "codex-acp" || input === "cursor-acp") return "ACP"
  if (input === "claude-sdk" || input === "codex-app-server" || input === "cursor-sdk") return "Native SDK"
  return "Direct"
}

function HarnessOptionIcon(props: { harness: HarnessType }) {
  if (isAcpConnectionHarnessId(props.harness)) {
    // Operator-configured connections carry no vendor mark; a neutral terminal
    // glyph says "an agent process you configured".
    return <Icon name="terminal-square" size="small" class="shrink-0" />
  }
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

/*
 * Icon markup belongs in MENU ROWS, never a Kobalte Select trigger.
 *
 * Kobalte names its Select trigger with `aria-labelledby` pointing at the
 * value span. With a plain string in there Chrome resolves that reference and
 * the button is named "Claude"; with icon markup in there it marks the
 * reference INVALID and computes an empty name (verified against the running
 * app through CDP's `Accessibility.getPartialAXTree`, and visible as an axe
 * `aria-command-name` violation plus a `getByRole("button", { name: /^Claude$/ })`
 * that matched nothing). The current HarnessModelPicker trigger is a Popover
 * with an explicit `aria-label`, which is why it may carry the harness mark.
 * This note outlived the Select renderer it used to sit on because the icon
 * has been put back in a trigger's value renderer twice already.
 */

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
  sessionRef?: SessionRef
  surfaceId?: string
  draftId?: string
  active?: boolean
  harnessController: HarnessSelectionController
  openCodeModel?: () => ModelKey | undefined
  openCodeModelLabels?: () => DraftDefaultLabels | undefined
  /**
   * opencode's model state, supplied by the composer toolbar. Both modes speak
   * `PickerState` — the ONLY difference is who builds it, so the merged picker
   * just chooses a source rather than adapting between two shapes.
   */
  openCode?: {
    model: () => PickerState
    label: () => string
    loading: () => boolean
    showVariantSelector: () => boolean
    variants: () => string[]
    currentVariant: () => string | undefined
    variantLabel: (value: string) => string
    onVariantSelect: (value: string) => void
  }
}

export function AgentHarnessSelector(props: AgentHarnessSelectorProps) {
  const dialog = useDialog()
  // The picker's harness list: static built-ins plus the ENABLED operator ACP
  // connections from server discovery. A selected-but-no-longer-listed key
  // still renders in the trigger via its label fallback; it is simply not
  // offered for new sessions.
  const harnessOptions = createMemo<HarnessType[]>(() => [
    ...BUILTIN_HARNESS_OPTIONS,
    ...props.harnessController.enabledAcpConnections().map((row) => row.key),
  ])
  const harnessOptionLabel = (input: HarnessType) => {
    if (isAcpConnectionHarnessId(input)) {
      return props.harnessController.acpConnectionLabel(input) ?? harnessDisplayLabel(input)
    }
    return HARNESS_OPTION_LABELS[input] ?? label(input)
  }
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
      void props.harnessController.refreshAcpConnections()
      void props.harnessController.hydrate(nextScope, {
        directory: nextDirectory,
        sessionId: nextSessionId,
        sessionRef: props.sessionRef,
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
        supportedHarnesses: harnessOptions(),
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
  // Names a model, or says there is none — never reports an error. Failures are
  // the notice row's job, and this control used to duplicate its wording
  // ("Unavailable" here AND in the readiness pill AND in the dot's tooltip).
  const modelLabel = createMemo(() => {
    if (modelLoading()) return "Loading models"
    if (picked()) return picked()?.name
    if (selection().draftDefaultState === "saved-model-unavailable") {
      return selection().draftDefaultLabels?.model ?? selection().selectedModel
    }
    if (harness() === "pi" && selection().selectedModel) return selection().selectedModel
    if (!hasModelOptions()) return harness() === "pi" ? "No Pi models available" : "Select model"
    return selection().selectedModel || "Select model"
  })
  const modelTriggerStyle = createMemo(() => {
    const next = style(modelDisabled())
    return next
  })
  // Soft, non-actionable reasons the control itself is inert. These stay ON the
  // control they explain instead of becoming a fifth widget beside it — and they
  // never escalate to the notice row, which is reserved for things that broke.
  const modelHint = createMemo(() => {
    if (harness() === "pi" && props.modelLocked) return "Start a new Pi session to choose a different model"
    if (isStale() && !modelOptionsFailed()) return "Model list may be outdated"
  })
  const modelTriggerProps = createMemo(() => ({
    variant: "ghost" as const,
    size: "normal" as const,
    disabled: modelDisabled(),
    style: modelTriggerStyle(),
    // `composer-harness-model` is styling from the icon work; the modelHint
    // aria-label/title are the concurrent session's — it names WHICH model, which
    // is strictly better than the bare label, so both sides are kept.
    class: "composer-harness-model min-w-0 max-w-[160px] max-md:max-w-[104px] text-13-regular group",
    "aria-label": modelHint() ? `Select harness model — ${modelHint()}` : "Select harness model",
    ...(modelHint() ? { title: modelHint()! } : {}),
    "data-action": "prompt-harness-model",
    "data-harness": selection().harness,
    "data-model": selection().selectedModel,
    "data-provider": selection().selectedModelProvider,
    "data-readiness": selection().readiness,
    "data-ready-for-submit": selection().selectedModelKey ? "true" : "false",
  }))

  // One row, one message, one action — see `harness-notice.ts` for the ordering.
  const notice = createMemo<ComposerNotice | undefined>(() => {
    // A backgrounded pane must not publish over the visible one, and opencode
    // mode is served by `PromptModelControl` — neither owns this row.
    if (props.active === false || !selection().isHarnessMode) return undefined
    const resolved = resolveHarnessNotice({
      harnessLabel: harnessOptionLabel(harness()),
      runtimeUnavailable: isError(),
      optionsFailed: modelOptionsFailed(),
      noModels: !hasModelOptions() && !modelLoading(),
      configError: selection().configError,
      providerError: harness() === "pi" ? piProviders.error() : undefined,
      savedModelUnavailable:
        selection().draftDefaultState === "saved-model-unavailable"
          ? selection().draftDefaultLabels?.model || selection().selectedModel || "Saved model"
          : undefined,
      piModelMissing: harness() === "pi" && !!selection().selectedModel && !picked(),
    })
    if (!resolved) return undefined
    const { retry, ...rest } = resolved
    if (!retry) return rest
    return {
      ...rest,
      action: {
        label: "Retry",
        ariaLabel: harness() === "pi" ? "Retry loading Pi models" : "Retry loading harness models",
        run: () => {
          if (harness() === "pi") {
            void piProviders.refresh()
            return
          }
          void props.harnessController.reprobe(scope(), {
            directory: directory(),
            sessionId: sessionId(),
          })
        },
      },
    }
  })
  // Extracted from the old Kobalte `Select`'s inline `onSelect` so the merged
  // picker can call the same side effects. `openedViaMenu` existed because
  // Kobalte re-fires onChange with the CURRENT value when its options
  // collection changes identity; the picker only ever calls this from a real
  // click, so intent is passed explicitly.
  const applyHarness = (r: HarnessType | undefined) => {
    openedViaMenu = true
          const current = harness()
          const apply = shouldApplyHarnessSelection({
            next: r,
            current,
            disabled: harnessDisabled(),
            openedViaMenu,
          })
          openedViaMenu = false
          if (!apply || !r) return
          phCapture("harness_selected", { ...identityProps(), surface: "composer", harness: r })
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
              supportedHarnesses: harnessOptions(),
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
  }

  // Harness mode builds its own PickerState from `rows()`; opencode mode is
  // handed one by the toolbar. Same shape, so this is a source switch.
  const isHarnessMode = createMemo(() => selection().isHarnessMode)
  const activePicker = createMemo<PickerState>(() =>
    isHarnessMode() ? model() : props.openCode?.model() ?? model())
  const activeModelLabel = createMemo(
    () => (isHarnessMode() ? modelLabel() : props.openCode?.label()) || "Select model")
  // Effort resolves from whichever side owns the model list. Both end up on the
  // SAME wire field — `ModelKey.variant` → `PromptInput.variant` — because a
  // harness turn is one `query()` and the SDK takes `effort` per query, exactly
  // as opencode takes a variant per prompt. One channel, two sources.
  const harnessThoughtLevels = createMemo(() => selection().thoughtLevels ?? [])
  const activeShowEffort = createMemo(() =>
    isHarnessMode() ? harnessThoughtLevels().length > 1 : (props.openCode?.showVariantSelector() ?? false))
  const activeVariants = createMemo(() =>
    isHarnessMode() ? harnessThoughtLevels().map((item) => item.id) : (props.openCode?.variants() ?? []))
  const activeCurrentVariant = createMemo(() =>
    isHarnessMode() ? selection().selectedThoughtLevel : props.openCode?.currentVariant())
  const harnessLevelName = (value: string) =>
    harnessThoughtLevels().find((item) => item.id === value)?.name ?? value

  const activeModelLoading = createMemo(() =>
    (isHarnessMode() ? modelLoading() : props.openCode?.loading() ?? false) || harnessSwitching())
  const activeModelDisabled = createMemo(() => {
    if (isHarnessMode()) return modelDisabled()
    return activeModelLoading() || (props.openCode?.model().list().length ?? 0) === 0
  })

  publishComposerNotice(notice)

  return (
    <>
      {/* ONE control for the three questions that are really one decision:
          harness → model → effort. See harness-model-picker.tsx. The trigger
          keeps the harness mark AND the model name, so a live session still
          states which harness it is on without spending a second chip on it.

          Safe to put an icon in THIS trigger, unlike the Select it replaces:
          Kobalte's Select names its trigger via `aria-labelledby` pointing at
          the value span, which markup invalidates (see the note above the Item
          type). This is a Popover trigger with an explicit `aria-label`. */}
      <HarnessModelPicker
        harness={harness}
        harnessOptions={harnessOptions()}
        harnessLabel={harnessOptionLabel}
        harnessGroup={harnessOptionGroup}
        harnessDisabled={harnessDisabled}
        harnessHint={() => (sessionLocked() ? "Start a new session to change harness" : undefined)}
        harnessIcon={(option) => <HarnessOptionIcon harness={option} />}
        onHarnessSelect={applyHarness}
        showManageModels={() => harness() === "opencode" || harness() === "pi"}
        modelError={() => {
          // The SAME resolved notice the composer row shows, rendered inside
          // the Model section too. The row explains the failure globally; the
          // section REPLACES the list, because a working search box over zero
          // rows claims "this harness has no models" when the truth is that
          // loading them failed. Only list-invalidating failures qualify — a
          // merely stale list still has usable rows and stays a hint.
          const failure = notice()
          if (!failure || failure.tone !== "critical") return undefined
          return {
            message: failure.message,
            ...(failure.detail ? { detail: failure.detail } : {}),
            ...(failure.action ? { action: { label: failure.action.label, run: failure.action.run } } : {}),
          }
        }}
        model={activePicker}
        modelLabel={activeModelLabel}
        modelLoading={activeModelLoading}
        modelDisabled={activeModelDisabled}
        showEffort={activeShowEffort}
        variants={activeVariants}
        currentVariant={activeCurrentVariant}
        variantLabel={(value) => isHarnessMode() ? harnessLevelName(value) : (props.openCode?.variantLabel(value) ?? value)}
        onVariantSelect={(value) => {
          if (isHarnessMode()) {
            props.harnessController.setThoughtLevel(scope(), value === "default" ? undefined : value)
            return
          }
          props.openCode?.onVariantSelect(value)
        }}
        triggerStyle={() => style(activeModelDisabled())}
        triggerHint={modelHint}
        triggerLabel={modelHint() ? `Select harness and model — ${modelHint()}` : "Select harness and model"}
        triggerState={() => ({
          harness: selection().harness,
          model: selection().selectedModel,
          provider: selection().selectedModelProvider,
          readiness: selection().readiness,
          readyForSubmit: !!selection().selectedModelKey,
        })}
      />

      {/* Readiness indicator. Connecting is progress, not a fault, so it stays
          inline; the settled failure it can escalate into is published to the
          composer notice row instead. */}
      <Show when={isPolling()}>
        <span class="text-11-regular text-text-weak px-1.5 flex items-center" title="Connecting to agent runtime...">
          <span class="inline-block w-2 h-2 rounded-full bg-text-weak animate-pulse mr-1" />
          Connecting
        </span>
      </Show>
    </>
  )
}
