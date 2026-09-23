import { asRecord, asString } from "@claxedo/helpers/guards"
import { authFetch as defaultAuthFetch, getClaxedoServerUrl, normalizeUrl } from "@/platform/api/api"
import { signedAccountRun } from "@/platform/account/hosted-control-call"
import { decodeHostedResult } from "@/platform/account/hosted-operations"
import { controlSessionListUrl } from "@/platform/runtime/agent/workspace-control-routes"
import { readArray } from "@/lib/record"
import type { SessionOwner } from "../query/types"

/**
 * The control plane's session records for one workspace.
 *
 * The registry is not the authority for WHICH sessions a workspace holds — the
 * machine serving it is — but it is the authority for who created one and who
 * it is shared with, because sharing is a control-plane grant and the runtime
 * has no notion of a user at all. So both the flat inventory and the rail's
 * rows for such a workspace read these records, and they read them through here
 * rather than each spelling out the bridge/HTTP pair and the owner field names.
 *
 * Uncached on purpose: the two callers cache under different contracts — the
 * inventory dedupes a boot fan-out for a few seconds, the rail's owner join
 * rides the workspace row memo the share doorbell drops — and a single cache
 * here would give one of them the other's staleness.
 */
export async function requestControlPlaneSessions(input: {
  baseUrl?: string
  workspaceId: string
  request?: typeof fetch
}): Promise<unknown[]> {
  const run = await signedAccountRun()
  if (run) {
    const sessions = readArray(
      decodeHostedResult("session.list", await run("session.list", { workspaceId: input.workspaceId })),
      "sessions",
    )
    if (!sessions) throw new Error("session.list returned an invalid sessions payload")
    return sessions
  }
  const request = input.request ?? defaultAuthFetch
  const res = await request(controlSessionListUrl({
    baseUrl: normalizeUrl(input.baseUrl) ?? getClaxedoServerUrl(),
    workspaceId: input.workspaceId,
  }), { headers: { Accept: "application/json" } })
  if (!res.ok) throw new Error(`Control-plane session list failed with ${res.status}`)
  const sessions = readArray(await res.json(), "sessions")
  if (!sessions) throw new Error("Control-plane session list returned an invalid sessions payload")
  return sessions
}

/**
 * The session a control-plane record is about.
 *
 * The registry answers `session_id`; a record that reached the client through
 * the desktop bridge or an older route carries `sessionID` or `id` for the same
 * field, so every reader of these records accepts all three.
 */
export function controlPlaneSessionId(record: unknown) {
  const row = asRecord(record)
  return asString(row?.session_id) ?? asString(row?.sessionID) ?? asString(row?.id)
}

/**
 * The creator carried by one control-plane session record.
 *
 * The record omits the creator entirely when the reader IS the creator
 * (`publicSession` in the sqlite authority), which is what makes an owner mark
 * mean "someone else's session" on every lane without the rail having to know
 * who is looking. The field names mirror `ownerFromSession` in server-core's
 * navigation list, the mapper the cloud lane's rows already come shaped by.
 */
export function controlPlaneSessionOwner(record: unknown): SessionOwner | undefined {
  const row = asRecord(record)
  if (!row) return undefined
  const nested = asRecord(row.owner)
  const name = asString(nested?.name) ?? asString(row.owner_name) ?? asString(row.ownerName)
  const avatarUrl = asString(nested?.avatarUrl)
    ?? asString(nested?.avatar_url)
    ?? asString(row.owner_avatar_url)
    ?? asString(row.ownerAvatarUrl)
  const publicId = asString(nested?.publicId)
    ?? asString(nested?.public_id)
    ?? asString(row.owner_public_id)
    ?? asString(row.ownerPublicId)
  if (!name && !avatarUrl && !publicId) return undefined
  return {
    ...(name ? { name } : {}),
    ...(avatarUrl ? { avatarUrl } : {}),
    ...(publicId ? { publicId } : {}),
  }
}

/** The creators of a workspace's control-plane records, by session id. */
export function controlPlaneSessionOwners(records: readonly unknown[]): Map<string, SessionOwner> {
  const owners = new Map<string, SessionOwner>()
  for (const record of records) {
    const sessionId = controlPlaneSessionId(record)
    const owner = controlPlaneSessionOwner(record)
    if (sessionId && owner) owners.set(sessionId, owner)
  }
  return owners
}
