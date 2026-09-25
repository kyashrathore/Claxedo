import type { OpenCodeHost } from "./host"
import type { OpenCodeSessionPort } from "./session-types"
import { project, projectMessage, fileAttachment, agentAttachment, skillAttachment } from "./session-projection"

export function openCodePartId(messageID: string, role: string, content: { id?: unknown }, ordinal: number): string {
  if (role === "user") return `${messageID}:text`
  return typeof content.id === "string" ? content.id : `${messageID}:${String(ordinal).padStart(6, "0")}`
}

export * from "./session-types"

export function createSessionPort(host: OpenCodeHost): OpenCodeSessionPort {
  const port: OpenCodeSessionPort = {
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
      const row = await client.sessions.get({ sessionID })
      return project(scope, row)
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

    async rename(scope, sessionID, title) {
      const client = await host.client()
      await port.get(scope, sessionID)
      await client.sessions.rename({ sessionID, title })
    },

    async remove(scope, sessionID) {
      const client = await host.client()
      await port.get(scope, sessionID)
      await client.sessions.remove({ sessionID })
    },

    async fork(scope, sessionID, boundary) {
      const client = await host.client()
      await port.get(scope, sessionID)
      const forked = await client.sessions.fork({ sessionID, boundary })
      return project(scope, forked)
    },

    async switchAgent(scope, sessionID, agent) {
      const client = await host.client()
      await port.get(scope, sessionID)
      await client.sessions.switchAgent({ sessionID, agent })
    },

    async switchModel(scope, sessionID, model) {
      const client = await host.client()
      await port.get(scope, sessionID)
      await client.sessions.switchModel({
        sessionID,
        model: { providerID: model.providerID, id: model.modelID, ...(model.variant ? { variant: model.variant } : {}) },
      })
    },

    async prompt(scope, sessionID, request) {
      const client = await host.client()
      await port.get(scope, sessionID)
      const admitted = await client.sessions.prompt({
        sessionID,
        text: request.text,
        ...(request.id === undefined ? {} : { id: request.id }),
        ...(request.files === undefined ? {} : { files: request.files.map(fileAttachment) }),
        ...(request.agents === undefined ? {} : { agents: request.agents.map(agentAttachment) }),
        ...(request.skills === undefined ? {} : { skills: request.skills.map(skillAttachment) }),
        ...(request.metadata === undefined ? {} : { metadata: request.metadata }),
        ...(request.delivery === undefined ? {} : { delivery: request.delivery }),
        ...(request.resume === undefined ? {} : { resume: request.resume }),
      })
      const row = rec(admitted) ?? {}
      const delivery = str(row.delivery)
      return {
        id: str(row.id) ?? "",
        sessionID: str(row.sessionID) ?? sessionID,
        createdAt: num(row.timeCreated) ?? 0,
        text: str(rec(row.payload)?.text) ?? request.text,
        ...(delivery === "steer" || delivery === "queue" ? { delivery } : {}),
      }
    },

    async command(scope, sessionID, input) {
      const client = await host.client()
      await port.get(scope, sessionID)
      await client.sessions.command({
        sessionID,
        command: input.command,
        text: input.text ?? "",
        ...(input.delivery === undefined ? {} : { delivery: input.delivery }),
      })
    },

    async interrupt(scope, sessionID, options) {
      const client = await host.client()
      await port.get(scope, sessionID)
      await client.sessions.interrupt({
        sessionID,
        ...(options?.continue === undefined ? {} : { continue: options.continue }),
      })
    },

    async revertTo(scope, sessionID, messageID, options) {
      const client = await host.client()
      await port.get(scope, sessionID)
      await client.sessions.revert.stage({
        sessionID,
        messageID,
        ...(options?.files === undefined ? {} : { files: options.files }),
      })
    },

    async clearRevert(scope, sessionID) {
      const client = await host.client()
      await port.get(scope, sessionID)
      await client.sessions.revert.clear({ sessionID })
    },

    async messages(scope, sessionID, page) {
      const client = await host.client()
      await port.get(scope, sessionID)
      const response = await client.message.list({
        sessionID,
        ...(page?.limit === undefined ? {} : { limit: page.limit }),
        ...(page?.cursor === undefined ? {} : { cursor: page.cursor }),
        ...(page?.order === undefined ? {} : { order: page.order }),
      })
      return {
        messages: response.data.map((row) => projectMessage(row)),
        ...(response.cursor.previous ? { previous: response.cursor.previous } : {}),
        ...(response.cursor.next ? { next: response.cursor.next } : {}),
      }
    },
  }
  return port
}
