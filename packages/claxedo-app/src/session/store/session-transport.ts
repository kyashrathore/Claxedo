import { createHttpSessionBackend } from "../../shared/data/http-backend"
import type { SessionMessageRow } from "../../shared/data/types"

type SessionClient = Parameters<typeof createHttpSessionBackend>[0]["client"]

export function usesClaxedoSessionTransport(sessionID: string | undefined) {
  return !!sessionID && !sessionID.startsWith("ses")
}

export async function fetchSessionByTransport(input: {
  client: SessionClient
  directory: string
  sessionID: string
}) {
  return await createHttpSessionBackend({
    client: input.client,
  }).getSession(input)
}

export async function fetchSessionMessagesByTransport(input: {
  client: SessionClient
  directory: string
  sessionID: string
  limit: number
  before?: string
}) {
  return await createHttpSessionBackend({
    client: input.client,
  }).listMessages(input)
}

export async function fetchSessionTodoByTransport(input: {
  client: SessionClient
  directory: string
  sessionID: string
}) {
  return await createHttpSessionBackend({
    client: input.client,
  }).listTodos(input)
}
