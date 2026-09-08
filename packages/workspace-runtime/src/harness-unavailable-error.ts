/**
 * A harness identity that is not runnable here: a runtime with no default
 * harness at all, or an operator-configured ACP connection this runtime has no
 * applied descriptor for (unknown, disabled, or removed). Raised before any
 * adapter creation or process spawn, so a route can answer the named reason
 * instead of a transport failure.
 */
export class WorkspaceHarnessUnavailableError extends Error {
  readonly code = "workspace_harness_not_configured"
  constructor(readonly harness: { id: string; access: string }) {
    super(harness.access === "connection"
      ? `Connection "${harness.id}" is not configured on this runtime`
      : "No default harness is configured on this runtime")
    this.name = "WorkspaceHarnessUnavailableError"
  }
}
