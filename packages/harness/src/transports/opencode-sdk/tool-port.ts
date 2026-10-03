import type { Plugin } from "@opencode-ai/plugin"
import type { SessionTool, SessionToolCall } from "../../contract"
import type { WorkspaceScope } from "./scope.js"

export type SessionToolRegistration = Readonly<{
  scope: WorkspaceScope
  sessionID: string
  execute(call: SessionToolCall): Promise<unknown>
  tools: readonly SessionTool[]
}>

export type OpenCodeToolPort = Readonly<{
  plugin: Plugin.Plugin
  registerSession(input: SessionToolRegistration): Promise<void>
  unregisterSession(sessionID: string): Promise<void>
}>

function sameDefinition(left: SessionTool, right: SessionTool) {
  return left.description === right.description
    && JSON.stringify(left.inputSchema) === JSON.stringify(right.inputSchema)
    && JSON.stringify(left.outputSchema) === JSON.stringify(right.outputSchema)
}

function definitionsFor(sessions: Map<string, SessionToolRegistration>, directory: string): Map<string, SessionTool> {
  const definitions = new Map<string, SessionTool>()
  for (const registration of sessions.values()) {
    if (registration.scope.directory !== directory) continue
    for (const tool of registration.tools) {
      const existing = definitions.get(tool.name)
      if (existing && !sameDefinition(existing, tool)) {
        throw new Error(`Conflicting OpenCode Session tool definition for ${tool.name}`)
      }
      definitions.set(tool.name, tool)
    }
  }
  return definitions
}

async function executeTool(
  sessions: Map<string, SessionToolRegistration>, directory: string, tool: SessionTool,
  input: unknown, toolContext: { sessionID: unknown; id: unknown },
) {
  const registration = sessions.get(String(toolContext.sessionID))
  const active = registration?.tools.find((candidate) => candidate.name === tool.name)
  if (!registration || !active || registration.scope.directory !== directory) {
    throw new Error(`Tool ${tool.name} is not registered for Session ${String(toolContext.sessionID)}`)
  }
  const value = await registration.execute({ name: tool.name, toolCallID: String(toolContext.id), input })
  return { content: typeof value === "string" ? value : JSON.stringify(value) }
}

function createToolPlugin(
  sessions: Map<string, SessionToolRegistration>, reloads: Map<string, Set<() => Promise<void>>>,
): Plugin.Plugin {
  return {
    id: "claxedo-session-tools",
    async setup(context) {
      const directory = context.location.directory
      await context.tool.transform((draft) => {
        for (const tool of definitionsFor(sessions, directory).values()) {
          draft.add({
            name: tool.name,
            description: tool.description,
            input: tool.inputSchema,
            options: { codemode: false },
            execute: (input: unknown, toolContext: { sessionID: unknown; id: unknown }) =>
              executeTool(sessions, directory, tool, input, toolContext),
          })
        }
      })
      await context.session.hook("context", (input) => {
        const offered = definitionsFor(sessions, directory)
        const own = new Set(sessions.get(String(input.sessionID))?.tools.map((tool) => tool.name))
        for (const name of Object.keys(input.tools)) if (offered.has(name) && !own.has(name)) delete input.tools[name]
      })
      const reload = () => context.tool.reload()
      const live = reloads.get(directory) ?? new Set()
      reloads.set(directory, live.add(reload))
      return () => { live.delete(reload) }
    },
  }
}

async function reloadDirectory(reloads: Map<string, Set<() => Promise<void>>>, directory: string): Promise<void> {
  await Promise.all([...reloads.get(directory) ?? []].map((reload) => reload()))
}

export function createToolPort(): OpenCodeToolPort {
  const sessions = new Map<string, SessionToolRegistration>()
  const reloads = new Map<string, Set<() => Promise<void>>>()
  return {
    plugin: createToolPlugin(sessions, reloads),
    async registerSession(input) {
      const previous = sessions.get(input.sessionID)
      if (previous && previous.scope.directory !== input.scope.directory) throw new Error("Session tools belong to another workspace")
      sessions.set(input.sessionID, input)
      try {
        await reloadDirectory(reloads, input.scope.directory)
      } catch (error) {
        if (previous) sessions.set(input.sessionID, previous)
        else sessions.delete(input.sessionID)
        throw error
      }
    },
    async unregisterSession(sessionID) {
      const registration = sessions.get(sessionID)
      if (!registration) return
      sessions.delete(sessionID)
      await reloadDirectory(reloads, registration.scope.directory)
    },
  }
}
