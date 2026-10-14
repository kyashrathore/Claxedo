import type { SessionHarness } from "@claxedo/agent-runtime-contract"
import { readField, readString } from "@claxedo/helpers/readers"
import type { SessionReservation } from "@/server"
import type { Json } from "@/shell"

function decodeReservedHarness(value: unknown): SessionHarness | undefined {
  const id = readString(value, "id")
  const access = readString(value, "access")
  return id && (access === "native" || access === "connection") ? { id, access } : undefined
}

export function decodeHeldReservation(value: unknown): SessionReservation | undefined {
  const workspaceId = readString(value, "workspaceId")
  const sessionId = readString(value, "sessionId")
  const operationId = readString(value, "operationId")
  const sessionHostRoot = readString(value, "sessionHostRoot")
  const title = readString(value, "title")
  const harness = decodeReservedHarness(readField(value, "harness"))
  if (!workspaceId || !sessionId || !operationId) return undefined
  return {
    workspaceId,
    sessionId,
    operationId,
    ...(sessionHostRoot ? { sessionHostRoot } : {}),
    ...(title ? { title } : {}),
    ...(harness ? { harness } : {}),
  }
}

export function encodeHeldReservation(reservation: SessionReservation): Json {
  return {
    workspaceId: reservation.workspaceId,
    sessionId: reservation.sessionId,
    operationId: reservation.operationId,
    ...(reservation.sessionHostRoot ? { sessionHostRoot: reservation.sessionHostRoot } : {}),
    ...(reservation.title ? { title: reservation.title } : {}),
    ...(reservation.harness ? { harness: { id: reservation.harness.id, access: reservation.harness.access } } : {}),
  }
}
