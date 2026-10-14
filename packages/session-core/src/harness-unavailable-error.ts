import { harnessProductLabel } from "@claxedo/agent-runtime-contract"

export type HarnessHostedElsewhere = { runsIn: string; notIn: string }

function unavailableMessage(harness: { id: string; access: string }, elsewhere: HarnessHostedElsewhere | undefined) {
  if (elsewhere) {
    const label = (harness.access === "native" ? harnessProductLabel(harness.id) : undefined) ?? harness.id
    return `${label} runs in ${elsewhere.runsIn} on a cloud workspace, not in ${elsewhere.notIn}. Start a new ${label} session to use it here.`
  }
  return harness.access === "connection"
    ? `Connection "${harness.id}" is not configured on this runtime`
    : "No default harness is configured on this runtime"
}

/**
 * A harness identity that is not runnable here: a runtime with no default
 * harness at all, an operator-configured ACP connection this runtime has no
 * applied descriptor for (unknown, disabled, or removed), or a harness that
 * a cloud workspace runs in another host than this one. Raised before any
 * adapter creation or process spawn, so a route can answer the named reason
 * instead of a transport failure.
 */
export class WorkspaceHarnessUnavailableError extends Error {
  readonly code: "workspace_harness_not_configured" | "workspace_harness_hosted_elsewhere"
  constructor(readonly harness: { id: string; access: string }, elsewhere?: HarnessHostedElsewhere) {
    super(unavailableMessage(harness, elsewhere))
    this.code = elsewhere ? "workspace_harness_hosted_elsewhere" : "workspace_harness_not_configured"
    this.name = "WorkspaceHarnessUnavailableError"
  }
}
