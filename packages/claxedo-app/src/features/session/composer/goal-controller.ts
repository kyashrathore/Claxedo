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
  /**
   * Forced re-read of the session's Goal state, owned by `sessionController`.
   * Goal capabilities arrive through DEFERRED secondary hydration, so the toggle
   * has to be able to pull them itself — `/goal <objective>` already does
   * (`dispatchGoalSubmit` fetches capabilities before starting), and the two
   * entry paths must not disagree about whether Goals are available.
   */
  refreshGoal?: (opts?: { force?: boolean }) => Promise<boolean>
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
  // An existing session whose capabilities have not hydrated yet is UNKNOWN, not
  // unavailable: refusing here is what made the toggle disagree with `/goal x`.
  const capabilitiesUnknown = () => !input.isNewSession() && input.sessionCapabilities() === undefined
  /**
   * Whether the Goal ENTRY POINTS (the `/goal` slash item, the toolbar Goal
   * action) may be activated. Distinct from `available` on purpose: Goal
   * capabilities for an EXISTING session arrive through DEFERRED secondary
   * hydration, so unknown must count as selectable — `arm()` resolves the
   * truth on activation (fetch, then arm or explain). Gating the entry points
   * on `available` left `/goal` permanently disabled in every existing
   * session until something else happened to hydrate capabilities, while a
   * NEW session's eagerly-fetched draft capabilities made the same command
   * work — the two entry paths must not disagree.
   */
  const selectable = createMemo(() => (input.isNewSession()
    ? draftCapabilities.data?.goals === true
    : input.sessionCapabilities() === undefined || input.sessionCapabilities()?.available === true))
  const armNow = () => {
    input.setArmed(true)
    input.normalizeMode()
    requestAnimationFrame(input.focus)
  }
  const arm = async () => {
    if (available()) {
      armNow()
      return
    }
    if (capabilitiesUnknown() && input.refreshGoal) {
      await input.refreshGoal({ force: true }).catch(() => false)
      if (available()) {
        armNow()
        return
      }
    }
    input.unavailable(input.sessionCapabilities()?.unavailableReason)
  }
  const disarm = () => {
    input.setArmed(false)
    requestAnimationFrame(input.focus)
  }
  const toggle = () => input.armed() ? Promise.resolve(disarm()) : arm()
  return {
    available,
    selectable,
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
