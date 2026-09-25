import type { Plugin } from "@opencode-ai/plugin"
import { openCodeLocationClient, type OpenCodeHost } from "./host.js"
import type { WorkspaceScope } from "./scope.js"

export type SessionTool = Readonly<{
  name: string
  description: string
  inputSchema: Readonly<Record<string, unknown>>
  outputSchema?: Readonly<Record<string, unknown>>

  callbackUrl?: string
}>

export type SessionToolRegistration = Readonly<{
  scope: WorkspaceScope
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
}

function createToolPlugin(
  sessions: Map<string, SessionToolRegistration>, reloads: Map<string, () => Promise<void>>,
): Plugin.Plugin {
  return {
    id: "claxedo-session-tools",
    async setup(context) {
      await context.tool.transform((draft) => {
        const definitions = definitionsFor(sessions, context.location.directory)
        for (const tool of definitions.values()) {
          draft.add({
            name: tool.name,
            description: tool.description,
            input: tool.inputSchema,
            execute: (input: unknown, toolContext: { sessionID: unknown; id: unknown }) =>
              executeTool(sessions, context.location.directory, tool, input, toolContext),
          })
        }
      })
      reloads.set(context.location.directory, context.tool.reload)
      return () => {
        if (reloads.get(context.location.directory) === context.tool.reload) reloads.delete(context.location.directory)
      }
    },
  }
}

export function createToolPort(host: OpenCodeHost): OpenCodeToolPort {
  const sessions = new Map<string, SessionToolRegistration>()
  const reloads = new Map<string, () => Promise<void>>()
  let installing: Promise<void> | undefined
  const plugin = createToolPlugin(sessions, reloads)

  async function ensureInstalled() {
    installing ??= host.client().then((client) => client.plugin(plugin)).catch((error) => {
      installing = undefined
      throw error
    })
    await installing
  }

  return toolOperations(host, sessions, reloads, ensureInstalled, () => installing)
}

function toolOperations(
  host: OpenCodeHost,
  sessions: Map<string, SessionToolRegistration>,
  reloads: Map<string, () => Promise<void>>,
  ensureInstalled: () => Promise<void>,
  installed: () => Promise<void> | undefined,
): OpenCodeToolPort {
  return {
    async registerSession(input) {
      const previous = sessions.get(input.sessionID)
      if (previous && previous.scope.directory !== input.scope.directory) throw new Error("Session tools belong to another workspace")
      sessions.set(input.sessionID, input)
      try {
        await ensureInstalled()
        await openCodeLocationClient(host, input.scope.directory)
        const reload = reloads.get(input.scope.directory)
        if (!reload) throw new Error("OpenCode tool plugin was not initialized for the workspace")
        await reload()
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
      const pending = installed()
      if (pending) {
        await pending
        await reloads.get(registration.scope.directory)?.()
      }
    },
  }
}
