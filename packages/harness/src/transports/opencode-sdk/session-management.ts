import type { OpenCodeHost, OpenCodeClient } from "./host.js"
import { project } from "./session-projection.js"
import type { OpenCodeSessionPort } from "./session-types.js"
import type { WorkspaceScope } from "./scope.js"

export async function ownedClient(host: OpenCodeHost, scope: WorkspaceScope, sessionID: string): Promise<OpenCodeClient> {
  const client = await host.client()
  project(scope, await client.sessions.get({ sessionID }))
  return client
}

function sessionDirectory(host: OpenCodeHost): Pick<OpenCodeSessionPort, "create" | "get" | "list"> {
  return {
    async create(scope, input) {
      const client = await host.client()
      const created = await client.sessions.create({
        location: { directory: scope.directory },
        ...(input?.id ? { id: input.id } : {}),
        ...(input?.title ? { title: input.title } : {}),
      })
      return project(scope, created)
    },
    async get(scope, sessionID) {
      const client = await host.client()
      return project(scope, await client.sessions.get({ sessionID }))
    },
    async list(scope, input) {
      const client = await host.client()
      const page = await client.sessions.list({
        directory: scope.directory,
        ...(input?.limit === undefined ? {} : { limit: input.limit }),
        ...(input?.cursor === undefined ? {} : { cursor: input.cursor }),
      })
      return {
        sessions: page.data.map((row) => project(scope, row)),
        ...(page.cursor.previous ? { previous: page.cursor.previous } : {}),
        ...(page.cursor.next ? { next: page.cursor.next } : {}),
      }
    },
  }
}

function sessionChanges(host: OpenCodeHost): Pick<OpenCodeSessionPort, "rename" | "remove" | "fork" | "switchAgent" | "switchModel"> {
  return {
    async rename(scope, sessionID, title) {
      await (await ownedClient(host, scope, sessionID)).sessions.rename({ sessionID, title })
    },
    async remove(scope, sessionID) {
      await (await ownedClient(host, scope, sessionID)).sessions.remove({ sessionID })
    },
    async fork(scope, sessionID, boundary) {
      const client = await ownedClient(host, scope, sessionID)
      return project(scope, await client.sessions.fork({ sessionID, boundary }))
    },
    async switchAgent(scope, sessionID, agent) {
      await (await ownedClient(host, scope, sessionID)).sessions.switchAgent({ sessionID, agent })
    },
    async switchModel(scope, sessionID, model) {
      const client = await ownedClient(host, scope, sessionID)
      await client.sessions.switchModel({
        sessionID,
        model: { providerID: model.providerID, id: model.modelID, ...(model.variant ? { variant: model.variant } : {}) },
      })
    },
  }
}

export function sessionManagement(host: OpenCodeHost): Pick<OpenCodeSessionPort,
  "create" | "get" | "list" | "rename" | "remove" | "fork" | "switchAgent" | "switchModel"> {
  return { ...sessionDirectory(host), ...sessionChanges(host) }
}
