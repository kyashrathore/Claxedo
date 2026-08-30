import type { Plugin } from "@opencode-ai/plugin"
import type { OpenCodeHost } from "./host"

export type SessionTool = Readonly<{
  name: string
  description: string
  inputSchema: Readonly<Record<string, unknown>>
  outputSchema?: Readonly<Record<string, unknown>>
  /** Group-specific callback when one Session merges tools from several owners. */
  callbackUrl?: string
}>

export type SessionToolRegistration = Readonly<{
  sessionID: string
  callbackUrl: string
  tools: readonly SessionTool[]
}>

export type OpenCodeToolPort = Readonly<{
  registerSession(input: SessionToolRegistration): Promise<void>
  unregisterSession(sessionID: string): Promise<void>
}>

function sameDefinition(left: SessionTool, right: SessionTool) {
  return left.description === right.description
    && JSON.stringify(left.inputSchema) === JSON.stringify(right.inputSchema)
    && JSON.stringify(left.outputSchema) === JSON.stringify(right.outputSchema)
}

/** Register Session tools through the SDK plugin API, never a private route. */
export function createToolPort(host: OpenCodeHost): OpenCodeToolPort {
  const sessions = new Map<string, SessionToolRegistration>()
  let reload: (() => Promise<void>) | undefined
  let installing: Promise<void> | undefined

  const plugin: Plugin.Plugin = {
    id: "claxedo-session-tools",
    async setup(context) {
      await context.tool.transform((draft) => {
        const definitions = new Map<string, SessionTool>()
        for (const registration of sessions.values()) {
          for (const tool of registration.tools) {
            const existing = definitions.get(tool.name)
            if (existing && !sameDefinition(existing, tool)) {
              throw new Error(`Conflicting OpenCode Session tool definition for ${tool.name}`)
            }
            definitions.set(tool.name, tool)
          }
        }
        for (const tool of definitions.values()) {
          draft.add({
            name: tool.name,
            description: tool.description,
            input: tool.inputSchema as never,
            async execute(input: unknown, toolContext: { sessionID: unknown; id: unknown }) {
              const registration = sessions.get(String(toolContext.sessionID))
              const active = registration?.tools.find((candidate) => candidate.name === tool.name)
              if (!registration || !active) {
                throw new Error(`Tool ${tool.name} is not registered for Session ${String(toolContext.sessionID)}`)
              }
              const response = await fetch(active.callbackUrl ?? registration.callbackUrl, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                  sessionID: String(toolContext.sessionID),
                  name: tool.name,
                  toolCallID: String(toolContext.id),
                  input,
                }),
              })
              const body = await response.text()
              if (!response.ok) throw new Error(`Claxedo tool ${tool.name} failed (${response.status}): ${body}`)
              const value = body ? JSON.parse(body) : null
              return { content: typeof value === "string" ? value : JSON.stringify(value) }
            },
          } as never)
        }
      })
      reload = context.tool.reload
      return () => {
        reload = undefined
      }
    },
  }

  async function ensureInstalled() {
    installing ??= host.client().then((client) => client.plugin(plugin))
    await installing
  }

  return {
    async registerSession(input) {
      sessions.set(input.sessionID, input)
      await ensureInstalled()
      await reload?.()
    },
    async unregisterSession(sessionID) {
      if (!sessions.delete(sessionID)) return
      if (installing) {
        await installing
        await reload?.()
      }
    },
  }
}
