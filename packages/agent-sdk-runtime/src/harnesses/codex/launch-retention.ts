import {
  RecoveryCodedError,
  verifyCreationIdentity,
  type CreationIdentity,
  type RetirementResult,
} from "../../launch"

/**
 * One unresolved retirement, held against the next launch.
 *
 * Two Codex app-servers sharing a driver's Codex home would write each other's
 * threads and auth file, so a retirement that established nothing refuses the
 * replacement rather than racing it. That refusal is a claim about a specific
 * process, and processes end: the recorded identity is re-read before the
 * refusal is repeated, which is what keeps one failed retirement from refusing
 * every later session for the life of the driver.
 */
export function createLaunchRetention() {
  let held: { identity: CreationIdentity; result: RetirementResult } | undefined

  const refusal = (result: RetirementResult) => new RecoveryCodedError(
    result.error?.code ?? "exit_unverified",
    `The Codex app-server this driver launched was not established as stopped (leader ${result.leader}, group ${result.descendants}); no replacement was started${result.error ? `: ${result.error.message}` : ""}`,
  )

  return {
    hold(identity: CreationIdentity, result: RetirementResult) {
      held = { identity, result }
    },

    /** The refusal as it stands, without re-reading the recorded process. */
    error() {
      return held ? refusal(held.result) : undefined
    },

    /**
     * The refusal a launch must answer, after re-reading the held identity. A
     * pid that has exited, or that now answers for a different process, is no
     * longer the launch this driver was holding.
     */
    async blocker() {
      if (!held) return undefined
      const verdict = await verifyCreationIdentity(held.identity)
      if (verdict.state !== "exited" && verdict.state !== "identity_mismatch") return refusal(held.result)
      held = undefined
      return undefined
    },
  }
}

export type LaunchRetention = ReturnType<typeof createLaunchRetention>
