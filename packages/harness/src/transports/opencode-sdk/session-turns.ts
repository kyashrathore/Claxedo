import type { OpenCodeHost } from "./host.js"
import { asNumber as num, asRecord as rec, asString as str } from "@claxedo/helpers/guards"
import { ownedClient } from "./session-management.js"
import { projectMessage, fileAttachment, agentAttachment, skillAttachment } from "./session-projection.js"
import type { AdmittedMessage, OpenCodeSessionPort, PromptRequest } from "./session-types.js"
import type { WorkspaceScope } from "./scope.js"

async function admitPrompt(host: OpenCodeHost, scope: WorkspaceScope, sessionID: string, request: PromptRequest): Promise<AdmittedMessage> {
      const client = await ownedClient(host, scope, sessionID)
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
}

function promptPort(host: OpenCodeHost): Pick<OpenCodeSessionPort, "prompt" | "command" | "interrupt" | "wait"> {
  return {
    prompt: (scope, sessionID, request) => admitPrompt(host, scope, sessionID, request),
    async command(scope, sessionID, input) {
      const client = await ownedClient(host, scope, sessionID)
      await client.sessions.command({
        sessionID,
        command: input.command,
        text: input.text ?? "",
        ...(input.delivery === undefined ? {} : { delivery: input.delivery }),
      })
    },
    async interrupt(scope, sessionID, options) {
      const client = await ownedClient(host, scope, sessionID)
      await client.sessions.interrupt({
        sessionID,
        ...(options?.continue === undefined ? {} : { continue: options.continue }),
      })
    },
    async wait(scope, sessionID) {
      await (await ownedClient(host, scope, sessionID)).sessions.wait({ sessionID })
    },
  }
}

function historyPort(host: OpenCodeHost): Pick<OpenCodeSessionPort, "messages"> {
  return {
    async messages(scope, sessionID, page) {
      const client = await ownedClient(host, scope, sessionID)
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
}

export function sessionTurns(host: OpenCodeHost): Pick<OpenCodeSessionPort,
  "prompt" | "command" | "interrupt" | "wait" | "messages"> {
  return { ...promptPort(host), ...historyPort(host) }
}
