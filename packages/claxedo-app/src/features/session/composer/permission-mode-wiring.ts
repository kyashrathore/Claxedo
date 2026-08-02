import { createResource, createSignal } from "solid-js"
import { showToast } from "@opencode-ai/ui/toast"
import {
  fetchSessionPermissionModesByTransport,
  setSessionPermissionModeByTransport,
  type SessionClient,
} from "@/features/session/store/session-transport"
import type { AgentRuntimeDirectory } from "@/platform/runtime/agent/agent-runtime-client"
import {
  CLAXEDO_ALLOW_SAFE_ID,
  CLAXEDO_ASK_ALWAYS_ID,
  type HarnessModeReport,
  type PermissionSelection,
} from "@/features/session/permission/modes"
import type { SessionPermissionWriter } from "@/features/session/permission/apply"

/**
 * The I/O half of the composer's permission-mode picker: fetching what the
 * harness offers, writing a choice back, and reconciling the two.
 *
 * Split out of `composer.tsx` because that file is at the architecture guard's
 * 800-line hard cap, which cannot be allowlisted. The seam is a real one rather
 * than a size dodge — everything here is transport and reconciliation, while
 * `createComposerPermissionMode` next door is pure derivation over what this
 * returns and is tested without any of it.
 */
export function createComposerPermissionModeWiring(input: {
  sessionId: () => string | undefined
  directory: () => AgentRuntimeDirectory
  /**
   * The harness the composer currently targets. Part of the resource KEY, not
   * just context: switching harness must invalidate the previous answer, or the
   * picker keeps showing the old harness's modes until a slower fetch lands —
   * which reads as the switch not having worked.
   */
  harness: () => string | undefined
  /**
   * Why this harness cannot report, when it cannot.
   *
   * The draft list is a RECORDED table, not something the agent said — so it
   * answers just as confidently for a harness that failed to start as for one
   * that is running. That produced a picker offering "Codex (ACP) · Agent" one
   * line under "Codex could not start", which is worse than showing nothing:
   * the modes look like the agent's own report, and choosing one appears to set
   * a policy that can never be applied because there is no agent to apply it to.
   */
  harnessUnavailable?: () => string | undefined
  /**
   * Both halves of the session client, intersected because this module needs
   * both and they come from different declarations: the transport helpers accept
   * the read client, while the writer port needs `update` for the opencode
   * ruleset path. `sdk.client.session` satisfies both.
   */
  client: SessionClient & SessionPermissionWriter["session"]
  requestFailedTitle: () => string
}) {
  /**
   * Two-argument `createResource` on purpose: the one-argument form runs once
   * and then never re-runs when the session id arrives, which is the
   * kept-mounted-dialog trap this codebase has hit before. A draft becoming a
   * session must re-fetch, because the harness can only report its live state
   * once there is a session.
   */
  const [resource, { refetch }] = createResource(
    // Never disabled: a DRAFT still fetches, with an empty session id, so the
    // picker can show the harness's real modes before the first message rather
    // than a placeholder. That is the whole point — the opening turn is when the
    // choice matters most, and it was previously the one turn nobody could set.
    () => ({ sessionID: input.sessionId() ?? "", directory: input.directory(), harness: input.harness() }),
    async (source) =>
      (
        await fetchSessionPermissionModesByTransport({
          client: input.client,
          directory: source.directory,
          sessionID: source.sessionID,
          // Was in the KEY but not in the REQUEST. Invalidation worked, so a
          // harness switch refetched — and then asked the runtime a question
          // with no harness in it, which the directory-scoped route answers for
          // whatever harness the directory defaults to. The picker showed one
          // harness's name over another harness's modes.
          ...(source.harness ? { harness: source.harness } : {}),
        })
      ).data,
  )

  const answered = (unsupported: string): HarnessModeReport => ({
    modes: [],
    unsupported,
    appliesFrom: "next-turn",
  })

  /**
   * FOUR states, not two, and the two extra ones are the whole point.
   *
   * `undefined` from here means "in flight", and the picker renders that as
   * loading copy. So every state that is NOT in flight has to be turned into a
   * real answer, or it renders as a spinner that never resolves.
   *
   * A FAILED fetch leaves `latest` undefined, so without this branch a dead
   * backend is indistinguishable from a slow one and renders as a spinner that
   * never resolves — the same defect as the "Waiting for … to report its modes"
   * bug this whole feature replaced, one layer higher.
   *
   * (A draft used to land here too, for the same reason. It no longer does: it
   * fetches the directory-scoped list instead of not fetching at all.)
   *
   * `latest` is used for the success path so a refetch does not blank a
   * still-true answer.
   */
  /**
   * Cache keyed by harness, so switching back and forth is instant instead of
   * re-fetching a list that cannot have changed. Stale-while-revalidate: the
   * cached answer shows immediately and the live fetch replaces it.
   */
  const cache = new Map<string, HarnessModeReport>()

  const report = (): HarnessModeReport | undefined => {
    // Checked BEFORE the fetch result, because the fetch succeeds either way.
    // The directory-scoped route answers from the recorded table without ever
    // asking the agent, so a broken harness still returns a full, plausible
    // list — and a list is the one thing that must not be shown here.
    const unavailable = input.harnessUnavailable?.()
    if (unavailable) return answered(unavailable)
    if (resource.error) {
      const detail = resource.error instanceof Error ? resource.error.message : String(resource.error)
      return answered(`Could not load permission modes: ${detail}`)
    }
    const live = resource.state === "ready" ? resource() : undefined
    const key = input.harness() ?? ""
    if (live) {
      cache.set(key, live)
      return live
    }
    // In flight: show this harness's cached answer if we have one, and undefined
    // otherwise. Deliberately NOT `resource.latest` — that keeps the PREVIOUS
    // harness's list on screen across a switch, which is the stale-read the
    // harness key exists to prevent.
    return cache.get(key)
  }

  /**
   * Optimistic value covering the gap between choosing a harness mode and the
   * refetch that confirms it.
   *
   * Needed because the harness — not Claxedo — is the store for these modes, so
   * without it the row would visibly snap back to the old value until the fetch
   * returned. Cleared on BOTH outcomes: on success the refetch supersedes it, and
   * on failure it must go or the picker keeps asserting a mode the harness
   * refused.
   */
  const [pending, setPending] = createSignal<PermissionSelection | undefined>()

  const writer = (): SessionPermissionWriter => ({
    session: input.client,
    setPermissionMode: async (call) => {
      const result = await setSessionPermissionModeByTransport({
        client: input.client,
        directory: input.directory(),
        sessionID: call.sessionID,
        modeId: call.modeId,
      })
      void refetch()
      setPending(undefined)
      // The harness's answer, which can name a different mode than the request.
      return { currentModeId: result.data?.currentModeId }
    },
  })

  const reportError = (error: unknown) => {
    setPending(undefined)
    const detail = error instanceof Error ? error.message : String(error)
    showToast({
      variant: "error",
      title: input.requestFailedTitle(),
      // Says the change did NOT happen. Silence here would leave the user
      // believing a policy is in force that the harness never accepted.
      description: `The permission mode was not changed: ${detail}`,
    })
  }

  /**
   * Which mode the picker should show as chosen, and where that answer lives.
   *
   * TWO stores, split by who actually holds the state. Where the harness has its
   * own modes the HARNESS is the store — it reports `currentModeId`, and on a
   * resumed session that is the mode genuinely in force, which no local copy
   * could know. Returning undefined lets the picker derive it from the report;
   * `pending` only covers the in-flight gap.
   *
   * Where Claxedo owns the behaviour (opencode's ruleset, local answering), the
   * existing per-scope auto-accept preference stays the store, so a session's
   * saved choice carries over untouched.
   */
  const selection = (autoAcceptActive: boolean): PermissionSelection | undefined => {
    const current = report()
    // `Array.isArray` for the same reason as `harnessPermissionModes`: a 200
    // that is not a mode report would otherwise throw here during render.
    if (current && Array.isArray(current.modes) && current.modes.length > 0) return pending()
    return { kind: "claxedo", modeId: autoAcceptActive ? CLAXEDO_ALLOW_SAFE_ID : CLAXEDO_ASK_ALWAYS_ID }
  }

  /** Route a new choice to whichever store owns it. */
  const onSelectionChange = (next: PermissionSelection, autoAccept: { active(): boolean; toggle(): void }) => {
    if (next.kind === "harness") {
      setPending(next)
      return
    }
    const wantAllow = next.modeId === CLAXEDO_ALLOW_SAFE_ID
    // Selecting the option already in effect must not flip the switch to its
    // opposite.
    if (wantAllow === autoAccept.active()) return
    autoAccept.toggle()
  }

  return { report, pending, setPending, writer, reportError, selection, onSelectionChange,
    /** Re-exported so the picker's groups can suppress every option, not just the list. */
    harnessUnavailable: () => input.harnessUnavailable?.() }
}
