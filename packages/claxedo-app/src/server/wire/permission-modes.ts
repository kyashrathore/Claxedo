import { isRecord } from "@claxedo/helpers/guards"
import { ServerError } from "../errors"

export type PermissionMode = {
  readonly id: string
  readonly name: string
  readonly description?: string
  readonly level?: "ask" | "auto" | "full"
}

export type PermissionModeState = {
  readonly modes: readonly PermissionMode[]
  readonly currentModeId?: string
  readonly unsupported?: string
  readonly appliesFrom: "immediate" | "next-turn" | "next-session"
}

function modeOf(value: unknown): PermissionMode | undefined {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.name !== "string") return undefined
  const level = value.level === "ask" || value.level === "auto" || value.level === "full" ? value.level : undefined
  return {
    id: value.id,
    name: value.name,
    ...(typeof value.description === "string" ? { description: value.description } : {}),
    ...(level ? { level } : {}),
  }
}

export function permissionModeStateFromWire(body: unknown): PermissionModeState {
  if (!isRecord(body) || !Array.isArray(body.modes)) throw new ServerError({ class: "internal", message: "The permission modes answered without modes" })
  const appliesFrom = body.appliesFrom
  if (appliesFrom !== "immediate" && appliesFrom !== "next-turn" && appliesFrom !== "next-session") {
    throw new ServerError({ class: "internal", message: "The permission modes answered without valid delivery timing" })
  }
  return {
    modes: body.modes.flatMap((value) => {
      const mode = modeOf(value)
      return mode ? [mode] : []
    }),
    ...(typeof body.currentModeId === "string" ? { currentModeId: body.currentModeId } : {}),
    ...(typeof body.unsupported === "string" ? { unsupported: body.unsupported } : {}),
    appliesFrom,
  }
}
