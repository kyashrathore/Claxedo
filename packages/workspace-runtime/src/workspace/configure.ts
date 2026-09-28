import type { PluginProjection, ResolvedCredentials, TransportConfigUpdate } from "@claxedo/harness/contract"
import { CredentialSelectionError } from "@claxedo/harness/registry"
import type { AttachedSession } from "../host/attachments"
import { RuntimeConfigApplyError } from "../routes/config"

export type SessionConfigurationInput = {
  attached: () => readonly AttachedSession[]
  projection: (attached: AttachedSession) => PluginProjection
  credentials: (attached: AttachedSession) => ResolvedCredentials
  /** A push a turn held back that the harness refused or failed once the turn ended. */
  onHeldFailure: (error: unknown) => void
  /** Ends a session whose owner has no usable account left, so it stops spending the one it started on. */
  retire: (attached: AttachedSession, reason: string) => Promise<void>
}

function configurationRefusal(refusals: ReadonlyArray<{ sessionId: string; reason: string }>) {
  return new RuntimeConfigApplyError(
    "runtime_config_refused",
    `The harness refused the configuration for ${refusals.map((refusal) => `${refusal.sessionId} (${refusal.reason})`).join(", ")}`,
    409,
    { refusals },
  )
}

/**
 * Pushes a changed snapshot into every attached session, once each, and holds
 * what a transport defers until that session's own turn ends. A transport that
 * answers `next-session` is left as it is: the next start carries the new
 * launch values. A harness's refusal fails the apply that asked for it, and a
 * held push refused when its turn ends is reported to the host the same way. A
 * session whose owner has no usable account left is retired instead: the apply
 * is not the session's to fail, and its next turn attaches afresh and is refused
 * by name there.
 */
export function createSessionConfiguration(input: SessionConfigurationInput) {
  const held = new Map<string, TransportConfigUpdate>()

  const push = async (attached: AttachedSession, update: TransportConfigUpdate): Promise<string | undefined> => {
    const sessionId = attached.session.binding.sessionId
    const applied = await attached.handle.transport.configure(attached.session, update)
    if (applied.state === "deferred" && applied.until === "after-active-turns") {
      held.set(sessionId, update)
      return undefined
    }
    held.delete(sessionId)
    return applied.state === "refused" ? applied.reason : undefined
  }

  return {
    async apply(change: { credentials: boolean; projection: boolean }): Promise<void> {
      if (!change.credentials && !change.projection) return
      const refusals = (await Promise.all(input.attached().map(async (attached) => {
        const sessionId = attached.session.binding.sessionId
        let credentials: ResolvedCredentials | undefined
        try {
          credentials = change.credentials ? input.credentials(attached) : undefined
        } catch (error) {
          if (!(error instanceof CredentialSelectionError)) throw error
          held.delete(sessionId)
          await input.retire(attached, error.message)
          return []
        }
        const reason = await push(attached, {
          ...(credentials ? { credentials } : {}),
          ...(change.projection ? { projection: input.projection(attached) } : {}),
        })
        return reason === undefined ? [] : [{ sessionId, reason }]
      }))).flat()
      if (refusals.length > 0) throw configurationRefusal(refusals)
    },
    async afterTurn(sessionId: string): Promise<void> {
      const update = held.get(sessionId)
      if (!update) return
      const attached = input.attached().find((entry) => entry.session.binding.sessionId === sessionId)
      if (!attached) { held.delete(sessionId); return }
      try {
        const reason = await push(attached, update)
        if (reason !== undefined) input.onHeldFailure(configurationRefusal([{ sessionId, reason }]))
      } catch (error) {
        held.delete(sessionId)
        input.onHeldFailure(error)
      }
    },
  }
}
