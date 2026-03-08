import type { JSX } from "solid-js"
import { createSimpleContext } from "./helper"

export const {
  ctx: orchestratorCtx,
  use: useOrchestrator,
  provider: OrchestratorProvider,
} = createSimpleContext({
  name: "Orchestrator",
  gate: false,
  init: (props: {
    renderPromptDock?: (sessionID: string) => JSX.Element
  }) => ({
    get renderPromptDock() {
      return props.renderPromptDock
    },
  }),
})
