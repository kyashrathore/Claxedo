import { createMemo, type JSX } from "solid-js"
import { useNavigate } from "@solidjs/router"
import { useServer } from "@/server"
import { settingsPath } from "@/shell"
import { sameHarnessSelection } from "@/lib/harness-selection"
import { watchCatalogDraftDefault } from "../harness/catalog-draft-default"
import type { HarnessScopeInput, HarnessSelectionController } from "../harness/controller"
import { createHarnessOptionList, harnessOptionGroup } from "../harness/harness-option-list"
import { watchScopeHarnessReprobe } from "../harness/harness-reprobe"
import { useModelNames } from "../harness/model-names"
import { useModelVisibility } from "../harness/model-visibility"
import { publishComposerNotice } from "./composer-notice"
import { HarnessConnectionBadge } from "./harness-connection-badge"
import { createEffortControls, createFastControl } from "./harness-effort-controls"
import { createModelAvailability } from "./harness-model-availability"
import { createModelPickerState } from "./harness-model-pick"
import { HarnessModelPicker } from "./harness-model-picker"
import { createHarnessModelRows } from "./harness-model-rows"
import { HarnessOptionIcon } from "./harness-option-icon"
import { createHarnessSwitch } from "./harness-switch"
import { createHarnessTriggerLabel, createTriggerStyle, triggerStateOf } from "./harness-trigger"
import { createSelectorCatalog } from "./selector-catalog"
import { createSelectorNotice } from "./selector-notice"
import { createScopeSelection, createSelectorScope } from "./selector-scope"

interface AgentHarnessSelectorProps {
  triggerStyle?: JSX.CSSProperties
  sessionLocked?: boolean
  scope: string
  scopeInput: HarnessScopeInput
  active?: boolean
  harnessController: HarnessSelectionController
}

export function AgentHarnessSelector(props: AgentHarnessSelectorProps) {
  const navigate = useNavigate()
  const server = useServer()
  const controller = () => props.harnessController
  const active = () => props.active
  const optionList = createHarnessOptionList(server)
  const { scope, scopeInput, placementId, sessionId, sessionLocked } = createSelectorScope({
    scope: () => props.scope,
    scopeInput: () => props.scopeInput,
    sessionLocked: () => props.sessionLocked,
    active,
    controller,
  })
  const { selection, connectionDeclaration, harness, catalogSelected } = createScopeSelection({
    controller,
    scope,
    connectionRows: optionList.connectionRows,
  })
  const visibility = useModelVisibility()
  const catalog = createSelectorCatalog({ server, harness, sessionId })
  const modelNames = useModelNames()
  const { rows, picked } = createHarnessModelRows({ harness, selection, catalog, visibility })
  watchCatalogDraftDefault({
    controller,
    scope,
    scopeInput,
    placementId,
    sessionLocked,
    selection,
    harness,
    options: optionList.options,
    catalog,
    picked,
  })
  const isPolling = createMemo(() => selection().readiness === "polling")
  watchScopeHarnessReprobe({ active, scope, scopeInput, placementId, sessionId, polling: isPolling, controller })
  const harnessSwitch = createHarnessSwitch({ controller, scope, scopeInput, harness, polling: isPolling, options: optionList.options, catalog })
  const openProviders = () => {
    navigate(settingsPath("models"))
  }
  const model = createModelPickerState({
    controller,
    scope,
    scopeInput,
    selection,
    rows,
    picked,
    catalogSelected,
    catalogVariants: catalog.variants,
    openProviders,
  })
  const availability = createModelAvailability({ harness, selection, connectionDeclaration, catalog, rows, switching: harnessSwitch.switching })
  const trigger = createHarnessTriggerLabel({
    selection,
    harness,
    picked,
    catalogSelected,
    catalog,
    polling: isPolling,
    availability,
    harnessLabel: optionList.label,
    modelNames,
  })
  const style = createTriggerStyle(() => props.triggerStyle)
  const { notice, modelError } = createSelectorNotice({
    active,
    controller,
    scope,
    scopeInput,
    selection,
    harness,
    picked,
    catalog,
    availability,
    polling: isPolling,
    harnessLabel: optionList.label,
    openProviders,
  })
  const effort = createEffortControls({ selection, catalogSelected, catalog, scope, controller })
  const fast = createFastControl({ selection, catalogSelected, scope, controller })

  publishComposerNotice(notice)

  return (
    <>
      <HarnessModelPicker
        harness={harness}
        harnessOptions={optionList.options()}
        harnessLabel={optionList.label}
        harnessSelected={sameHarnessSelection}
        harnessGroup={harnessOptionGroup}
        harnessDisabled={harnessSwitch.harnessDisabled}
        harnessHint={() => (sessionLocked() ? "Continue this conversation with another harness" : undefined)}
        harnessIcon={(option) => <HarnessOptionIcon harness={option} />}
        onOpen={() => {
          catalog.providers.request()
          void optionList.refetch()
        }}
        onHarnessSelect={harnessSwitch.apply}
        modelError={modelError}
        model={model}
        modelLabel={trigger.label}
        modelLoading={availability.modelLoadingOrSwitching}
        modelDisabled={availability.modelDisabled}
        showEffort={effort.showEffort}
        variants={effort.variants}
        currentVariant={effort.currentVariant}
        variantLabel={effort.levelName}
        onVariantSelect={effort.select}
        fast={fast.control}
        onFastToggle={fast.toggle}
        triggerStyle={() => style(availability.modelDisabled())}
        triggerHint={trigger.hint}
        triggerLabel={trigger.hint() ? `Select harness and model — ${trigger.hint()}` : "Select harness and model"}
        triggerState={() => triggerStateOf(selection())}
      />
      <HarnessConnectionBadge selection={selection} polling={isPolling} />
    </>
  )
}
