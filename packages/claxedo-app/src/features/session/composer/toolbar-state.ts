import { createMemo, type Accessor } from "solid-js"
import {
  promptModelResolutionState,
  promptModelState,
  resolveModelVariant,
} from "./model-strategy"
import { shouldShowPromptAgentSelector } from "./ui/selector-visibility"

type PromptAgent = { name: string }
type PromptModel = { id: string; name?: string; provider: { id: string } }

export function createPromptToolbarState(input: {
  agentList: Accessor<PromptAgent[]>
  currentAgent: Accessor<PromptAgent | undefined>
  fallbackAgent: Accessor<PromptAgent | undefined>
  agentOverride: Accessor<string | undefined>
  providerLoading: Accessor<boolean>
  currentModel: Accessor<PromptModel | undefined>
  currentModelSource: Accessor<string | undefined>
  hasSelectedModel: Accessor<boolean>
  modelRestorePending: Accessor<boolean>
  selectionCatalogPending: Accessor<boolean>
  harnessMode: Accessor<boolean>
  isOpenCodeHarness: Accessor<boolean>
  existingSession: Accessor<boolean>
  variantList: Accessor<string[]>
  selectedVariant: Accessor<string | null | undefined>
  configuredVariant: Accessor<string | undefined>
}) {
  const fallbackAgent = createMemo(input.fallbackAgent)
  const agentNames = createMemo(() => {
    const names = input.agentList().map((agent) => agent.name)
    const fallback = fallbackAgent()?.name
    if (!fallback || names.includes(fallback)) return names
    return [...names, fallback]
  })
  const currentAgent = createMemo(() => input.currentAgent() ?? input.agentList()[0] ?? fallbackAgent())
  const modelResolutionState = createMemo(() =>
    promptModelResolutionState({
      harnessMode: input.harnessMode(),
      existingSession: input.existingSession(),
      hasCurrentModel: !!input.currentModel() && input.currentModelSource() !== "fallback",
      hasSelection: input.hasSelectedModel(),
      providerLoading: input.providerLoading(),
      restoreLoading: input.modelRestorePending(),
      selectionCatalogPending: input.selectionCatalogPending(),
    }),
  )
  const currentModel = createMemo(() => {
    const current = input.currentModel()
    if (!current || input.currentModelSource() === "fallback") return undefined
    return current
  })
  const readiness = createMemo(() =>
    promptModelState({
      harnessMode: input.harnessMode(),
      harnessMode: input.harnessMode(),
      providerLoading: input.providerLoading(),
      restoreLoading: input.modelRestorePending(),
      model: currentModel(),
      agent: currentAgent(),
      agentOverride: input.agentOverride(),
    }),
  )
  const variants = createMemo(() => ["default", ...input.variantList()])
  const currentVariant = createMemo(() =>
    resolveModelVariant({
      variants: input.variantList(),
      selected: input.selectedVariant(),
      configured: input.configuredVariant(),
    }),
  )

  return {
    agentNames,
    currentAgent,
    modelResolutionState,
    currentModel,
    readiness,
    modelSubmitBlocked: () => readiness().blocked,
    showAgentSelector: () =>
      shouldShowPromptAgentSelector({
        isOpenCodeHarness: input.isOpenCodeHarness(),
        agentCount: agentNames().length,
      }),
    variants,
    currentVariant,
  }
}
