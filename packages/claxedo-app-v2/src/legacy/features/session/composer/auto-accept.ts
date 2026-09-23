import { createMemo, type Accessor } from "solid-js"
import type { usePermission } from "@/features/session/providers/permission"

/**
 * The read/write pair behind the composer's "Approve for me" switch.
 *
 * Both halves resolve the same scope: a draft with no session id reads and
 * writes the DIRECTORY-level auto-accept preference, an existing session reads
 * and writes its own. Keeping the two in one factory is what guarantees the
 * control can never read one scope and toggle another — they were previously
 * separate expressions in composer.tsx, one scope check apiece.
 */
export function createComposerAutoAccept(input: {
  permission: Pick<
    ReturnType<typeof usePermission>,
    "isAutoAccepting" | "isAutoAcceptingDirectory" | "toggleAutoAccept" | "toggleAutoAcceptDirectory"
  >
  sessionId: Accessor<string | undefined>
  directory: Accessor<string>
}) {
  /**
   * The raw predicate, read straight from the permission store.
   *
   * `active` below memoizes this for the UI, but the toggle must NOT read the memo
   * to work out which direction the user chose: a memo returns a CACHED value, so
   * whether it reflects the flip depends on when Solid's graph happens to flush.
   * That made the enable/disable direction depend on scheduling — it would deliver
   * the revocation when the user enabled, silently and only sometimes. Reading the
   * store directly is timing-independent.
   */
  const currentlyActive = () => {
    const id = input.sessionId()
    const directory = input.directory()
    if (!id) return input.permission.isAutoAcceptingDirectory(directory)
    return input.permission.isAutoAccepting(id, directory)
  }

  const active = createMemo(currentlyActive)

  const toggle = () => {
    const id = input.sessionId()
    const directory = input.directory()
    if (!id) {
      input.permission.toggleAutoAcceptDirectory(directory)
      return
    }
    input.permission.toggleAutoAccept(id, directory)
  }

  return { active, toggle, currentlyActive }
}
