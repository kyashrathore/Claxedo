import { resolveDraftDefault as resolveDraftDefaultPolicy } from "../harness/draft-default-policy"
import { Show, createEffect, createMemo, createResource, createSignal, untrack, type JSX } from "solid-js"
import { useNavigate } from "@solidjs/router"
import { useServer } from "@/server"
import { settingsPath } from "@/shell"
import { ClaxedoIcon as Icon } from "@/ui"
import type { PickerState } from "./model-list"
import { HarnessModelPicker } from "./harness-model-picker"
import { publishComposerNotice, type ComposerNotice } from "./composer-notice"
import { resolveHarnessNotice } from "./harness-notice"
import { catalogHarnessId, harnessDisplayLabel, harnessModelPickerProvider, harnessSelectionId, isCatalogHarness, isNativeHarness, type HarnessType } from "../harness/profile"
import { connectionAllowsNoModel } from "../harness/selection"
import type { HarnessScopeInput, HarnessSelectionController } from "../harness/controller"
import { shouldApplyHarnessSelection } from "./agent-harness-selection-guard"
import { watchHarnessReprobe } from "../harness/harness-reprobe"
import {
  createModelSelectionController,
  modelKeyFromPickerSelection,
} from "../harness/model-selection"
import { modelGroupKey, useModelVisibility } from "../harness/model-visibility"
import { createProviderCatalog, hydrateConnectedProviderDetails } from "../harness/provider-catalog"
import {
  NATIVE_HARNESS_IDS,
  connectionHarness,
  nativeHarness,
  sameHarnessSelection,
} from "@/lib/harness-selection"
import { createHarnessConnectionsCatalog } from "../harness/connection-catalog"
const BUILTIN_HARNESS_OPTIONS: HarnessType[] = NATIVE_HARNESS_IDS.map(nativeHarness)

function harnessOptionGroup(input: HarnessType) {
  return input.kind === "native" ? "Native SDK" : "Connections"
}

function HarnessOptionIcon(props: { harness?: HarnessType }) {
  if (!props.harness) return <Icon name="plus" size="small" class="shrink-0" />
  if (isNativeHarness(props.harness, "claude")) {
    return <Icon name="claude" size="small" class="shrink-0" />
  }
  if (isNativeHarness(props.harness, "codex")) {
    return <Icon name="openai" size="small" class="shrink-0" />
  }
  if (isNativeHarness(props.harness, "cursor")) {
    return <Icon name="cursor" size="small" class="shrink-0" />
  }
  return <Icon name="pi" size="small" class="shrink-0" />
}

/*
 * Icon markup belongs in menu rows, never a Kobalte Select trigger.
 *
 * Kobalte names its Select trigger with `aria-labelledby` pointing at the
 * value span. With a plain string in there Chrome resolves that reference and
 * the button is named "Claude"; with icon markup in there it marks the
 * reference invalid and computes an empty accessible name. The current
 * HarnessModelPicker trigger is a Popover with an explicit `aria-label`,
 * which is why it may carry the harness mark instead.
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
  /** Whether the current session already exists. Existing sessions hand off through session config. */
  sessionLocked?: boolean
  /** The composer's key: the harness store files this pane's selection under it. */
  scope: string
  scopeInput: HarnessScopeInput
  active?: boolean
  harnessController: HarnessSelectionController
}

export function AgentHarnessSelector(props: AgentHarnessSelectorProps) {
  const navigate = useNavigate()
  const server = useServer()
  const connections = createHarnessConnectionsCatalog({ api: server.harnessConfig })
  const connectionRows = createMemo(() => {
    const catalog = connections.data()
    return catalog?.status === "supported" ? catalog.connections : []
  })
  createEffect(() => {
    if (props.active === false) return
    void connections.refresh()
  })
  const harnessOptions = createMemo<HarnessType[]>(() => [
    ...BUILTIN_HARNESS_OPTIONS,
    ...connectionRows()
      .filter((row) => row.enabled)
      .map((row) => connectionHarness(row.connectionId)),
  ])
  const harnessOptionLabel = (input: HarnessType) => {
    if (input.kind === "connection")
      return (
        connectionRows().find((row) => row.connectionId === input.connectionId)?.label ??
        harnessDisplayLabel(input.connectionId)
      )
    return harnessDisplayLabel(input.harnessId)
  }
  const scopeInput = createMemo(() => props.scopeInput)
  const placementId = createMemo(() => scopeInput().placementId)
  const sessionId = createMemo(() => scopeInput().sessionId)
  const sessionLocked = createMemo(() => {
    const next = !!props.sessionLocked
    return next
  })
  const scope = createMemo(() => props.scope)

  createEffect(() => {
    const nextScope = scope()
    const nextInput = scopeInput()
    if (props.active === false) {
      return
    }
    if (!nextInput.placementId) {
      return
    }
    untrack(() => {
      void props.harnessController.hydrate(nextScope, nextInput)
    })
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
  const connectionDeclaration = createMemo(() => {
    const harness = selection().harness
    return harness?.kind === "connection" ? connectionRows().find((row) => row.connectionId === harness.connectionId) : undefined
  })
  createEffect(() => props.harnessController.setConnectionDeclaration?.(scope(), connectionDeclaration()))
  const harness = createMemo(() => {
    return selection().harness
  })
  // The provider catalog used by the embedded OpenCode SDK.
  // Keyed per harness id, so switching between catalog harnesses re-reads the
  // right catalog; an empty id disables the query while no catalog harness is
  // selected, so a Claude or connection draft never fetches a catalog.
  const visibility = useModelVisibility()
  const catalogProviders = createProviderCatalog({ server, harness: () => catalogHarnessId(harness()) ?? "" })
  const catalogRows = createMemo(() => {
    const connected = new Set(catalogProviders.connected().map((provider) => provider.id))
    const rows = [...catalogProviders.all().values()].flatMap((provider) =>
      Object.values(provider.models).map((item) => ({
        id: item.id,
        name: item.name,
        provider: { id: provider.id, name: provider.name },
        connected: item.connected,
        free: item.free,
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
  // A catalog restored from storage keeps only each connected provider's
  // default model, so its rows, effort levels and draft-default answer are
  // wrong until every connected provider's detail has been merged back in.
  const catalogHydrationKey = () => JSON.stringify([
    catalogProviders.queryKey(),
    catalogProviders.connected().map((provider) => provider.id).sort(),
  ])
  const catalogAnswered = () =>
    !!catalogHarnessId(harness())
    && catalogProviders.resolved()
    && !catalogProviders.loading()
    && !catalogProviders.error()
  const [hydratedCatalog] = createResource(
    () => catalogAnswered() && catalogHydrationKey(),
    async (key) => {
      await hydrateConnectedProviderDetails(catalogProviders)
      return key
    },
  )
  const catalogReady = () => catalogAnswered() && hydratedCatalog.latest === catalogHydrationKey()
  createEffect(() => {
    const current = selection()
    if (current.draftDefaultState !== undefined) return
    if (current.harness && isCatalogHarness(current.harness)) {
      if (!catalogReady()) return
      const catalog = catalogRows()
      props.harnessController.resolveDraftDefault(scope(), {
        supportedHarnesses: harnessOptions(),
        eligibleModels: catalog.eligibleModels,
        connectedProviderIDs: [...catalog.connected],
        providerDefaults: catalogProviders.default(),
      })
      return
    }
  })
  // The retained OpenCode catalog admission owner accounts for the remaining
  // picker effect-state write in the architecture baseline (91 total).
  // Adopt a sole connected catalog model with its authoritative provider id.
  createEffect(() => {
    const currentHarness = harness()
    if (!currentHarness || !isCatalogHarness(currentHarness)) return
    if (sessionLocked()) return
    if (!catalogReady()) return
    // Already submit-ready (auto-picked here, saved-default-resolved, or user-picked).
    if (selection().selectedModelKey || picked()) return
    // A saved-but-unavailable model owns the surface (shows its own error) — don't override it.
    if (selection().draftDefaultState === "saved-model-unavailable") return
    const connectedModels = catalogRows().rows.filter((row) => row.connected)
    if (connectedModels.length !== 1) return
    const only = connectedModels[0]
    if (!placementId()) return
    void props.harnessController.setModel(
      scope(),
      { providerID: only.provider.id, modelID: only.id },
      scopeInput(),
      { provider: only.provider.name, model: only.name },
    )
  })
  // A coarse boolean memo: only notifies when the polling boundary is crossed,
  // never on unrelated store writes. The re-probe effect below depends on this
  // (not a raw `selection().readiness` read) so a re-probe that re-applies the
  // same "polling" status cannot re-run the effect and reset the attempt cap.
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
      // Track scope/placement/session so a route change restarts with a fresh cap.
      const nextScope = scope()
      const nextPlacement = placementId()
      sessionId()
      return !!nextScope && !!nextPlacement && isPolling()
    },
    // reprobe/onExhausted fire from the loop's timer callback, outside any
    // reactive computation, so these reads create no tracked dependencies.
    reprobe: () => {
      if (!placementId()) return
      void props.harnessController.reprobe(scope(), scopeInput())
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
    if (!currentHarness) return []
    const defaults = catalogProviders.default()
    if (isCatalogHarness(currentHarness)) return catalogRows().rows.filter((item) => visibility.visible({ providerId: item.provider.id, modelId: item.id }, { defaults, group: item.provider.id }))
    const selectedId = selection().selectedModel
    return selection().models.flatMap((item) => {
      const provider = harnessModelPickerProvider(currentHarness, item)
      if (item.id !== selectedId && !visibility.visible({ providerId: provider.id, modelId: item.id }, { defaults, group: modelGroupKey(provider.id, item.id) })) return []
      return [{
        id: item.id,
        name: item.name,
        ...(item.description ? { description: item.description } : {}),
        provider,
        ...(typeof item.connected === "boolean" ? { connected: item.connected } : {}),
      }]
    })
  })
  const picked = createMemo(() => {
    const selected = selection().selectedModelKey
    const next = rows().find((item) => item.id === selected?.modelID && item.provider.id === selected.providerID)
      ?? (harness() && isCatalogHarness(harness()) ? undefined : rows().find((item) => item.id === selection().selectedModel))
    return next
  })
  const modelSelection = createMemo(() =>
    createModelSelectionController({
      write: (command) => {
        if (!command.model) return undefined
        const hit = rows().find(
          (item) => item.id === command.model?.modelID && item.provider.id === command.model.providerID,
        )
        // A catalog model's levels are its own: one the new model lacks must
        // not ride the next prompt behind a control that no longer offers it.
        const level = selection().selectedThoughtLevel
        if (catalogSelected() && level && !catalogVariants(command.model).includes(level)) {
          props.harnessController.setThoughtLevel(scope(), undefined)
        }
        return props.harnessController.setModel(
          scope(),
          command.model,
          scopeInput(),
          hit ? { provider: hit.provider.name, model: hit.name } : undefined,
        )
      },
    }),
  )
  const openProviders = () => {
    navigate(settingsPath("models"))
  }
  const model = createMemo<PickerState>(() => ({
    list: rows,
    current: picked,
    set: (item, options) => {
      const modelKey = modelKeyFromPickerSelection(item)
      if (!modelKey) return
      const hit = rows().find((row) => row.id === modelKey.modelID && row.provider.id === modelKey.providerID)
      if (!hit) return
      if (hit.connected === false) {
        openProviders()
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

  const harnessDisabled = createMemo(() => isPolling() || harnessSwitching())
  const modelLoading = createMemo(() => harness() && isCatalogHarness(harness()) ? catalogProviders.loading() : optionsLoading())
  const hasModelOptions = createMemo(() => {
    return rows().length > 0
  })
  const managedDefaultModel = createMemo(() =>
    connectionAllowsNoModel({
      connectionDeclaration: connectionDeclaration(),
      harness: selection().harness,
      selectedModel: selection().selectedModel,
      dynamicModels: selection().models,
      readiness: selection().readiness,
      optionsLoading: selection().optionsLoading,
      configError: selection().configError,
      selectedThoughtLevel: selection().selectedThoughtLevel,
    }),
  )
  const modelUnavailable = createMemo(() => {
    return !modelLoading() && !hasModelOptions() && !managedDefaultModel()
  })
  const modelOptionsFailed = createMemo(() => {
    if (harness() && isCatalogHarness(harness())) return !!catalogProviders.error() && !modelLoading()
    const error = selection().configError
    if (!error || error === "Loading model options..." || error === "Selected model unavailable") return false
    return !optionsLoading() && !hasModelOptions()
  })
  const modelDisabled = createMemo(() => {
    return !harness() || managedDefaultModel() || modelLoading() || isError() || modelUnavailable() || modelOptionsFailed()
  })
  // Names a model, or says there is none — never reports an error. Failures are
  // the notice row's job: duplicating "Unavailable" here, in the readiness
  // pill, and in the dot's tooltip would say the same thing three times.
  const modelLabel = createMemo(() => {
    if (isPolling()) return "Connecting"
    if (modelLoading()) return "Loading models"
    if (picked()) return picked()?.name
    if (selection().draftDefaultState === "saved-model-unavailable") {
      return selection().draftDefaultLabels?.model ?? selection().selectedModel
    }
    if (managedDefaultModel()) return `${harnessOptionLabel(harness()!)} default`
    if (!harness()) return "Select agent"
    if (isCatalogHarness(harness()) && selection().selectedModel) return selection().selectedModel
    if (!hasModelOptions()) return isCatalogHarness(harness()) ? `No ${harnessDisplayLabel(harnessSelectionId(harness()!))} models available` : "Select model"
    return selection().selectedModel || "Select model"
  })
  // Soft, non-actionable reasons the control itself is inert. These stay on the
  // control they explain instead of becoming a fifth widget beside it — and they
  // never escalate to the notice row, which is reserved for things that broke.
  const modelHint = createMemo(() => {
    if (managedDefaultModel() && harness()) return `Model is managed by ${harnessOptionLabel(harness()!)}`
    if (isStale() && !modelOptionsFailed()) return "Model list may be outdated"
    return undefined
  })

  // One row, one message, one action — see `harness-notice.ts` for the ordering.
  const needsProviderSetup = createMemo(() => {
    if (modelOptionsFailed()) return false
    if (harness() && isCatalogHarness(harness())) {
      return !catalogProviders.loading() && !catalogProviders.error() && catalogRows().rows.length === 0
    }
    return !managedDefaultModel() && !modelLoading() && !hasModelOptions() && !isPolling() && !isError()
  })
  const notice = createMemo<ComposerNotice | undefined>(() => {
    // A backgrounded pane must not publish over the visible one.
    if (props.active === false || !selection().isHarnessMode) return undefined
    const resolved = resolveHarnessNotice({
      harnessLabel: harness() ? harnessOptionLabel(harness()!) : "Agent",
      runtimeUnavailable: isError(),
      connectionState: selection().connectionState,
      optionsFailed: modelOptionsFailed(),
      noModels: !hasModelOptions() && !modelLoading(),
      configError: (harness() && isCatalogHarness(harness()) ? catalogProviders.error() : undefined) ?? selection().configError,
      savedModelUnavailable:
        selection().draftDefaultState === "saved-model-unavailable"
          ? selection().draftDefaultLabels?.model || selection().selectedModel || "Saved model"
          : harness() && isCatalogHarness(harness()) && selection().selectedModel && !picked()
            ? selection().selectedModel
            : undefined,
      setupRequired: needsProviderSetup(),
      openProviders,
    })
    if (!resolved) return undefined
    const { retry, action, ...rest } = resolved
    if (action) return { ...rest, action }
    if (!retry) return rest
    return {
      ...rest,
      action: {
        label: "Retry",
        ariaLabel: harness() && isCatalogHarness(harness()) ? `Retry loading ${harnessDisplayLabel(harnessSelectionId(harness()!))} models` : "Retry loading harness models",
        run: () => {
          if (harness() && isCatalogHarness(harness())) {
            void catalogProviders.refresh()
            return
          }
          void props.harnessController.reprobe(scope(), scopeInput())
        },
      },
    }
  })
  // Extracted from the old Kobalte `Select`'s inline `onSelect` so the merged
  // picker can call the same side effects. `openedViaMenu` existed because
  // Kobalte re-fires onChange with the current value when its options
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
          setSwitchingHarness(r)
          const switchScope = scope()
          const switchInput = scopeInput()
          void Promise.resolve(
            props.harnessController.setHarness(switchScope, r, switchInput),
          ).then(async () => {
            if (!isCatalogHarness(r)) return undefined
            await catalogProviders.refresh()
            if (scope() !== switchScope || scopeInput() !== switchInput) return undefined
            if (catalogProviders.error()) return undefined
            const catalog = catalogRows()
            const result = resolveDraftDefaultPolicy({
              saved: { harness: r },
              supportedHarnesses: harnessOptions(),
              eligibleModels: catalog.eligibleModels,
              connectedProviderIDs: [...catalog.connected],
              providerDefaults: catalogProviders.default(),
            })
            if (!result.model) return undefined
            return props.harnessController.setModel(switchScope, result.model, switchInput, (() => {
              const hit = catalog.rows.find((item) => item.provider.id === result.model?.providerID && item.id === result.model.modelID)
              return hit ? { provider: hit.provider.name, model: hit.name } : undefined
            })())
          }).finally(() => {
            setSwitchingHarness((current) => sameHarnessSelection(current, r) ? undefined : current)
          })
  }

  const activePicker = model
  const activeModelLabel = createMemo(() => modelLabel() || "Select model")
  const harnessThoughtLevels = createMemo(() => selection().thoughtLevels ?? [])
  const catalogSelected = createMemo(() => !!harness() && isCatalogHarness(harness()))
  // A catalog harness's levels are the engine variants its catalog carries for
  // the selected model; "default" (no variant) leads them.
  const catalogVariants = (model: { providerID?: string; modelID?: string }) => {
    const provider = model.providerID ? catalogProviders.all().get(model.providerID) : undefined
    const row = Object.values(provider?.models ?? {}).find((item) => item.id === model.modelID)
    return Object.keys(row?.variants ?? {})
  }
  const activeVariants = createMemo(() => {
    if (!catalogSelected()) return harnessThoughtLevels().map((item) => item.id)
    const variants = catalogVariants({ providerID: selection().selectedModelProvider, modelID: selection().selectedModel })
    return variants.length ? ["default", ...variants] : []
  })
  const activeShowEffort = createMemo(() => activeVariants().length > 1)
  const activeCurrentVariant = createMemo(() => selection().selectedThoughtLevel)
  const harnessLevelName = (value: string) =>
    harnessThoughtLevels().find((item) => item.id === value)?.name ?? value
  // One toggle, so the model's first faster tier is "fast". Codex reports
  // exactly one (`priority`, "Fast") on every model that has any.
  const fastTier = createMemo(() => (catalogSelected() ? undefined : selection().serviceTiers[0]))
  const fastControl = createMemo(() => {
    const tier = fastTier()
    if (!tier) return undefined
    return {
      on: selection().selectedServiceTier === tier.id,
      label: tier.name,
      ...(tier.description ? { description: tier.description } : {}),
    }
  })

  const activeModelLoading = createMemo(() => modelLoading() || harnessSwitching())
  const activeModelDisabled = modelDisabled

  publishComposerNotice(notice)

  return (
    <>
      {/* One control for the three questions that are really one decision:
          harness → model → effort. See harness-model-picker.tsx. The trigger
          keeps the harness mark and the model name, so a live session still
          states which harness it is on without spending a second chip on it.

          Safe to put an icon in this trigger, unlike the Select it replaces:
          Kobalte's Select names its trigger via `aria-labelledby` pointing at
          the value span, which markup invalidates (see the note above the Item
          type). This is a Popover trigger with an explicit `aria-label`. */}
      <HarnessModelPicker
        harness={harness}
        harnessOptions={harnessOptions()}
        harnessLabel={harnessOptionLabel}
        harnessSelected={sameHarnessSelection}
        harnessGroup={harnessOptionGroup}
        harnessDisabled={harnessDisabled}
        harnessHint={() => (sessionLocked() ? "Continue this conversation with another harness" : undefined)}
        harnessIcon={(option) => <HarnessOptionIcon harness={option} />}
        onHarnessSelect={applyHarness}
        modelError={() => {
          // The same resolved notice the composer row shows, rendered inside
          // the Model section too. The row explains the failure globally; the
          // section replaces the list, because a working search box over zero
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
        variantLabel={harnessLevelName}
        onVariantSelect={(value) => {
          props.harnessController.setThoughtLevel(scope(), catalogSelected() && value === "default" ? undefined : value)
        }}
        fast={fastControl}
        onFastToggle={(next) => props.harnessController.setServiceTier(scope(), next ? fastTier()?.id : undefined)}
        triggerStyle={() => style(activeModelDisabled())}
        triggerHint={modelHint}
        triggerLabel={modelHint() ? `Select harness and model — ${modelHint()}` : "Select harness and model"}
        triggerState={() => ({
          harness: selection().harness ? harnessSelectionId(selection().harness!) : "",
          model: selection().selectedModel,
          provider: selection().selectedModelProvider,
          readiness: selection().readiness,
          readyForSubmit: !!selection().selectedModelKey,
        })}
      />

      {/* Readiness indicator. Connecting is progress, not a fault, so it stays
          inline; the settled failure it can escalate into is published to the
          composer notice row instead. */}
      <Show when={!isPolling() && selection().connectionState && ["configured", "connecting", "ready"].includes(selection().connectionState!.state)}>
        <span class="text-11-regular text-text-weak px-1.5 flex items-center" data-connection-state={selection().connectionState?.state}
          title={selection().connectionState?.state === "ready" ? "ACP handshake completed. Authentication is checked by the agent when needed." : selection().connectionState?.state === "configured" ? "Configured; no active agent connection has completed a handshake." : "Waiting for the agent handshake."}>
          {selection().connectionState?.state === "ready" ? "Connected" : selection().connectionState?.state === "configured" ? "Configured" : "Connecting"}
        </span>
      </Show>
      <Show when={isPolling()}>
        <span class="text-11-regular text-text-weak px-1.5 flex items-center" title="Connecting to agent runtime...">
          <span class="inline-block w-2 h-2 rounded-full bg-text-weak animate-pulse mr-1" />
          Connecting
        </span>
      </Show>
    </>
  )
}
