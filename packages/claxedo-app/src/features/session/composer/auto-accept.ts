import { createMemo, type Accessor } from "solid-js"
import type { usePermission } from "@/features/session/providers/permission"
import type { HarnessId } from "@/platform/identity/session-ref"
import {
  CLAXEDO_ALLOW_SAFE_ID,
  CLAXEDO_ASK_ALWAYS_ID,
  claxedoPermissionModes,
  type PermissionModeDelivery,
} from "@/features/session/permission/modes"
import type { PermissionModeApplied } from "@/features/session/permission/apply"

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
  /**
   * The harness for this scope. Absent means "no native policy to push" — the
   * switch then does exactly what it always did and answers prompts locally.
   */
  harness?: Accessor<HarnessId | undefined>
  /**
   * Performs the harness-native delivery. Injected so this factory stays testable
   * without an SDK client, and so surfaces that cannot deliver (a draft with no
   * session yet) simply omit it rather than passing a stub that silently no-ops.
   */
  deliver?: (input: { delivery: PermissionModeDelivery; sessionID: string }) => Promise<PermissionModeApplied>
  /**
   * Called when a delivery rejects. The local switch has already flipped by then,
   * so the caller MUST surface this: the user would otherwise believe the engine
   * had been told something it never received.
   */
  onDeliveryError?: (input: { error: unknown; enabling: boolean }) => void
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

  /**
   * Push the harness's own policy alongside the local switch, where the harness has
   * one. For opencode that means writing a session-scoped ruleset so the engine
   * STOPS ASKING, rather than Claxedo answering the same prompts forever — the
   * grant then survives Claxedo being closed, which local answering never does.
   *
   * Deliberately fire-and-forget with respect to the local flip: the switch stays
   * responsive and the local behaviour is correct on its own, so a slow or failing
   * write degrades to "Claxedo answers these" instead of a dead control. That is
   * only safe because the failure is REPORTED — see `onDeliveryError`.
   */
  const deliverNative = async (sessionID: string, enabling: boolean) => {
    const deliver = input.deliver
    const harness = input.harness?.()
    if (!deliver || !harness) return
    // Enabling grants; disabling must WITHDRAW those grants, which on opencode is
    // its own explicit ruleset rather than the absence of one — nothing deletes
    // rules, so "ask for everything" has to be written.
    //
    // The `opencode-session-ruleset` check is what skips every other harness:
    // elsewhere these options deliver `claxedo-auto-answer`, which sends nothing
    // and is already handled by the local switch this function rides alongside.
    const options = claxedoPermissionModes(harness)
    const wanted = enabling ? CLAXEDO_ALLOW_SAFE_ID : CLAXEDO_ASK_ALWAYS_ID
    const delivery = options.find((option) => option.id === wanted)?.delivery
    if (!delivery || delivery.kind !== "opencode-session-ruleset") return
    try {
      await deliver({ delivery, sessionID })
    } catch (error) {
      input.onDeliveryError?.({ error, enabling })
    }
  }

  const toggle = () => {
    const id = input.sessionId()
    const directory = input.directory()
    if (!id) {
      // A draft has no session to scope a ruleset to, so there is nothing to
      // deliver — the directory preference applies to sessions that do not exist
      // yet. Those pick the policy up when they are created and toggled.
      input.permission.toggleAutoAcceptDirectory(directory)
      return
    }
    // Read the intent BEFORE flipping, and from the STORE rather than the memo —
    // see `currentlyActive`. The new state is the negation of the current one.
    const enabling = !currentlyActive()
    input.permission.toggleAutoAccept(id, directory)
    void deliverNative(id, enabling)
  }

  return { active, toggle }
}
