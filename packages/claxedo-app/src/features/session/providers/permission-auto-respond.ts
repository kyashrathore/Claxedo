import { base64Encode } from "@opencode-ai/core/util/encode"
import {
  ACP_SAFE_TOOL_KINDS,
  IN_PROJECT_WRITE_PERMISSIONS,
  INTERACTIVE_PERMISSIONS,
  SAFE_READ_PERMISSIONS,
} from "@/features/session/permission/modes"

/**
 * The permission types "Approve for me" may answer on the user's behalf.
 *
 * This is the tiering Claude Code's auto mode and Codex's `on-request` policy
 * both use: reads and in-project edits carry no real downside (edits are
 * reviewable in version control), so they are approved silently, and everything
 * with actual blast radius — shell, network, anything outside the project,
 * subagent spawns — still reaches the user.
 *
 * Membership is an ALLOWLIST, so anything not named here asks. That matters more
 * than it looks: opencode's permission namespace has an open tail (MCP tool
 * names, subagent ids, the shell tool id are all dynamic), and a denylist would
 * silently auto-approve every future or third-party tool.
 *
 * Deliberately a scan over the readonly tiers rather than a module-scope `Set`:
 * a handful of entries makes the lookup cost irrelevant, and a module-level Set
 * is mutable shared state.
 */
export function isAutoApprovablePermission(permission: string | undefined) {
  if (!permission) return false
  // Must stay the same set as `CLAXEDO_AUTO_ANSWERS` in modes.ts — that constant
  // describes what Auto approves and this function decides it, so a divergence
  // means the documented behaviour and the running behaviour disagree. It did:
  // `question` (the agent asking the USER something, never worth gating) was in
  // the constant but missing here.
  const tiers: readonly string[][] = [
    [...SAFE_READ_PERMISSIONS],
    [...ACP_SAFE_TOOL_KINDS],
    [...INTERACTIVE_PERMISSIONS],
    [...IN_PROJECT_WRITE_PERMISSIONS],
  ]
  return tiers.some((tier) => tier.includes(permission))
}

export function acceptKey(sessionID: string, directory?: string) {
  if (!directory) return sessionID
  return `${base64Encode(directory)}/${sessionID}`
}

export function directoryAcceptKey(directory: string) {
  return `${base64Encode(directory)}/*`
}

function accepted(autoAccept: Record<string, boolean>, sessionID: string, directory?: string) {
  const key = acceptKey(sessionID, directory)
  const directoryKey = directory ? directoryAcceptKey(directory) : undefined
  return autoAccept[key] ?? autoAccept[sessionID] ?? (directoryKey ? autoAccept[directoryKey] : undefined)
}

export function isDirectoryAutoAccepting(autoAccept: Record<string, boolean>, directory: string) {
  const key = directoryAcceptKey(directory)
  return autoAccept[key] ?? false
}

function sessionLineage(session: { id: string; parentID?: string }[], sessionID: string) {
  const parent = session.reduce((acc, item) => {
    if (item.parentID) acc.set(item.id, item.parentID)
    return acc
  }, new Map<string, string>())
  const seen = new Set([sessionID])
  const ids = [sessionID]

  for (const id of ids) {
    const parentID = parent.get(id)
    if (!parentID || seen.has(parentID)) continue
    seen.add(parentID)
    ids.push(parentID)
  }

  return ids
}

/**
 * Whether Claxedo should answer this permission request itself.
 *
 * Two independent conditions, both required:
 *   1. the switch is on for this session (or an ancestor, or the directory), and
 *   2. the request is for a permission type in `AUTO_APPROVABLE`.
 *
 * Condition 2 is what makes this "Approve for me" rather than "approve
 * everything". Callers that only want to know whether the SWITCH is on — the
 * control's own checked state — omit `permission` and get condition 1 alone.
 */
export function autoRespondsPermission(
  autoAccept: Record<string, boolean>,
  session: { id: string; parentID?: string }[],
  permission: { sessionID: string; permission?: string },
  directory?: string,
) {
  const value = sessionLineage(session, permission.sessionID)
    .map((id) => accepted(autoAccept, id, directory))
    .find((item): item is boolean => item !== undefined)
  if (!(value ?? false)) return false
  // A request with no type is a switch-state query, not a real request.
  if (!("permission" in permission)) return true
  return isAutoApprovablePermission(permission.permission)
}

export function autoRespondablePermissions<T extends { sessionID: string; permission?: string }>(
  autoAccept: Record<string, boolean>,
  sessions: { id: string; parentID?: string }[],
  permissions: T[],
  directory?: string,
) {
  return permissions.filter((permission) =>
    autoRespondsPermission(autoAccept, sessions, permission, directory)
  )
}

export type PermissionAutoReconciliationState = "pending" | "ready" | "failed"

export async function reconcileAutoPermissionRequests<T extends {
  id?: string
  sessionID: string
  permission?: string
}>(input: {
  directory?: string
  active(): boolean
  autoAccept(): Record<string, boolean>
  sessions(): { id: string; parentID?: string }[]
  list(): Promise<T[]>
  respond(permission: T): void
}): Promise<PermissionAutoReconciliationState> {
  try {
    const permissions = await input.list()
    // A completed read belongs to the directory/policy generation that
    // started it. Navigation or provider teardown revokes its authority before
    // it can answer anything on the user's behalf.
    if (!input.active()) return "ready"
    for (const permission of autoRespondablePermissions(
      input.autoAccept(),
      input.sessions(),
      permissions,
      input.directory,
    )) {
      if (!permission.id || !input.active()) continue
      input.respond(permission)
    }
    return "ready"
  } catch {
    return input.active() ? "failed" : "ready"
  }
}

export function permissionRequestPolicyReady(
  persistedReady: boolean,
  reconciliation: PermissionAutoReconciliationState | undefined,
) {
  return persistedReady && reconciliation !== undefined && reconciliation !== "pending"
}

export function autoResponseOwnsPermission(input: {
  policyAutoResponds: boolean
  reconciliation: PermissionAutoReconciliationState | undefined
  responseFailed: boolean
}) {
  if (!input.policyAutoResponds || input.responseFailed) return false
  return input.reconciliation !== "failed"
}
