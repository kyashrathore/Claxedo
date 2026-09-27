import type { DaytonaSecretLike, DaytonaSecretServiceLike } from "./daytona"

const SECRET_LIST_PAGE_SIZE = 200
const MAX_LIST_PAGES = 100
const REVOKED_SECRET_VALUE = "claxedo-revoked"

/**
 * Percent-encode a segment into `[A-Za-z0-9_]`, with `_` as the escape
 * character. Injective, which a character-class replacement is not: collapsing
 * every disallowed character to `-` made `A.B` and `A-B` the same org secret,
 * and left `-` doing double duty as both data and the segment separator.
 */
function encodeSecretSegment(value: string) {
  return encodeURIComponent(value)
    .replace(/[-_.!~*'()]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%/g, "_")
}

// Org-scoped Daytona secret names for a workspace. Namespaced per workspace so
// one workspace's secret can never be referenced by another, and so the prefix
// enumerates exactly this workspace's secrets.
function workspaceSecretPrefix(workspaceId: string) {
  return `claxedo-${encodeSecretSegment(workspaceId)}-`
}

export function daytonaSecretName(workspaceId: string, secretName: string) {
  return `${workspaceSecretPrefix(workspaceId)}${encodeSecretSegment(secretName)}`
}

/**
 * The env var name a workspace-prefixed org secret was minted for, or nothing
 * when the name did not come from `encodeSecretSegment` — a secret someone
 * created by hand under this prefix would otherwise fail the whole ensure on a
 * `URIError` raised while reading an unrelated row.
 */
export function daytonaSecretEnvName(workspaceId: string, secretName: string) {
  try {
    return decodeURIComponent(secretName.slice(workspaceSecretPrefix(workspaceId).length).replace(/_/g, "%"))
  } catch {
    return undefined
  }
}

/**
 * Every org secret this driver holds for the workspace, by name.
 *
 * This driver is their only writer and nothing on the SDK's `Sandbox` reports
 * what is mounted, so the prefix listing is the only inventory there is — of
 * what a reuse must reconcile against, and of what a destroy must withdraw.
 */
export async function listWorkspaceSecrets(secrets: DaytonaSecretServiceLike, workspaceId: string) {
  const prefix = workspaceSecretPrefix(workspaceId)
  const held = new Map<string, DaytonaSecretLike>()
  let cursor: string | undefined
  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    const result = await secrets.list({ name: prefix, limit: SECRET_LIST_PAGE_SIZE, ...(cursor ? { cursor } : {}) })
    for (const secret of result.items ?? []) {
      // `name` matches partially, so the page can carry another workspace's
      // secrets; the prefix test is the real filter.
      if (secret.name.startsWith(prefix)) held.set(secret.name, secret)
    }
    cursor = result.nextCursor ?? undefined
    if (!cursor) break
  }
  return held
}

/**
 * End a secret's authority, and optionally drop the row.
 *
 * The dead value and the empty host list are what actually end it: rotations
 * take effect for outbound substitution within seconds, while unmounting or
 * deleting a secret a live sandbox references has no such documented window.
 * `delete` is for a workspace that will never mount the row again.
 */
export async function withdrawSecret(
  secrets: DaytonaSecretServiceLike,
  secret: DaytonaSecretLike,
  options: { delete: boolean },
) {
  await secrets.update(secret.id, { value: REVOKED_SECRET_VALUE, hosts: [] })
  if (options.delete) await secrets.delete(secret.id)
}

