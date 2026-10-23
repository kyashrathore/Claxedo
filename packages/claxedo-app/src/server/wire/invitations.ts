import { isFiniteNumber, isNonBlankString, isRecord } from "@claxedo/helpers/guards"
import type { MintedInvitation } from "../machine-types"

export function mintedInvitationFromWire(raw: unknown): MintedInvitation | undefined {
  if (!isRecord(raw) || !isNonBlankString(raw.invitation_id) || !isFiniteNumber(raw.expires_at)) return undefined
  const commands = raw.commands
  if (!isRecord(commands) || !isNonBlankString(commands.posix) || !isNonBlankString(commands.windows) || !isNonBlankString(commands.cloudInit)) return undefined
  return { id: raw.invitation_id, expiresAt: raw.expires_at, commands: { posix: commands.posix, windows: commands.windows, cloudInit: commands.cloudInit } }
}
