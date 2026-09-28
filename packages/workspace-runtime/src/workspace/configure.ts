import type { PluginProjection, ResolvedCredentials, TransportConfigUpdate } from "@claxedo/harness/contract"
import { createKeyedSerializer } from "@claxedo/helpers"
import type { AttachedSession } from "../host/attachments"
import { RuntimeConfigApplyError } from "../routes/config"

export type SessionConfigurationInput = {
  attached: () => readonly AttachedSession[]
  projection: (attached: AttachedSession) => PluginProjection
  credentials: () => ResolvedCredentials
  providerDefinitions: () => TransportConfigUpdate["providerDefinitions"]
  /** A push a turn held back that the harness refused or failed once the turn ended. */
  onHeldFailure: (error: unknown) => void
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
 * launch values. A refusal fails the apply that asked for it, and a held push
 * refused when its turn ends is reported to the host the same way.
 */
export function createSessionConfiguration(input: SessionConfigurationInput) {
  const pending = new WeakMap<AttachedSession, TransportConfigUpdate>()
  const held = new WeakSet<AttachedSession>()
  const pushes = createKeyedSerializer<AttachedSession>()

  const push = (attached: AttachedSession): Promise<string | undefined> => pushes.run(attached, async () => {
    const update = pending.get(attached)
    if (!update) return undefined
    const applied = await attached.handle.transport.configure(attached.session, update)
    if (applied.state === "deferred" && applied.until === "after-active-turns") {
      held.add(attached)
      return undefined
    }
    held.delete(attached)
    if (applied.state !== "refused" && pending.get(attached) === update) pending.delete(attached)
    return applied.state === "refused" ? applied.reason : undefined
  })

  return {
    async apply(change: { credentials: boolean; projection: boolean; providerDefinitions: boolean }): Promise<void> {
      const credentials = change.credentials ? input.credentials() : undefined
      const refusals = (await Promise.all(input.attached().map(async (attached) => {
        if (change.credentials || change.projection || change.providerDefinitions) pending.set(attached, {
          ...pending.get(attached),
          ...(credentials ? { credentials } : {}),
          ...(change.providerDefinitions ? { providerDefinitions: input.providerDefinitions() } : {}),
          ...(change.projection ? { projection: input.projection(attached) } : {}),
        })
        const reason = await push(attached)
        return reason === undefined ? [] : [{ sessionId: attached.session.binding.sessionId, reason }]
      }))).flat()
      if (refusals.length > 0) throw configurationRefusal(refusals)
    },
    async afterTurn(sessionId: string): Promise<void> {
      const attached = input.attached().find((entry) => entry.session.binding.sessionId === sessionId)
      if (!attached || !held.has(attached)) return
      try {
        const reason = await push(attached)
        if (reason !== undefined) input.onHeldFailure(configurationRefusal([{ sessionId, reason }]))
      } catch (error) {
        held.delete(attached)
        input.onHeldFailure(error)
      }
    },
  }
}
