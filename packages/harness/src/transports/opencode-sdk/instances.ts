import { createHash } from "node:crypto"
import type { Plugin } from "@opencode-ai/plugin"
import { TransportError } from "../../contract/errors.js"
import { launchPolicyPlugin, type InstanceContext, type OpenCodeLaunchDocument } from "./launch-policy.js"

export type InstanceSession = Readonly<{ id: string; parentID?: string }>

export type OpenCodeInstances = Readonly<{
  define(directory: string, document: OpenCodeLaunchDocument): string
  assign(sessionID: string, key: string): void
  release(sessionID: string): void
  keyOf(session: InstanceSession): string
  plugin(key: string): Plugin.Plugin
  ready(sessionID: string): Promise<readonly string[]>
  commands(sessionID: string): Promise<unknown>
}>

function instanceRefusal(message: string): TransportError {
  return new TransportError("opencode", "session", message)
}

class InstanceRegistry implements OpenCodeInstances {
  private readonly documents = new Map<string, OpenCodeLaunchDocument>()
  private readonly keys = new Map<string, string>()
  private readonly parents = new Map<string, string>()
  private readonly contexts = new Map<string, InstanceContext>()
  private readonly reported = new Set<string>()

  define(directory: string, document: OpenCodeLaunchDocument): string {
    const key = createHash("sha256").update(JSON.stringify([directory, document])).digest("hex")
    this.documents.set(key, document)
    return key
  }

  assign(sessionID: string, key: string): void { this.keys.set(sessionID, key) }

  release(sessionID: string): void { this.keys.delete(sessionID) }

  keyOf(session: InstanceSession): string {
    if (session.parentID !== undefined && !this.keys.has(session.id)) this.parents.set(session.id, session.parentID)
    const key = this.resolve(session.id)
    if (!key) throw instanceRefusal(`OpenCode session ${session.id} has no Claxedo instance`)
    return key
  }

  plugin(key: string): Plugin.Plugin {
    const document = this.documents.get(key)
    if (!document) throw instanceRefusal(`OpenCode instance ${key} has no launch document`)
    return launchPolicyPlugin(document, (opened) => { this.contexts.set(key, opened) })
  }

  async ready(sessionID: string): Promise<readonly string[]> {
    const { key, opened } = this.context(sessionID)
    const unsettled = await opened.settled
    if (this.reported.has(key)) return []
    this.reported.add(key)
    return unsettled
  }

  async commands(sessionID: string): Promise<unknown> {
    const { opened } = this.context(sessionID)
    await opened.settled
    return opened.commands()
  }

  private resolve(sessionID: string): string | undefined {
    const parent = this.parents.get(sessionID)
    return this.keys.get(sessionID) ?? (parent === undefined ? undefined : this.resolve(parent))
  }

  private context(sessionID: string): { key: string; opened: InstanceContext } {
    const key = this.resolve(sessionID)
    const opened = key === undefined ? undefined : this.contexts.get(key)
    if (key === undefined || !opened) throw instanceRefusal(`OpenCode session ${sessionID} has no configured instance`)
    return { key, opened }
  }
}

export function createInstances(): OpenCodeInstances {
  return new InstanceRegistry()
}
