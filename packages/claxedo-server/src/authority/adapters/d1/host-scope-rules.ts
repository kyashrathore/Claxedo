import { createRequireText } from "@claxedo/helpers"
import { normalizeHostPath } from "@claxedo/account-contract/host-path"
import { hostEnrollmentScope, type HostScopeDefinition } from "@claxedo/server-core/platform/auth/host-connect-contract"
import { D1HostAccessAuthorityError } from "./host-access-errors"

const MAX_SCOPE_ROOTS = 50
const MAX_SCOPE_ROOT_LENGTH = 1_024

const { requireText } = createRequireText((message) => new D1HostAccessAuthorityError("invalid_input", message))

/** The roots an owner grants, each the machine's own absolute path normalized by the host-path contract, deduplicated. */
export function requireScope(input: HostScopeDefinition): HostScopeDefinition {
  if (!input || typeof input !== "object" || !Array.isArray(input.allowed_roots)) {
    throw new D1HostAccessAuthorityError("invalid_input", "scope.allowed_roots must be a list of absolute paths")
  }
  if (input.allowed_roots.length > MAX_SCOPE_ROOTS) {
    throw new D1HostAccessAuthorityError("invalid_input", `scope.allowed_roots may name at most ${MAX_SCOPE_ROOTS} roots`)
  }
  const roots = input.allowed_roots.map((root) => {
    const normalized = normalizeHostPath(requireText(root, "scope.allowed_roots", MAX_SCOPE_ROOT_LENGTH))
    if (!normalized) throw new D1HostAccessAuthorityError("invalid_input", "scope.allowed_roots must be absolute paths")
    return normalized
  })
  return { allowed_roots: [...new Set(roots)] }
}

export function storedScope(json: string): HostScopeDefinition {
  const scope = hostEnrollmentScope(json, 0)
  if (!scope) throw new D1HostAccessAuthorityError("resource_conflict", "Stored invitation scope is malformed")
  return { allowed_roots: scope.allowed_roots }
}

/**
 * The assignments of a host whose directory is neither one of the given
 * roots nor under one, read inside the batch that deletes them; binds
 * host_id, owner_actor_id and the roots JSON, in that order. A row with no
 * directory is outside every root, as in `hostPathWithinRoots`. A POSIX root
 * compares byte for byte with `/` as the separator; a Windows root (anything
 * not starting with `/`) compares by `lower()` with `\`, and a volume root
 * (`C:\`) already ends in its separator. `.` and `..` segments the prefix
 * cannot see are what every writer normalizes away. SQLite's `lower()` folds
 * ASCII only, so a non-ASCII Windows folder name that differs from its root
 * only by case stays assigned here and is refused by the host's own check at
 * its next ack.
 */
export const assignmentsOutsideRootsSql = `
      select assignment.workspace_id from host_workspace_assignments assignment
      left join workspaces workspace on workspace.workspace_id = assignment.workspace_id
      where assignment.host_id = ? and assignment.owner_actor_id = ?
        and not exists (
          select 1 from json_each(?) root
          where case when substr(root.value, 1, 1) = '/'
            then workspace.remote_directory = root.value
              or (root.value = '/' and substr(workspace.remote_directory, 1, 1) = '/')
              or substr(workspace.remote_directory, 1, length(root.value) + 1) = root.value || '/'
            else lower(workspace.remote_directory) = lower(root.value)
              or (substr(root.value, -1) = '\\' and lower(substr(workspace.remote_directory, 1, length(root.value))) = lower(root.value))
              or lower(substr(workspace.remote_directory, 1, length(root.value) + 1)) = lower(root.value || '\\')
          end
        )`
