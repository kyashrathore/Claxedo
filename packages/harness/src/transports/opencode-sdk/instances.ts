import { createHash } from "node:crypto"
import type { Plugin } from "@opencode-ai/plugin"
import { TransportError } from "../../contract/errors.js"
import { launchPolicyPlugin, type OpenCodeLaunchDocument } from "./launch-policy.js"

export type InstanceSession = Readonly<{ id: string; parentID?: string }>

export type OpenCodeInstances = Readonly<{
  define(directory: string, document: OpenCodeLaunchDocument): string
  assign(sessionID: string, key: string): void
  release(sessionID: string): void
  keyOf(session: InstanceSession): string
  plugin(key: string): Plugin.Plugin
  ready(sessionID: string): Promise<void>
}>

function instanceRefusal(message: string): TransportError {
  return new TransportError("opencode", "session", message)
}

export function createInstances(): OpenCodeInstances {
  const documents = new Map<string, OpenCodeLaunchDocument>()
  const keys = new Map<string, string>()
  const readiness = new Map<string, Promise<void>>()
  return {
    define(directory, document) {
      const key = createHash("sha256").update(JSON.stringify([directory, document])).digest("hex")
      documents.set(key, document)
      return key
    },
    assign: (sessionID, key) => { keys.set(sessionID, key) },
    release: (sessionID) => { keys.delete(sessionID) },
    keyOf(session) {
      const own = keys.get(session.id)
      if (own) return own
      const inherited = session.parentID === undefined ? undefined : keys.get(session.parentID)
      if (!inherited) throw instanceRefusal(`OpenCode session ${session.id} has no Claxedo instance`)
      keys.set(session.id, inherited)
      return inherited
    },
    plugin(key) {
      const document = documents.get(key)
      if (!document) throw instanceRefusal(`OpenCode instance ${key} has no launch document`)
      return launchPolicyPlugin(document, (ready) => { readiness.set(key, ready) })
    },
    ready(sessionID) {
      const key = keys.get(sessionID)
      const ready = key === undefined ? undefined : readiness.get(key)
      if (!ready) throw instanceRefusal(`OpenCode session ${sessionID} has no configured instance`)
      return ready
    },
  }
}
