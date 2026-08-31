import type { RuntimeGoalSnapshot } from "@claxedo/agent-event-runtime"
import type {
  AgentRuntimeGoalCapabilities,
  AgentRuntimeGoalMutationResult,
} from "@/platform/runtime/agent/agent-runtime-client"
import type { SessionRef } from "@/platform/identity/session-ref"
import { setSessionGoalData } from "@/features/session/store/session-goal-cache"
import { setPromptSessionStatus, type RecordPromptSubmissionContext, type SubmitDirectory } from "../../submit/index"
import type { Prompt } from "@/features/session/providers/prompt"
import { resolveGoalComposerIntent } from "./goal-command"

type GoalClient = {
  getGoalCapabilities(input: { directory: SubmitDirectory; sessionID: string }): Promise<AgentRuntimeGoalCapabilities>
  startGoal(input: { directory: SubmitDirectory; sessionID: string; objective: string }): Promise<AgentRuntimeGoalMutationResult>
}

export function prepareGoalComposerIntent(input: {
  text: string
  armed: boolean
  mode: "normal" | "shell"
  prompt: Prompt
  setPrompt: (value: Prompt, cursor?: number) => void
  onArm?: VoidFunction
  setMode: (mode: "normal" | "shell") => void
  setPopover: (value: "at" | "slash" | null) => void
  focus: VoidFunction
}) {
  const intent = resolveGoalComposerIntent(input)
  if (intent.kind === "arm") {
    input.onArm?.()
    input.setPrompt(input.prompt.filter((part) => part.type !== "text"), 0)
    input.setMode("normal")
    input.setPopover(null)
    requestAnimationFrame(input.focus)
  } else if (intent.kind === "submit") input.onArm?.()
  return intent
}

export async function dispatchGoalSubmit(input: {
  objective: string
  session: { id: string }
  sessionDirectory: SubmitDirectory
  sessionRef?: SessionRef
  serverUrl?: string
  signedControlPlane?: boolean
  workspaceId?: string
  workspaceKind?: "cloud" | "user-hosted"
  client: GoalClient
  record: RecordPromptSubmissionContext
  prepareLiveEvents?: VoidFunction | (() => Promise<void>)
  clearInput: VoidFunction
  restoreInput: VoidFunction
  applyCreatedSessionHandoff: VoidFunction
  onAccepted: VoidFunction
  clearBoot: VoidFunction
  clearCloudStartup: VoidFunction
  reportCloudStartupError: (error: unknown) => void
  showFailed: (error: unknown) => void
}) {
  try {
    await input.prepareLiveEvents?.()
    const capabilities = await input.client.getGoalCapabilities({
      directory: input.sessionDirectory,
      sessionID: input.session.id,
    })
    if (!capabilities.implemented || !capabilities.available) {
      throw new Error(capabilities.unavailableReason ?? "Goals are unavailable for this harness")
    }
    // Existing sessions may have a newly selected model/agent. Persist that
    // authoritative config before the Goal starts; created sessions already
    // received the same config atomically in their create/claim request.
    await input.record.saveSessionConfig()
    const result = await input.client.startGoal({
      directory: input.sessionDirectory,
      sessionID: input.session.id,
      objective: input.objective,
    })
    if (!result.ok) throw new Error(result.message)
    if (!result.goal) throw new Error("Goal start succeeded without returning the active Goal")
    const goal: RuntimeGoalSnapshot = result.goal
    setSessionGoalData({
      sessionID: input.session.id,
      directory: input.sessionDirectory,
      serverUrl: input.serverUrl,
      signedControlPlane: input.signedControlPlane,
      workspaceId: input.workspaceId,
      workspaceKind: input.workspaceKind,
      sessionRef: input.sessionRef,
    }, { capabilities, goal })
    input.record.onSubmit?.()
    void input.record.refreshDirectory?.()
    input.record.capture()
    setPromptSessionStatus({ sessionID: input.session.id, status: { type: "busy" } })
    input.clearInput()
    input.onAccepted()
    input.applyCreatedSessionHandoff()
    input.clearBoot()
    input.clearCloudStartup()
    return true
  } catch (error) {
    setPromptSessionStatus({ sessionID: input.session.id, status: { type: "idle" } })
    input.clearBoot()
    input.reportCloudStartupError(error)
    input.showFailed(error)
    input.restoreInput()
    // A newly provisioned session is still the canonical owner of this failed
    // attempt. Hand it off after restoring the explicit Goal draft so retrying
    // cannot provision a second orphan session.
    input.applyCreatedSessionHandoff()
    return false
  }
}
