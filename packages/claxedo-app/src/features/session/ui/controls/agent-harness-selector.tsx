import { Show, createEffect, createMemo, createSignal, onCleanup, untrack, type JSX } from "solid-js"
import { ClaxedoIcon as Icon } from "@/ui/controls/claxedo-icon"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { type PickerItem, type PickerState } from "@/features/session/ui/model/select-model"
import { HarnessModelPicker } from "@/features/session/composer/ui/harness-model-picker"
import { publishComposerNotice, type ComposerNotice } from "@/features/session/composer/ui/composer-notice"
import { resolveHarnessNotice } from "@/features/session/composer/ui/harness-notice"
import {
  HARNESS_DISPLAY_NAMES,
  harnessDisplayLabel,
  harnessSelectionId,
  isNativeHarness,
  type HarnessType,
} from "@/features/session/harness/profile"
import { harnessUsesManagedDefaultModel } from "@/features/session/harness/selection"
import type { HarnessSelectionController } from "@/features/session/harness/controller"
import type { SessionRef } from "@/platform/identity/session-ref"
import { shouldApplyHarnessSelection } from "./agent-harness-selection-guard"
import { watchHarnessReprobe } from "@/features/session/harness/harness-reprobe"
import { panePreferenceScope } from "@/features/session/preferences/pane"
import {
  createModelSelectionController,
  modelKeyFromPickerSelection,
} from "@/features/session/commands/model-selection"
import { openSettingsProviders } from "@/features/session/app-ports"
import { capture as phCapture, identityProps } from "@/platform/telemetry/analytics"
import {
  NATIVE_HARNESS_IDS,
  connectionHarness,
  nativeHarness,
  sameHarnessSelection,
} from "@/platform/identity/harness-selection"
import { createHarnessConnectionsCatalog } from "@/platform/query/connection-catalog"
import { authFetch, getClaxedoServerUrl } from "@/platform/api/api"
const BUILTIN_HARNESS_OPTIONS: HarnessType[] = NATIVE_HARNESS_IDS.map(nativeHarness)

function label(input: string) {
  return HARNESS_DISPLAY_NAMES[input] ?? harnessDisplayLabel(input)
}

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
  /** Whether the current session already exists. Existing sessions hand off through session config. */
  sessionLocked?: boolean
  directory?: string
  sessionId?: string
  sessionRef?: SessionRef
  surfaceId?: string
  draftId?: string
  active?: boolean
  harnessController: HarnessSelectionController
}

export function AgentHarnessSelector(props: AgentHarnessSelectorProps) {
  const dialog = useDialog()
  const connections = createHarnessConnectionsCatalog({ base: getClaxedoServerUrl(), request: authFetch })
  const connectionRows = createMemo(() => {
    const catalog = connections.data()
    return catalog?.status === "supported" ? catalog.connections : []
  })
  const refreshConnections = () => {
    let cancelled = false
    let attempts = 0
    let retry: ReturnType<typeof setTimeout> | undefined
    const refresh = async () => {
      attempts += 1
      await connections.refresh()
      if (cancelled || !connections.error() || attempts >= 3) return
      retry = setTimeout(() => void refresh(), attempts * 500)
    }
    void refresh()
    return () => {
      cancelled = true
      if (retry) clearTimeout(retry)
    }
  }
  createEffect(() => {
    if (props.active === false) return
    onCleanup(refreshConnections())
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
    return label(input.harnessId)
  }
  const sessionId = createMemo(() => {
    const next = props.sessionId
    return next
  })
  const sessionRef = createMemo(() => props.sessionRef)
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
    const nextSessionRef = sessionRef()
    if (props.active === false) {
      return
    }
    if (!nextDirectory) {
      return
    }
    const timer = setTimeout(
      () =>
        untrack(() => {
          void props.harnessController.hydrate(nextScope, {
            directory: nextDirectory,
            sessionId: nextSessionId,
            sessionRef: nextSessionRef,
          })
        }),
      50,
    )
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
        sessionRef: sessionRef(),
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
    if (!currentHarness) return []
    return selection().models.map((item) => ({
      id: item.id,
      name: item.name,
      ...(item.description ? { description: item.description } : {}),
      provider: {
        id: item.providerID ?? harnessSelectionId(currentHarness),
        name: label(item.providerID ?? harnessSelectionId(currentHarness)),
      },
      connected: !selection().configError && !selection().optionsLoading && selection().models.length > 0,
    }))
  })
  const picked = createMemo(() => {
    const selected = selection().selectedModelKey
    const next =
      rows().find((item) => item.id === selected?.modelID && item.provider.id === selected.providerID) ??
      rows().find((item) => item.id === selection().selectedModel)
    return next
  })
  const modelSelection = createMemo(() =>
    createModelSelectionController({
      write: (command) => {
        if (!command.model) return
        const hit = rows().find(
          (item) => item.id === command.model?.modelID && item.provider.id === command.model.providerID,
        )
        return props.harnessController.setModel(
          scope(),
          command.model,
          {
            directory: directory(),
            sessionId: sessionId(),
          },
          hit ? { provider: hit.provider.name, model: hit.name } : undefined,
        )
      },
    }),
  )
  const openProviders = () => {
    void openSettingsProviders(dialog)
  }
  const model = createMemo<PickerState>(() => ({
    list: () => rows() as PickerItem[],
    current: () => picked() as PickerItem | undefined,
    visible: () => true,
    set: (item) => {
      const modelKey = modelKeyFromPickerSelection(item)
      if (!modelKey) return
      const hit = rows().find((row) => row.id === modelKey.modelID && row.provider.id === modelKey.providerID)
      if (!hit) return
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
  const harnessTriggerStyle = createMemo(() => {
    const disabled = harnessDisabled()
    const next = style(disabled)
    return next
  })
  const modelLoading = createMemo(optionsLoading)
  const hasModelOptions = createMemo(() => {
    return rows().length > 0
  })
  const managedDefaultModel = createMemo(() =>
    harnessUsesManagedDefaultModel({
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
    const error = selection().configError
    if (!error || error === "Loading model options..." || error === "Selected model unavailable") return false
    return !optionsLoading() && !hasModelOptions()
  })
  const modelDisabled = createMemo(() => {
    return (
      !harness() || managedDefaultModel() || modelLoading() || isError() || modelUnavailable() || modelOptionsFailed()
    )
  })
  // Names a model, or says there is none — never reports an error. Failures are
  // the notice row's job, and this control used to duplicate its wording
  // ("Unavailable" here AND in the readiness pill AND in the dot's tooltip).
  const modelLabel = createMemo(() => {
    if (isPolling()) return "Connecting"
    if (modelLoading()) return "Loading models"
    if (picked()) return picked()?.name
    if (selection().draftDefaultState === "saved-model-unavailable") {
      return selection().draftDefaultLabels?.model ?? selection().selectedModel
    }
    if (managedDefaultModel()) return `${harnessOptionLabel(harness()!)} default`
    if (!harness()) return "Select agent"
    if (isNativeHarness(harness()!, "pi") && selection().selectedModel) return selection().selectedModel
    if (!hasModelOptions()) return isNativeHarness(harness()!, "pi") ? "No Pi models available" : "Select model"
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
    if (managedDefaultModel() && harness()) return `Model is managed by ${harnessOptionLabel(harness()!)}`
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
    "data-harness": selection().harness ? harnessSelectionId(selection().harness!) : undefined,
    "data-model": selection().selectedModel,
    "data-provider": selection().selectedModelProvider,
    "data-readiness": selection().readiness,
    "data-ready-for-submit": selection().selectedModelKey ? "true" : "false",
  }))

  // One row, one message, one action — see `harness-notice.ts` for the ordering.
  const needsProviderSetup = createMemo(() => {
    if (modelOptionsFailed()) return false
    return !managedDefaultModel() && !modelLoading() && !hasModelOptions() && !isPolling() && !isError()
  })
  const notice = createMemo<ComposerNotice | undefined>(() => {
    // A backgrounded pane must not publish over the visible one.
    if (props.active === false || !selection().isHarnessMode) return undefined
    const resolved = resolveHarnessNotice({
      harnessLabel: harness() ? harnessOptionLabel(harness()!) : "Agent",
      runtimeUnavailable: isError(),
      optionsFailed: modelOptionsFailed(),
      noModels: !hasModelOptions() && !modelLoading(),
      configError: selection().configError,
      savedModelUnavailable:
        selection().draftDefaultState === "saved-model-unavailable"
          ? selection().draftDefaultLabels?.model || selection().selectedModel || "Saved model"
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
        ariaLabel: "Retry loading harness models",
        run: () => {
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
    phCapture("harness_selected", {
      ...identityProps(),
      surface: "composer",
      harness: harnessSelectionId(r),
      targetKind: r.kind,
    })
    setSwitchingHarness(r)
    const switchScope = scope()
    const switchDirectory = directory()
    const switchSession = sessionId()
    void Promise.resolve(
      props.harnessController.setHarness(switchScope, r, {
        directory: switchDirectory,
        sessionId: switchSession,
      }),
    ).finally(() => {
      setSwitchingHarness((current) => (sameHarnessSelection(current, r) ? undefined : current))
    })
  }

  const activePicker = model
  const activeModelLabel = createMemo(() => modelLabel() || "Select model")
  const harnessThoughtLevels = createMemo(() => selection().thoughtLevels ?? [])
  const activeVariants = createMemo(() => harnessThoughtLevels().map((item) => item.id))
  const activeShowEffort = createMemo(() => activeVariants().length > 1)
  const activeCurrentVariant = createMemo(() => selection().selectedThoughtLevel)
  const harnessLevelName = (value: string) => harnessThoughtLevels().find((item) => item.id === value)?.name ?? value

  const activeModelLoading = createMemo(() => modelLoading() || harnessSwitching())
  const activeModelDisabled = modelDisabled

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
        harnessSelected={sameHarnessSelection}
        harnessGroup={harnessOptionGroup}
        harnessDisabled={harnessDisabled}
        harnessHint={() => (sessionLocked() ? "Continue this conversation with another harness" : undefined)}
        harnessIcon={(option) => <HarnessOptionIcon harness={option} />}
        onHarnessSelect={applyHarness}
        showManageModels={() => false}
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
        variantLabel={harnessLevelName}
        onVariantSelect={(value) => {
          props.harnessController.setThoughtLevel(scope(), value === "default" ? undefined : value)
        }}
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
      <Show when={isPolling()}>
        <span class="text-11-regular text-text-weak px-1.5 flex items-center" title="Connecting to agent runtime...">
          <span class="inline-block w-2 h-2 rounded-full bg-text-weak animate-pulse mr-1" />
          Connecting
        </span>
      </Show>
    </>
  )
}
