import { defineExtension, hook, ToolTask, type Extension, type ToolRegistration } from "@earendil-works/pi-durable"
import type { SessionConfig } from "@claxedo/agent-runtime-contract"
import type { SkillRoot } from "../../contract"
import { piAsks, piToolApproval, type PiAsker } from "./approvals"
import { piQuestionTool } from "./question"
import { piSkillsSection } from "./skills"

export type PiExtensionHost = {
  sessionId: string
  config(): SessionConfig
  skills(): readonly SkillRoot[]
  asker(): PiAsker
}

export const CLAXEDO_PI_EXTENSION = "claxedo"

export function claxedoPiExtension(host: PiExtensionHost, mcpTools: readonly ToolRegistration[]): Extension {
  return defineExtension({
    name: CLAXEDO_PI_EXTENSION,
    tools: [piQuestionTool({ sessionId: host.sessionId, asker: host.asker }), ...mcpTools],
    sections: [piSkillsSection(host.skills)],
    hooks: [hook(ToolTask, {
      beforeTool: (call, _api, context) => piAsks(host.config(), call.name)
        ? piToolApproval({ sessionId: host.sessionId, call, asker: host.asker(), signal: context.abortSignal })
        : undefined,
    })],
  })
}
