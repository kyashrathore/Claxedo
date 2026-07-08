import { createSimpleContext } from "@opencode-ai/ui/context"
import { createHarnessConfigStore } from "../../claxedo-ui/context/harness-config-store"
import {
  createHarnessSelectionController,
  createHarnessSubmitController,
  type HarnessSelectionController,
  type HarnessSubmitController,
} from "../../session-client/harness/controller"

export type PromptHarnessControllers = {
  submit: HarnessSubmitController
  selection?: HarnessSelectionController
}

const promptHarnessControllersContext = createSimpleContext<PromptHarnessControllers, Record<string, any>>({
  name: "PromptHarnessControllers",
  gate: false,
  init: () => {
    const harnessConfig = createHarnessConfigStore()
    return {
      submit: createHarnessSubmitController(harnessConfig),
      selection: createHarnessSelectionController(harnessConfig),
    }
  },
})

export const PromptHarnessControllersProvider = promptHarnessControllersContext.provider

export function usePromptHarnessControllersOptional(): PromptHarnessControllers {
  try {
    return promptHarnessControllersContext.use()
  } catch (error) {
    if (!isMissingPromptHarnessControllersProvider(error)) throw error
    return { submit: createHarnessSubmitController(undefined) }
  }
}

function isMissingPromptHarnessControllersProvider(error: unknown) {
  return error instanceof Error && error.message.includes("PromptHarnessControllers context must be used within a context provider")
}
