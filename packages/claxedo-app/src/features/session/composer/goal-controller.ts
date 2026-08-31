import { createMemo, type Accessor } from "solid-js"
import { useQuery } from "@tanstack/solid-query"
import type { AgentRuntimeGoalCapabilities } from "@/platform/runtime/agent/agent-runtime-client"
import { fetchSessionCapabilitiesByTransport } from "@/features/session/store/session-transport"

type CapabilityRequest = Parameters<typeof fetchSessionCapabilitiesByTransport>[0]

export function createComposerGoalController(input: {
  isNewSession: Accessor<boolean>
  harness: Accessor<string>
  harnessPending: Accessor<boolean>
  client: CapabilityRequest["client"]
  directory: Accessor<CapabilityRequest["directory"]>
  serverUrl: Accessor<string | undefined>
  signedControlPlane: Accessor<boolean>
  workspaceId: Accessor<string | undefined>
  workspaceKind: Accessor<CapabilityRequest["workspaceKind"]>
  sessionRef: Accessor<CapabilityRequest["sessionRef"]>
  sessionCapabilities: Accessor<AgentRuntimeGoalCapabilities | undefined>
  armed: Accessor<boolean>
  setArmed: (armed: boolean) => void
  unavailable: (reason?: string) => void
  normalizeMode: VoidFunction
  focus: VoidFunction
}) {
  const draftCapabilities = useQuery(() => {
    const directory = input.directory()
    const harness = input.harness()
    const signed = input.signedControlPlane()
    return {
      queryKey: [
        "session-goal-draft-capabilities-v1",
        input.serverUrl() ?? "",
        directory,
        harness,
        signed ? "signed" : "local",
        input.workspaceId() ?? "",
        input.workspaceKind() ?? "",
      ] as const,
      queryFn: ({ signal }: { signal: AbortSignal }) => fetchSessionCapabilitiesByTransport({
        client: input.client,
        directory,
        harness,
        claxedoServerUrl: input.serverUrl(),
        signedControlPlane: signed,
        workspaceId: signed ? input.workspaceId() : undefined,
        workspaceKind: signed ? input.workspaceKind() : undefined,
        sessionRef: input.sessionRef(),
        signal,
      }),
      enabled: input.isNewSession() && !input.harnessPending(),
      staleTime: 30_000,
    }
  })
  const available = createMemo(() => input.isNewSession()
    ? draftCapabilities.data?.goals === true
    : input.sessionCapabilities()?.available === true)
  const arm = () => {
    if (!available()) {
      input.unavailable(input.sessionCapabilities()?.unavailableReason)
      return
    }
    input.setArmed(true)
    input.normalizeMode()
    requestAnimationFrame(input.focus)
  }
  const disarm = () => {
    input.setArmed(false)
    requestAnimationFrame(input.focus)
  }
  const toggle = () => input.armed() ? disarm() : arm()
  return {
    available,
    armed: input.armed,
    arm,
    toggle,
    submitInput: (goal?: Accessor<unknown>, stopGoal?: () => void | Promise<unknown>) => ({
      goalArmed: input.armed,
      onGoalArm: () => input.setArmed(true),
      onGoalAccepted: () => input.setArmed(false),
      hasActiveGoal: () => {
        const current = goal?.() as { status?: string } | null | undefined
        return current?.status === "active"
      },
      stopGoal,
    }),
  }
}
