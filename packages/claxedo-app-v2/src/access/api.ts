import { queryOptions } from "@tanstack/solid-query"
import { orgId, userId, type AppError, type ErrorClass, type OrgRole, type Server, type SessionRef } from "@/server"
import type { OrgMember, OrgMembers, SessionCapabilities, SessionShare, SessionShares, ShareInvitee, ShareLevel, ShareRecipient } from "./model"

const orgRole = (value: unknown): OrgRole | undefined =>
  value === "owner" || value === "admin" || value === "member" ? value : undefined

const errorClass = (status: number): ErrorClass => {
  if (status === 401 || status === 403) return "auth"
  if (status === 404 || status === 501) return "not_found"
  if (status === 409) return "conflict"
  if (status === 429) return "rate_limit"
  return status >= 400 && status < 500 ? "invalid" : "internal"
}

async function request(path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(path, { credentials: "include", ...init })
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => undefined)
    const message = readMessage(body) ?? `Request failed (${response.status})`
    const failure: AppError = { class: errorClass(response.status), message, retryable: response.status >= 500, status: response.status }
    throw failure
  }
  return response.json()
}

function readMessage(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) return undefined
  const error = (body as { error?: unknown }).error
  if (typeof error !== "object" || error === null) return undefined
  const message = (error as { message?: unknown }).message
  return typeof message === "string" ? message : undefined
}

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {}

const asString = (value: unknown) => (typeof value === "string" ? value : undefined)

function shareRow(value: unknown): SessionShare | undefined {
  const row = asRecord(value)
  const id = asString(row.grant_id)
  if (!id) return undefined
  const level: ShareLevel = row.level === "send" ? "send" : "follow"
  const toOrg = asString(row.granted_to_org_id)
  const toUser = asString(row.granted_to_user_id)
  if (toOrg) return { id, level, to: { kind: "org", orgId: orgId(toOrg) } }
  if (toUser) return { id, level, to: { kind: "user", userId: userId(toUser) } }
  return undefined
}

function sharesFromWire(value: unknown): SessionShares {
  const body = asRecord(value)
  const grants = Array.isArray(body.grants) ? body.grants : []
  const participants = Array.isArray(body.participants) ? body.participants : []
  return {
    canManageShares: body.can_manage_shares === true,
    shares: grants.flatMap((row) => {
      const share = shareRow(row)
      return share ? [share] : []
    }),
    participants: participants.flatMap((row) => {
      const id = asString(asRecord(row).user_id)
      return id ? [{ userId: userId(id) }] : []
    }),
  }
}

const directoryOf = (server: Server, ref: SessionRef) => server.placements.byId(ref.placementId)?.path

const sessionKey = (ref: SessionRef) => [ref.placementId, ref.sessionId] as const

export function sessionCapabilitiesQuery(server: Server, ref: SessionRef) {
  return queryOptions({
    queryKey: ["access", "session-capabilities", ...sessionKey(ref)],
    queryFn: async (): Promise<SessionCapabilities> => {
      const directory = directoryOf(server, ref)
      const query = directory ? `?directory=${encodeURIComponent(directory)}` : ""
      const body = asRecord(await request(`/session/${encodeURIComponent(ref.sessionId)}/capabilities${query}`))
      return { prompt: body.prompt === true }
    },
    staleTime: Infinity,
    gcTime: 10 * 60_000,
  })
}

export function sessionSharesQuery(ref: SessionRef) {
  return queryOptions({
    queryKey: ["access", "session-shares", ...sessionKey(ref)],
    queryFn: async (): Promise<SessionShares> => {
      const path = `/api/control/sessions/${encodeURIComponent(ref.sessionId)}/shares?workspaceId=${encodeURIComponent(ref.placementId)}`
      return sharesFromWire(await request(path))
    },
    staleTime: Infinity,
    gcTime: 10 * 60_000,
  })
}

function recipientBody(to: ShareRecipient | ShareInvitee) {
  switch (to.kind) {
    case "identifier":
      return { grantedToTokenIdentifier: to.identifier }
    case "user":
      return { grantedToUserId: to.userId }
    case "org":
      return { grantedToOrgId: to.orgId }
  }
}

export async function grantShare(ref: SessionRef, input: { level: ShareLevel; to: ShareRecipient | ShareInvitee }) {
  await request(`/api/control/sessions/${encodeURIComponent(ref.sessionId)}/shares`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ workspaceId: ref.placementId, level: input.level, ...recipientBody(input.to) }),
  })
}

export async function revokeShare(ref: SessionRef, shareId: string) {
  await request(`/api/control/sessions/${encodeURIComponent(ref.sessionId)}/shares`, {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ workspaceId: ref.placementId, grantId: shareId }),
  })
}

export function orgMembersQuery() {
  return queryOptions({
    queryKey: ["access", "org-members"],
    queryFn: async (): Promise<OrgMembers> => {
      const response = await fetch("/api/control/orgs/members", { credentials: "include" })
      if (response.status === 404 || response.status === 501) return { kind: "unavailable" }
      if (!response.ok) throw { class: errorClass(response.status), message: `Members unavailable (${response.status})`, retryable: false, status: response.status } satisfies AppError
      const rows = asRecord(await response.json()).members
      const members = (Array.isArray(rows) ? rows : []).flatMap((row): OrgMember[] => {
        const member = asRecord(row)
        const id = asString(member.user_id)
        const role = orgRole(member.role)
        if (!id || !role) return []
        const email = asString(member.email)
        return [{ userId: userId(id), label: asString(member.display_name) ?? email ?? id, ...(email ? { email } : {}), role }]
      })
      return { kind: "listed", members }
    },
    staleTime: Infinity,
    gcTime: 10 * 60_000,
  })
}
