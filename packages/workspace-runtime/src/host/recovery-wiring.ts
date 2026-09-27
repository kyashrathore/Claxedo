import type { AgentRuntimeRecovery } from "./contracts"
import type { RuntimeRecovery } from "./recovery"

/**
 * The recovery surface a runtime hands its callers, and the sink it hands its
 * adapters.
 *
 * They are built together because they are two halves of one seam: an adapter
 * reports a failure about a session, and the caller reads it back through the
 * same owner's inspection. Splitting them across the composition is how the
 * sink came to be supplied by nothing at all.
 */
export function recoveryWiring(recovery: () => RuntimeRecovery) {
  // Read lazily: the adapters are constructed before the recovery owner, and
  // the sink they are given must reach the one this runtime ends up with.
  const reportOwnerFailure = (sessionId: string, error: unknown) =>
    recovery().reportSessionFailure(sessionId, error)

  return {
    reportOwnerFailure,
    surface: (): AgentRuntimeRecovery => ({
      inspect: recovery().inspect,
      submit: recovery().submit,
      read: recovery().read,
      reportContainmentFailure: recovery().reportContainmentFailure,
      reportOwnerFailure,
    }),
  }
}
