import { registerAcpGoldenCases } from "./acp-golden"
import { registerClaudePresentationCases } from "./claude"
import { registerCodexSubagentParentCases } from "./codex-subagent-parent"
import { registerPlanModeCases } from "./plan-mode"
import type { CreatePresentationProjection } from "./projection"
import { registerToolNameCases } from "./tool-names"

export function registerTranslatorPresentationCases(createProjection: CreatePresentationProjection) {
  registerAcpGoldenCases(createProjection)
  registerClaudePresentationCases(createProjection)
  registerCodexSubagentParentCases(createProjection)
  registerPlanModeCases(createProjection)
  registerToolNameCases(createProjection)
}
